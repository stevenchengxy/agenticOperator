// Ontology-API rule fetcher (2026-05-20 重写).
//
// 之前的 ontology-source.ts:
//   - 调 actionRef='matchResume'(错的 action 名)
//   - 失败 fallback 到 rules.json(rules.json 含 10-5 这种不该出现的规则)
//   - 没做 client name lookup
//   - 不记录 API 调用细节
//
// 现在:
//   1. GET /api/v1/ontology/actions/ruleCheckForMatchResume/rules?domain=RAAS-v1
//      → 已 server-side 预过滤 executor='Agent' + enforcementLevel='mandatory'
//   2. 给定 JR 的 client_id,通过 Ontology API 在 Neo4j 中查 :Client.client_name:
//        a) GET /api/v1/ontology/instances/Client/{client_id}      首选
//        b) POST /api/v1/ontology/cypher/query  MATCH (c:Client) WHERE c.client_id=$cid RETURN c.client_name
//        c) 都失败 → fall back 到 normalizeClientId 硬编码映射
//   3. 客户端再过滤一次:applicableClient ∈ {'通用', clientName}
//      + 防御性 re-check executor === 'Agent' + enforcementLevel === 'mandatory'
//   4. 每一次 Ontology API 调用都通过 logger.apiCall(...) 落到 logs/<agent>-*.log
//
// 不再有 JSON fallback —— API 失败直接抛错(failSafe in runner.ts)。

import type { AgentLogger } from '@/lib/agent-logger';
import type {
  MatchResumeStepGroup,
  Rule,
  RuleProvenance,
} from './types';

export type { RuleProvenance } from './types';
import { query as pgQuery, isPartnerPgConfigured } from '@/lib/partner-pg/client';
import { matchesDepartment, deriveBgFromDepartmentId, deriveBgFromOrgName } from './ontology';

const DEFAULT_TIMEOUT_MS = 8000;

