// Allmeta Ontology API client — AO 写 Neo4j 实例的统一入口
//
// 替换原来 `lib/rule-check/neo4j-instance-writer.ts` 和
// `lib/rule-check/neo4j-match-result-writer.ts` 里的 Bolt 直连。所有写入都经
// Allmeta API(`http://localhost:3500/api/v1/ontology/...`),让 Neo4j 写入
// 走 ontology schema 校验 + domainId 分区。
//
// 设计原则:
//   - **永远不抛**(Inngest step 不能因 Allmeta 不可达整体失败)
//     失败返回 { ok: false, reason: '...' }
//   - **schema-aware**:写入前把 caller 传的 props 限制在 DataObject 声明的
//     字段上(避免 strict-validation 400 错误)
//   - **idempotent**:upsert by primary_key + domainId
//   - **batchable**:批量写多条同 label 时用 bulk endpoint
//
// 配置:
//   ONTOLOGY_API_BASE   = http://localhost:3500
//   ONTOLOGY_API_TOKEN  = dev-ao-allmeta-2026
//   ONTOLOGY_API_DOMAIN = RAAS-v1

const DEFAULT_BASE = 'http://localhost:3500';
const DEFAULT_DOMAIN = 'RAAS-v1';
const DEFAULT_TIMEOUT_MS = 8_000;

export type AllmetaResult<T = unknown> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; reason: string; details?: unknown };

interface ClientConfig {
  apiBase: string;
  apiToken: string;
  domain: string;
  timeoutMs: number;
}

