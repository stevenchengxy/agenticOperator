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
} from './types';
import { query as pgQuery, isPartnerPgConfigured } from '@/lib/partner-pg/client';

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
  /** agent 串过来的 logger,所有 API 调用走它落盘。 */
  logger: AgentLogger;
};

export type RuleFetchResult = {
  /** 过完三重过滤的 rules,可直接注入 user prompt。 */
  rules: Rule[];
  /** 按 ActionStep 分组的视图,prompt 用。 */
  steps: MatchResumeStepGroup[];
  /** Action 顶层 user_prompt(由 ontology 维护,UI/审计可显示)。 */
  action_user_prompt?: string;
  /** Action 顶层 system_prompt。 */
  action_system_prompt?: string;
  /** 解析到的 client name(来自 Neo4j 或 normalize 兜底);null 表示完全 unresolved。 */
  client_name_resolved: string | null;
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
// Main entry
// ──────────────────────────────────────────────────────────────────────

export async function fetchRulesViaOntologyApi(input: RuleFetchInput): Promise<RuleFetchResult> {
  const apiBase = (process.env.ONTOLOGY_API_BASE ?? '').replace(/\/+$/, '');
  const apiToken = process.env.ONTOLOGY_API_TOKEN ?? '';
  const domain = process.env.ONTOLOGY_API_DOMAIN ?? 'RAAS-v1';

  if (!apiBase) {
    throw new RuleFetchApiError('ONTOLOGY_API_BASE env not configured');
  }
  if (!apiToken) {
    throw new RuleFetchApiError('ONTOLOGY_API_TOKEN env not configured');
  }

  // 1) 解析 client name
  const clientResolution = await resolveClientName(input.clientId, apiBase, apiToken, domain, input.logger);
  input.logger.event('rule-fetch.client-resolution', {
    raw_client_id: input.clientId ?? null,
    resolved_name: clientResolution.name,
    source: clientResolution.source,
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

  // 4) 客户端再过滤一次(防御性 + 加 client filter)
  const clientName = clientResolution.name;
  const passFilter = (r: Record<string, unknown>): boolean => {
    if (r.executor !== 'Agent') return false;
    if (r.enforcementLevel !== 'mandatory') return false;
    const ac = typeof r.applicableClient === 'string' ? r.applicableClient : '';
    if (ac === '通用') return true;
    if (clientName && ac === clientName) return true;
    return false;
  };

  // 5) build Rule[] from API rule shape
  const apiRuleById = new Map<string, Rule>();
  const filteredIds = new Set<string>();
  for (const r of flatRules) {
    if (typeof r.id !== 'string') continue;
    if (!passFilter(r)) continue;
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
    api_rule_count: flatRules.length,
    filtered_rule_count: filteredIds.size,
    source: 'ontology-api',
  };

  input.logger.event('rule-fetch.result', {
    api_rule_count: result.api_rule_count,
    filtered_rule_count: result.filtered_rule_count,
    client_name_resolved: result.client_name_resolved,
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