export class RuleFetchApiError extends Error {
  constructor(
    message: string,
    public meta: { url?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'RuleFetchApiError';
  }
}

export type RuleFetchInput = {
  /** JR 上挂的 raw client_id(可能是 CLI_BYTEDANCE_001 等 ID,也可能空)。 */
  clientId: string | null | undefined;
  /** JR 上挂的 client_department_id(可能是 UUID,也可能是 CLI_*_IEG_* 编码)。 */
  departmentId?: string | null;
  /** JR 上显式的 client_business_group(若 partner 填了),最权威。 */
  businessGroup?: string | null;
  /** JR 上的 sd_org_name(如"腾讯互娱事业部"),department_id 是 UUID 时靠它兜底。 */
  orgName?: string | null;
  /** agent 串过来的 logger,所有 API 调用走它落盘。 */
  logger: AgentLogger;
};

/**
 * 一条 API rule 是否通过 client + department 过滤。
 *
 * 这是 rule 摘取的核心断言 —— 2026-05-26 修:之前只比 applicableClient,
 * 导致 CDG 专属规则(10-42)被摘进腾讯 IEG 岗位,LLM 再误判 fail。现在
 * client 维度 + department 维度(复用 ontology.matchesDepartment)都要过。
 *
 * @param clientName 已解析的客户中文名(如"腾讯");null 表示 unresolved。
 * @param bg         已解析的事业群 token(如"IEG"/"CDG");null 表示 unresolved
 *                   → 部门专属规则一律 fail-closed 排除(宁可漏判不可错拦)。
 */
export function ruleSurvivesFilter(
  r: Record<string, unknown>,
  clientName: string | null,
  bg: string | null,
): boolean {
  if (r.executor !== 'Agent') return false;
  if (r.enforcementLevel !== 'mandatory') return false;
  const ac = typeof r.applicableClient === 'string' ? r.applicableClient : '';
  const clientOk = ac === '通用' || (!!clientName && ac === clientName);
  if (!clientOk) return false;
  const dept = typeof r.applicableDepartment === 'string' ? r.applicableDepartment : '';
  return matchesDepartment(dept, bg);
}

function isClientWideDept(dept: string): boolean {
  const d = dept.trim();
  return d === '' || d === 'N/A' || d === '通用';
}

/** 规则属于哪一层:通用(CSI) / 客户级 / 客户部门级。 */
export function classifyTier(r: Record<string, unknown>): RuleProvenance['tier'] {
  const ac = typeof r.applicableClient === 'string' ? r.applicableClient : '';
  if (ac === '通用') return 'general';
  const dept = typeof r.applicableDepartment === 'string' ? r.applicableDepartment : '';
  return isClientWideDept(dept) ? 'client' : 'department';
}

/**
 * 一条 API rule 的三层归属 + 纳入/排除证据。
 * 回答"为什么抓/没抓这条规则" —— 日志 + audit UI 用。
 */
export function ruleProvenance(
  r: Record<string, unknown>,
  clientName: string | null,
  bg: string | null,
): RuleProvenance {
  const rule_id = typeof r.id === 'string' ? r.id : '';
  const tier = classifyTier(r);
  const ac = typeof r.applicableClient === 'string' ? r.applicableClient : '';
  const dept = typeof r.applicableDepartment === 'string' ? r.applicableDepartment : '';

  if (r.executor !== 'Agent' || r.enforcementLevel !== 'mandatory') {
    return {
      rule_id,
      tier,
      included: false,
      reason: `排除：executor=${String(r.executor)} / enforcement=${String(r.enforcementLevel)},非 Agent+mandatory`,
    };
  }

  const clientOk = ac === '通用' || (!!clientName && ac === clientName);
  if (!clientOk) {
    return {
      rule_id,
      tier,
      included: false,
      reason: `排除：规则客户=${ac} ≠ 岗位客户=${clientName ?? '(未解析)'}`,
    };
  }

  if (tier === 'general') {
    return { rule_id, tier, included: true, reason: '通用规则(CSI),无条件纳入' };
  }
  if (tier === 'client') {
    return { rule_id, tier, included: true, reason: `客户=${clientName} 命中,部门无限定,纳入` };
  }
  // department tier
  if (matchesDepartment(dept, bg)) {
    return { rule_id, tier, included: true, reason: `部门=${dept} 命中岗位 bg=${bg},纳入` };
  }
  if (!bg) {
    return {
      rule_id,
      tier,
      included: false,
      reason: `排除：岗位 bg 未解析,部门专属规则(${dept})fail-closed`,
    };
  }
  return {
    rule_id,
    tier,
    included: false,
    reason: `排除：规则部门=${dept} ≠ 岗位 bg=${bg}`,
  };
}

export type RuleFetchResult = {
  /** 过完三重过滤的 rules,可直接注入 user prompt。 */
  rules: Rule[];
  /** 每条 API rule 的三层归属 + 纳入/排除证据(含被排除的)。 */
  provenance: RuleProvenance[];
  /** 按 ActionStep 分组的视图,prompt 用。 */
  steps: MatchResumeStepGroup[];
  /** Action 顶层 user_prompt(由 ontology 维护,UI/审计可显示)。 */
  action_user_prompt?: string;
  /** Action 顶层 system_prompt。 */
  action_system_prompt?: string;
  /** 解析到的 client name(来自 Neo4j 或 normalize 兜底);null 表示完全 unresolved。 */
  client_name_resolved: string | null;
  /** 解析到的事业群 token(IEG/CDG/...);null = unresolved(部门专属规则 fail-closed 排除)。 */
  business_group_resolved: string | null;
  /** 客户端过滤前的 API rule 总数 — 审计用。 */
  api_rule_count: number;
  /** 客户端过滤后剩余规则数。 */
  filtered_rule_count: number;
  source: 'ontology-api';
};

// ──────────────────────────────────────────────────────────────────────
// HTTP helper — fetch + log + parse JSON
// ──────────────────────────────────────────────────────────────────────

interface HttpCall {
  label: string;
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  apiToken: string;
  timeoutMs?: number;
  logger: AgentLogger;
  /** 期望 status — 不在范围内不抛,记录 + 返回 null. */
  allow404?: boolean;
}

async function httpJson(call: HttpCall): Promise<{ ok: boolean; status: number; data: unknown }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(call.url, {
      method: call.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${call.apiToken}`,
        Accept: 'application/json',
        ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    call.logger.apiCall(call.label, {
      url: call.url,
      method: call.method ?? 'GET',
      request: call.body,
      durationMs: Date.now() - start,
      error: msg,
    });
    throw new RuleFetchApiError(`network error: ${msg}`, { url: call.url, cause: err });
  }
  clearTimeout(timer);

  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText.length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      call.logger.apiCall(call.label, {
        url: call.url,
        method: call.method ?? 'GET',
        request: call.body,
        status: response.status,
        durationMs: Date.now() - start,
        error: 'non-json response',
        response: rawText.slice(0, 500),
      });
      throw new RuleFetchApiError('non-json response', {
        url: call.url,
        status: response.status,
      });
    }
  }

  call.logger.apiCall(call.label, {
    url: call.url,
    method: call.method ?? 'GET',
    request: call.body,
    status: response.status,
    durationMs: Date.now() - start,
    response: parsed,
  });

  if (response.ok) {
    return { ok: true, status: response.status, data: parsed };
  }
  if (response.status === 404 && call.allow404) {
    return { ok: false, status: 404, data: parsed };
  }

  const env = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const msg = (env?.message as string) ?? `HTTP ${response.status}`;
  throw new RuleFetchApiError(msg, { url: call.url, status: response.status });
}

// ──────────────────────────────────────────────────────────────────────
// Client name resolver — Neo4j 优先 / normalize 兜底
// ──────────────────────────────────────────────────────────────────────

/** 仅作兜底:Ontology Neo4j 还没建 :Client 节点时硬编码 ID→名映射. */
function normalizeClientIdToName(id: string): string | null {
  if (!id) return null;
  const upper = id.toUpperCase();
  if (upper.includes('TENCENT')) return '腾讯';
  if (upper.includes('BYTEDANCE') || upper.includes('BYTE')) return '字节';
  // 其他客户 — 等 Neo4j 有 :Client 节点后自然 hit
  return null;
}

async function resolveClientName(
  clientId: string | null | undefined,
  apiBase: string,
  apiToken: string,
  domain: string,
  logger: AgentLogger,
): Promise<{ name: string | null; source: 'neo4j-instance' | 'neo4j-cypher' | 'partner-pg' | 'normalized' | 'unresolved' }> {
  if (!clientId || !clientId.trim()) {
    return { name: null, source: 'unresolved' };
  }

  const trimmedId = clientId.trim();

  // a) GET /instances/Client/{id}
  try {
    const r = await httpJson({
      label: 'lookup-client.get-instance',
      url: `${apiBase}/api/v1/ontology/instances/Client/${encodeURIComponent(trimmedId)}?domain=${encodeURIComponent(domain)}`,
      apiToken,
      logger,
      allow404: true,
    });
    if (r.ok && r.data && typeof r.data === 'object') {
      const d = r.data as Record<string, unknown>;
      const name =
        (typeof d.client_name === 'string' && d.client_name.trim()) ||
        (typeof d.name === 'string' && d.name.trim()) ||
        null;
      if (name) return { name, source: 'neo4j-instance' };
    }
  } catch (e) {
    // 落到 cypher 兜底
    logger.event('client-name.get-instance-failed', {
      client_id: trimmedId,
      error: (e as Error).message,
    });
  }

  // b) POST /cypher/query
  try {
    const cypher = `MATCH (c:Client) WHERE (c.client_id = $cid OR c.id = $cid) AND c.domainId = $domainId RETURN coalesce(c.client_name, c.name) AS name LIMIT 1`;
    const r = await httpJson({
      label: 'lookup-client.cypher',
      url: `${apiBase}/api/v1/ontology/cypher/query`,
      method: 'POST',
      body: {
        domainId: domain,
        cypher,
        params: { cid: trimmedId },
        limit: 1,
        purpose: 'rule-check: resolve client_id to client_name',
      },
      apiToken,
      logger,
    });
    if (r.ok && r.data && typeof r.data === 'object') {
      const records = (r.data as Record<string, unknown>).records as unknown;
      if (Array.isArray(records) && records[0] && typeof records[0] === 'object') {
        const name = (records[0] as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim()) {
          return { name: name.trim(), source: 'neo4j-cypher' };
        }
      }
    }
  } catch (e) {
    logger.event('client-name.cypher-failed', {
      client_id: trimmedId,
      error: (e as Error).message,
    });
  }

  // c) partner Postgres fallback — Neo4j may not have :Client instances
  //    populated yet but partner-pg `client.client_name` is the source of
  //    truth today. Logged as an apiCall so log/<agent>-*.log shows the
  //    Postgres lookup the same way ontology HTTP calls are shown.
  if (isPartnerPgConfigured()) {
    const t0 = Date.now();
    try {
      const r = await pgQuery<{ client_name: string }>(
        'SELECT client_name FROM client WHERE client_id = $1 LIMIT 1',
        [trimmedId],
      );
      const row = r.rows[0];
      logger.apiCall('lookup-client.partner-pg', {
        url: 'partner-pg://client.client_name',
        method: 'GET',
        request: { client_id: trimmedId },
        status: row ? 200 : 404,
        durationMs: Date.now() - t0,
        response: row ?? null,
      });
      if (row && typeof row.client_name === 'string' && row.client_name.trim()) {
        return { name: row.client_name.trim(), source: 'partner-pg' };
      }
    } catch (e) {
      logger.apiCall('lookup-client.partner-pg', {
        url: 'partner-pg://client.client_name',
        method: 'GET',
        request: { client_id: trimmedId },
        durationMs: Date.now() - t0,
        error: (e as Error).message,
      });
    }
  }

  // d) hardcoded normalize fallback (last resort)
  const normalized = normalizeClientIdToName(trimmedId);
  if (normalized) {
    logger.event('client-name.normalized-fallback', {
      client_id: trimmedId,
      name: normalized,
    });
    return { name: normalized, source: 'normalized' };
  }

  logger.event('client-name.unresolved', { client_id: trimmedId });
  return { name: null, source: 'unresolved' };
}

// ──────────────────────────────────────────────────────────────────────
// Department → business-group resolver — 图查优先 / 字符串兜底
// (用户 2026-05-26 指定:先图查 Client_Department,再回退 JR 字段字符串)
// ──────────────────────────────────────────────────────────────────────

const KNOWN_BG = new Set(['IEG', 'PCG', 'WXG', 'CDG', 'CSIG', 'TEG', 'TikTok']);

/** 把图/字段里拿到的值归一成 BG token:已经是 token 直接用,否则按中文名解析。 */
function coerceBg(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const v = raw.trim();
  if (KNOWN_BG.has(v)) return v;
  const upper = v.toUpperCase();
  if (KNOWN_BG.has(upper)) return upper;
  return deriveBgFromOrgName(v);
}

async function resolveDepartmentBg(
  input: RuleFetchInput,
  apiBase: string,
  apiToken: string,
  domain: string,
  logger: AgentLogger,
): Promise<{ bg: string | null; source: string }> {
  const deptId = input.departmentId?.trim() || '';

  // a) 图查:GET /instances/Client_Department/{id} — 拿 business_group / 部门名
  if (deptId) {
    try {
      const r = await httpJson({
        label: 'lookup-department.get-instance',
        url: `${apiBase}/api/v1/ontology/instances/Client_Department/${encodeURIComponent(deptId)}?domain=${encodeURIComponent(domain)}`,
        apiToken,
        logger,
        allow404: true,
      });
      if (r.ok && r.data && typeof r.data === 'object') {
        const d = r.data as Record<string, unknown>;
        const bg =
          coerceBg(d.business_group) ??
          coerceBg(d.client_business_group) ??
          coerceBg(d.bg) ??
          coerceBg(d.department_name) ??
          coerceBg(d.name);
        if (bg) return { bg, source: 'neo4j-instance' };
      }
    } catch (e) {
      logger.event('department-bg.get-instance-failed', {
        department_id: deptId,
        error: (e as Error).message,
      });
    }
  }

  // b) 回退字符串:显式 client_business_group → department_id 编码 → sd_org_name
  const explicit = coerceBg(input.businessGroup);
  if (explicit) return { bg: explicit, source: 'jr-business-group' };

  const fromDeptId = deriveBgFromDepartmentId(deptId || null);
  if (fromDeptId) return { bg: fromDeptId, source: 'department-id-encoding' };

  const fromOrgName = deriveBgFromOrgName(input.orgName);
  if (fromOrgName) return { bg: fromOrgName, source: 'sd-org-name' };

  return { bg: null, source: 'unresolved' };
}

// ──────────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────────

export async function fetchRulesViaOntologyApi(input: RuleFetchInput): Promise<RuleFetchResult> {
  const apiBase = (process.env.ALLMETA_BASE_URL ?? '').replace(/\/+$/, '');
  const apiToken = process.env.ALLMETA_API_KEY ?? '';
  const domain = process.env.ALLMETA_DOMAIN ?? 'RAAS-v1';

  if (!apiBase) {
    throw new RuleFetchApiError('ALLMETA_BASE_URL env not configured');
  }
  if (!apiToken) {
    throw new RuleFetchApiError('ALLMETA_API_KEY env not configured');
  }

  // 1) 解析 client name + department business-group
  const clientResolution = await resolveClientName(input.clientId, apiBase, apiToken, domain, input.logger);
  input.logger.event('rule-fetch.client-resolution', {
    raw_client_id: input.clientId ?? null,
    resolved_name: clientResolution.name,
    source: clientResolution.source,
  });
  const deptResolution = await resolveDepartmentBg(input, apiBase, apiToken, domain, input.logger);
  input.logger.event('rule-fetch.department-resolution', {
    raw_department_id: input.departmentId ?? null,
    sd_org_name: input.orgName ?? null,
    resolved_bg: deptResolution.bg,
    source: deptResolution.source,
  });

  // 2) GET action with rules
  const actionUrl = `${apiBase}/api/v1/ontology/actions/${encodeURIComponent('ruleCheckForMatchResume')}/rules?domain=${encodeURIComponent(domain)}`;
  const actionResp = await httpJson({
    label: 'fetch-action-rules',
    url: actionUrl,
    apiToken,
    logger: input.logger,
  });
  if (!actionResp.ok || !actionResp.data || typeof actionResp.data !== 'object') {
    throw new RuleFetchApiError('action response not an object', { url: actionUrl });
  }
  const action = actionResp.data as Record<string, unknown>;

  // 3) 取 actionSteps + 顶层 rules(11 条 flat list,API 已预过滤)
  const stepsRaw = (action.action_steps ?? action.actionSteps) as unknown;
  const flatRules = Array.isArray(action.rules) ? (action.rules as Array<Record<string, unknown>>) : [];

  // 4) 客户端再过滤一次(防御性 + client + department filter)
  const clientName = clientResolution.name;
  const bg = deptResolution.bg;

  // 5) build Rule[] from API rule shape + 记录每条的三层归属/纳入证据
  const apiRuleById = new Map<string, Rule>();
  const filteredIds = new Set<string>();
  const provenance: RuleProvenance[] = [];
  for (const r of flatRules) {
    if (typeof r.id !== 'string') continue;
    const prov = ruleProvenance(r, clientName, bg);
    provenance.push(prov);
    if (!prov.included) continue;
    apiRuleById.set(r.id, toRule(r));
    filteredIds.add(r.id);
  }

  // 6) 按 step 分组(只保留 filtered 通过的 rule)
  const stepGroups: MatchResumeStepGroup[] = [];
  if (Array.isArray(stepsRaw)) {
    for (const s of stepsRaw as Array<Record<string, unknown>>) {
      const stepRulesRaw = Array.isArray(s.rules) ? (s.rules as Array<Record<string, unknown>>) : [];
      const rules: Rule[] = [];
      for (const r of stepRulesRaw) {
        const id = typeof r.id === 'string' ? r.id : '';
        if (!id) continue;
        const matched = apiRuleById.get(id);
        if (matched) rules.push(matched);
      }
      if (rules.length === 0) continue;
      stepGroups.push({
        step_id: (typeof s.id === 'string' ? s.id : (typeof s.name === 'string' ? s.name : 'unknown')),
        order: Number(s.order ?? 0) || 0,
        name: typeof s.name === 'string' ? s.name : '',
        description: typeof s.description === 'string' ? s.description : '',
        condition: typeof s.condition === 'string' ? s.condition : '',
        rules,
      });
    }
  }
  stepGroups.sort((a, b) => a.order - b.order);

  const result: RuleFetchResult = {
    rules: Array.from(apiRuleById.values()),
    steps: stepGroups,
    action_user_prompt: typeof action.user_prompt === 'string' ? (action.user_prompt as string) : undefined,
    action_system_prompt: typeof action.system_prompt === 'string' ? (action.system_prompt as string) : undefined,
    client_name_resolved: clientName,
    business_group_resolved: bg,
    provenance,
    api_rule_count: flatRules.length,
    filtered_rule_count: filteredIds.size,
    source: 'ontology-api',
  };

  input.logger.event('rule-fetch.result', {
    api_rule_count: result.api_rule_count,
    filtered_rule_count: result.filtered_rule_count,
    client_name_resolved: result.client_name_resolved,
    business_group_resolved: result.business_group_resolved,
    provenance,
    filtered_rule_ids: Array.from(filteredIds),
    steps: stepGroups.map((s) => ({ step_id: s.step_id, rule_count: s.rules.length, rule_ids: s.rules.map((r) => r.id) })),
  });

  return result;
}

// API rule → internal Rule shape
function toRule(r: Record<string, unknown>): Rule {
  const s = (k: string, d = ''): string => (typeof r[k] === 'string' ? (r[k] as string) : d);
  const arr = (k: string): string[] => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x) => typeof x === 'string') as string[] : []);
  const ac = s('applicableClient', '通用') as '通用' | string;
  const enforcement = s('enforcementLevel') as 'mandatory' | 'optional' | '';
  const failure = s('failurePolicy') as 'block' | 'warn' | '';
  const sev =
    enforcement === 'mandatory' && failure === 'block'
      ? 'terminal'
      : enforcement === 'optional' && failure === 'warn'
        ? 'flag_only'
        : 'needs_human';
  return {
    id: s('id'),
    specificScenarioStage: s('specificScenarioStage'),
    businessLogicRuleName: s('businessLogicRuleName'),
    applicableClient: ac,
    applicableDepartment: s('applicableDepartment', 'N/A'),
    submissionCriteria: s('submissionCriteria'),
    standardizedLogicRule: s('standardizedLogicRule'),
    relatedEntities: arr('relatedEntities'),
    businessBackgroundReason: s('businessBackgroundReason'),
    ruleSource: s('ruleSource'),
    executor: s('executor') === 'Human' ? 'Human' : 'Agent',
    enforcementLevel: enforcement === 'optional' ? 'optional' : 'mandatory',
    failurePolicy: failure === 'warn' ? 'warn' : 'block',
    severity: sev,
  };
}