function getConfig(): ClientConfig | null {
  const apiBase = process.env.ONTOLOGY_API_BASE ?? DEFAULT_BASE;
  const apiToken = process.env.ONTOLOGY_API_TOKEN;
  const domain = process.env.ONTOLOGY_API_DOMAIN ?? DEFAULT_DOMAIN;
  if (!apiToken) return null;
  return {
    apiBase: apiBase.replace(/\/+$/, ''),
    apiToken,
    domain,
    timeoutMs: Number(process.env.ONTOLOGY_API_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };
}

async function doRequest<T = unknown>(
  method: string,
  path: string,
  cfg: ClientConfig,
  body?: unknown,
): Promise<AllmetaResult<T>> {
  const url = `${cfg.apiBase}${path}`;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    };
    const init: RequestInit = { method, headers, signal: ac.signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON — keep as string
    }
    if (!res.ok) {
      const errObj = parsed as { error?: string; message?: string; details?: unknown };
      return {
        ok: false,
        status: res.status,
        reason: errObj?.error ?? `http_${res.status}`,
        details: errObj?.message ?? errObj?.details ?? text.slice(0, 300),
      };
    }
    return { ok: true, data: parsed as T, status: res.status };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      reason: 'network',
      details: (e as Error).message.slice(0, 200),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Schema cache(写之前 strict 校验白名单)──────────────────────────

interface SchemaInfo {
  primary_key: string;
  allowed_fields: Set<string>;
  fetched_at: number;
}

const __schemaCache = new Map<string, SchemaInfo>();
const SCHEMA_TTL_MS = 60_000;

async function loadSchema(label: string, cfg: ClientConfig): Promise<SchemaInfo | null> {
  const cached = __schemaCache.get(label);
  if (cached && Date.now() - cached.fetched_at < SCHEMA_TTL_MS) return cached;
  const r = await doRequest<{
    id: string;
    primary_key: string;
    properties_json: string | unknown[];
  }>('GET', `/api/v1/ontology/objects/${encodeURIComponent(label)}?domain=${encodeURIComponent(cfg.domain)}`, cfg);
  if (!r.ok) return null;
  const props = typeof r.data.properties_json === 'string'
    ? JSON.parse(r.data.properties_json)
    : r.data.properties_json;
  if (!Array.isArray(props)) return null;
  const allowed = new Set<string>(['domainId']);
  for (const p of props) {
    const name = (p as { name?: string })?.name;
    if (typeof name === 'string') allowed.add(name);
  }
  const info: SchemaInfo = {
    primary_key: r.data.primary_key,
    allowed_fields: allowed,
    fetched_at: Date.now(),
  };
  __schemaCache.set(label, info);
  return info;
}

/**
 * 把 caller 传的 props 投影到 schema 声明的字段上,过滤掉未声明字段。
 * 返回:
 *   - kept:能写的字段
 *   - dropped:不在 schema 里、被丢弃的字段(对外报告,不阻塞)
 *   - pk_value:从 props 抠出来的主键值
 */
function projectToSchema(
  props: Record<string, unknown>,
  schema: SchemaInfo,
): { kept: Record<string, unknown>; dropped: string[]; pk_value: string | null } {
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (schema.allowed_fields.has(k)) kept[k] = v;
    else dropped.push(k);
  }
  const pk = props[schema.primary_key];
  return {
    kept,
    dropped,
    pk_value: typeof pk === 'string' ? pk : null,
  };
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Upsert 一条实例。
 *
 * 行为:
 *   - schema 拉取一次缓存 60s
 *   - 自动按 schema 投影,丢弃未声明字段(返回 dropped 列表)
 *   - 自动塞 domainId
 *   - 调 POST /api/v1/ontology/instances/{label}?domain=RAAS-v1(MERGE 语义)
 *   - **(★ workaround)** Allmeta strict 校验当前有 bug:properties_json 里
 *     声明的字段也会被拒。捕到 `validation-failed` 时,自动降级到 PK + domainId
 *     的最小写,**保证节点至少能纳入 ontology 管理(有 domainId)**。富 props
 *     由 caller 用 Bolt 直连补 SET(或等 Allmeta 修 strict)。
 *
 * 失败模式:
 *   - 配置缺 / token 缺 → { ok: false, reason: 'not_configured' }
 *   - schema 拿不到(label 不存在 / domain 不对)→ { ok: false, reason: 'schema_not_found' }
 *   - HTTP 4xx(非 validation)→ 透传 status + reason
 *   - 网络错 → { ok: false, status: 0, reason: 'network' }
 */
export async function writeInstance(
  label: string,
  props: Record<string, unknown>,
): Promise<AllmetaResult<{ upserted: string[]; count: number; dropped: string[]; degraded_to_minimum?: boolean }>> {
  const cfg = getConfig();
  if (!cfg) return { ok: false, status: 0, reason: 'not_configured' };

  const schema = await loadSchema(label, cfg);
  if (!schema) return { ok: false, status: 0, reason: 'schema_not_found', details: label };

  const { kept, dropped, pk_value } = projectToSchema(props, schema);
  if (!pk_value) {
    return {
      ok: false,
      status: 0,
      reason: 'missing_pk',
      details: `props 里缺 ${schema.primary_key}`,
    };
  }

  const url = `/api/v1/ontology/instances/${encodeURIComponent(label)}?domain=${encodeURIComponent(cfg.domain)}`;
  const fullBody: Record<string, unknown> = { domainId: cfg.domain, ...kept };
  const r = await doRequest<{ upserted: string[]; count: number }>('POST', url, cfg, fullBody);
  if (r.ok) {
    return {
      ok: true,
      status: r.status,
      data: { upserted: r.data.upserted, count: r.data.count, dropped },
    };
  }

  // ★ Workaround:Allmeta strict 校验拒 properties_json 声明字段(已知 bug)
  // 降级到 PK-only 写,保证节点至少存在 + 有 domainId(可被 ontology API 检索)
  if (r.status === 400 && r.reason === 'validation-failed') {
    const minBody: Record<string, unknown> = {
      domainId: cfg.domain,
      [schema.primary_key]: pk_value,
    };
    const r2 = await doRequest<{ upserted: string[]; count: number }>('POST', url, cfg, minBody);
    if (r2.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[allmeta-client] strict validation rejected full props for ${label}/${pk_value}, ` +
          `degraded to PK-only. Rich props should be set via Bolt fallback. ` +
          `Rejected: ${JSON.stringify(r.details)}`,
      );
      return {
        ok: true,
        status: r2.status,
        data: {
          upserted: r2.data.upserted,
          count: r2.data.count,
          dropped: Object.keys(kept).filter((k) => k !== schema.primary_key),
          degraded_to_minimum: true,
        },
      };
    }
  }

  return r;
}

/**
 * 读一条实例(by PK)。
 * 用例:RuleCheckAudit drawer 显示 Candidate / Resume / JR 实例数据。
 */
export async function getInstance<T = Record<string, unknown>>(
  label: string,
  pk_value: string,
): Promise<AllmetaResult<T>> {
  const cfg = getConfig();
  if (!cfg) return { ok: false, status: 0, reason: 'not_configured' };
  return doRequest<T>(
    'GET',
    `/api/v1/ontology/instances/${encodeURIComponent(label)}/${encodeURIComponent(pk_value)}?domain=${encodeURIComponent(cfg.domain)}`,
    cfg,
  );
}

/**
 * PATCH 实例(部分更新,不替换其他字段)。
 */
export async function patchInstance(
  label: string,
  pk_value: string,
  props: Record<string, unknown>,
): Promise<AllmetaResult<unknown>> {
  const cfg = getConfig();
  if (!cfg) return { ok: false, status: 0, reason: 'not_configured' };
  const schema = await loadSchema(label, cfg);
  if (!schema) return { ok: false, status: 0, reason: 'schema_not_found' };
  const { kept } = projectToSchema(props, schema);
  const body = { domainId: cfg.domain, ...kept };
  return doRequest(
    'PATCH',
    `/api/v1/ontology/instances/${encodeURIComponent(label)}/${encodeURIComponent(pk_value)}?domain=${encodeURIComponent(cfg.domain)}`,
    cfg,
    body,
  );
}

/**
 * 列实例(可按 filter)。
 */
export async function listInstances<T = Record<string, unknown>>(
  label: string,
  filters: Record<string, string> = {},
  limit = 50,
): Promise<AllmetaResult<{ items: T[]; nextCursor: string | null }>> {
  const cfg = getConfig();
  if (!cfg) return { ok: false, status: 0, reason: 'not_configured' };
  const params = new URLSearchParams({ domain: cfg.domain, limit: String(limit) });
  for (const [k, v] of Object.entries(filters)) params.set(k, v);
  return doRequest(
    'GET',
    `/api/v1/ontology/instances/${encodeURIComponent(label)}?${params.toString()}`,
    cfg,
  );
}

/**
 * 建实例间关系。
 *
 * 注意:Allmeta API 的 endpoints 节点要先存在(否则 409 endpoint-not-found)。
 * 推荐先 writeInstance 两边节点,再 writeLink。
 */
export async function writeLink(
  type: string,
  fromId: string,
  toId: string,
  extraProps: Record<string, unknown> = {},
): Promise<AllmetaResult<{ linkId: string }>> {
  const cfg = getConfig();
  if (!cfg) return { ok: false, status: 0, reason: 'not_configured' };
  const body = { domainId: cfg.domain, type, fromId, toId, ...extraProps };
  return doRequest('POST', '/api/v1/ontology/links', cfg, body);
}

/**
 * 写 Candidate_Match_Result(走特化端点)。
 *
 * 跟 writeInstance(Candidate_Match_Result, ...) 不同:这个端点会自动:
 *   - MERGE Candidate / Job_Requisition stub 节点(如不存在)
 *   - 自动建关系:
 *     (Candidate_Match_Result)-[:candidate_match_result_refers_to_candidate]->(Candidate)
 *     (Candidate_Match_Result)-[:candidate_match_result_refers_to_job_requisition]->(Job_Requisition)
 *   - 每次都新建一条 history 记录(不 MERGE Match_Result 本身)
 *
 * 这是历史数据语义(每次 audit 一条 row)。如果想 upsert,要用 writeInstance + 自定 PK。
 *
 * 写完返回的 candidateMatchResultId 是 UUID,后续要用 patchInstance 补 rule-check 维度字段。
 */
export async function writeMatchResult(input: {
  candidate_id: string;
  job_requisition_id: string;
  result: '匹配' | '不匹配' | '待定';
  reason: string;
}): Promise<AllmetaResult<{ candidateMatchResultId: string; createdAt: string }>> {
  const cfg = getConfig();
  if (!cfg) return { ok: false, status: 0, reason: 'not_configured' };
  // 特化端点的字段名是 camelCase(API 文档 §4)
  const body = {
    candidateId: input.candidate_id,
    jobPositionId: input.job_requisition_id, // ★ 端点用 jobPositionId,不是 job_requisition_id
    result: input.result,
    reason: input.reason,
  };
  return doRequest(
    'POST',
    '/api/v1/ontology/actions/matchResume/results',
    cfg,
    body,
  );
}

/**
 * 健康检查 — 用 schema endpoint 验证 Allmeta 是否可用。
 */
export async function isAllmetaReachable(): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg) return false;
  const r = await doRequest(
    'GET',
    `/api/v1/ontology/schema?domain=${encodeURIComponent(cfg.domain)}`,
    cfg,
  );
  return r.ok;
}

/**
 * 给前端 UI 用 — 生成可验证的 Cypher 查询(给用户粘贴到 Neo4j Browser)。
 *
 * 这不调 API,纯客户端构造字符串。
 */
export function buildVerifyCypher(label: string, pk_field: string, pk_value: string): string {
  // 转义单引号
  const safePk = pk_value.replace(/'/g, "\\'");
  const safeLabel = label.replace(/[^A-Za-z_]/g, '');
  const safeField = pk_field.replace(/[^A-Za-z_]/g, '');
  return `MATCH (n:${safeLabel} {${safeField}: '${safePk}', domainId: 'RAAS-v1'})
OPTIONAL MATCH (n)-[r]-(other)
RETURN n, r, other`;
}

/**
 * 给前端 UI 用 — 取 Allmeta 配置(给 UI 显示 / 跳转用)。
 */
export function getAllmetaPublicConfig(): { base: string; domain: string } {
  return {
    base: process.env.ONTOLOGY_API_BASE ?? DEFAULT_BASE,
    domain: process.env.ONTOLOGY_API_DOMAIN ?? DEFAULT_DOMAIN,
  };
}
