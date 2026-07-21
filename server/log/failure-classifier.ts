// Structured failure attribution for persisted logs.
//
// LogEvent.payloadJson is intentionally flexible because it mirrors many
// sources: agent JSONL, AgentActivity metadata, external API mirrors, and
// partner execution audits. This module turns those heterogeneous shapes into
// one stable `failure` object for UI/API consumers.

export type FailureComponent =
  | 'llm'
  | 'robohire'
  | 'allmeta'
  | 'partner-pg'
  | 'database'
  | 'ontology'
  | 'workflow'
  | 'agent'
  | 'input'
  | 'event'
  | 'system'
  | 'unknown';

export type FailureReason =
  | 'quota'
  | 'rate_limit'
  | 'auth'
  | 'network'
  | 'server'
  | 'timeout'
  | 'empty'
  | 'parse_error'
  | 'tool_loop'
  | 'not_found'
  | 'validation'
  | 'db_unavailable'
  | 'cancelled'
  | 'business'
  | 'unknown';

export interface FailureInfo {
  component: FailureComponent;
  reason: FailureReason;
  retryable: boolean;
  summary: string;
  detail: string | null;
  code?: string | null;
  status?: number | null;
  provider?: string | null;
  op?: string | null;
}

export interface ClassifyFailureInput {
  type?: string | null;
  level?: string | null;
  category?: string | null;
  source?: string | null;
  agent?: string | null;
  eventName?: string | null;
  message?: string | null;
  payload?: unknown;
  payloadJson?: string | null;
  status?: number | null;
}

const ERROR_TYPES = new Set(['agent_error', 'step.failed', 'dependency_degraded']);
const WARN_FAILURE_CATEGORIES = new Set(['dependency', 'anomaly']);
const INFRA_FAIL_REASONS = new Set([
  'llm-call-error',
  'gateway-unavailable',
  'ontology-graph-unavailable',
  'tool-use-loop-exceeded',
  'parse-error',
]);

export function classifyFailure(input: ClassifyFailureInput): FailureInfo | null {
  const payload = payloadObject(input.payload, input.payloadJson);
  const existing = normalizeExistingFailure(payload?.failure);
  if (existing) return existing;

  const type = input.type ?? '';
  const level = (input.level ?? '').toLowerCase();
  const category = (input.category ?? '').toLowerCase();
  const source = input.source ?? null;
  const message = compact(firstString(input.message, textFromPayload(payload)) ?? '');
  const code = firstString(
    pathString(payload, ['error', 'code']),
    pathString(payload, ['errorCode']),
    pathString(payload, ['code']),
  );
  const status = firstNumber(
    input.status,
    pathNumber(payload, ['status']),
    pathNumber(payload, ['error', 'status']),
    pathNumber(payload, ['response', 'status']),
  );
  const failReason = firstString(
    pathString(payload, ['fail_reason']),
    pathString(payload, ['failure_reason']),
    pathString(payload, ['audit', 'fail_reason']),
    pathString(payload, ['error', 'fail_reason']),
  );
  const depReason = firstString(
    pathString(payload, ['reason']),
    pathString(payload, ['error', 'reason']),
  );

  const hasFailureMarker =
    ERROR_TYPES.has(type) ||
    level === 'error' ||
    level === 'critical' ||
    (level === 'warn' && WARN_FAILURE_CATEGORIES.has(category)) ||
    category === 'api' && status != null && status >= 400 ||
    Boolean(failReason && INFRA_FAIL_REASONS.has(failReason)) ||
    Boolean(code && code !== 'OK') ||
    Boolean(pathString(payload, ['error'])) ||
    /\b(error|failed|failure|timeout|parse-error|unavailable|degraded)\b/i.test(message);

  if (!hasFailureMarker) return null;

  const component = inferComponent({ source, category, message, payload, code, failReason });
  const reason = inferReason({ component, status, code, failReason, depReason, message });
  const retryable = inferRetryable(payload, reason);
  const provider = firstString(pathString(payload, ['provider']), source);
  const op = firstString(pathString(payload, ['op']), input.eventName);
  const detail = compact(
    firstString(
      pathString(payload, ['detail']),
      pathString(payload, ['llm_error_detail']),
      pathString(payload, ['error', 'message']),
      pathString(payload, ['error']),
      pathString(payload, ['response', 'error']),
      pathString(payload, ['response', 'message']),
      message,
    ) ?? '',
    1200,
  );

  return {
    component,
    reason,
    retryable,
    summary: buildSummary({ component, reason, retryable, status, code, detail }),
    detail: detail || null,
    code: code ?? null,
    status: status ?? null,
    provider: provider ?? null,
    op: op ?? null,
  };
}

export function classifyLogFailure(row: {
  level?: string | null;
  category?: string | null;
  source?: string | null;
  agent?: string | null;
  eventName?: string | null;
  message?: string | null;
  payloadJson?: string | null;
}): FailureInfo | null {
  return classifyFailure(row);
}

export function enrichPayloadJsonWithFailure(
  payloadJson: string | null | undefined,
  failure: FailureInfo,
  maxChars = 4000,
): string {
  const parsed = payloadObject(undefined, payloadJson);
  const payload =
    parsed && typeof parsed === 'object'
      ? { ...parsed, failure }
      : { rawPayloadPreview: payloadJson ? payloadJson.slice(0, 1600) : null, failure };
  return stringifyForLog(payload, maxChars) ?? JSON.stringify({ failure });
}

export function stringifyPayloadForLog(
  payload: unknown,
  failure?: FailureInfo | null,
  maxChars = 4000,
): string | null {
  if (payload === undefined) {
    return failure ? stringifyForLog({ failure }, maxChars) : null;
  }
  const obj: Record<string, unknown> =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : { value: payload };
  if (failure) obj.failure = failure;
  return stringifyForLog(obj, maxChars);
}

export function messageWithFailureSummary(message: string, type: string, failure: FailureInfo | null): string {
  if (!failure) return message;
  const trimmed = message.trim();
  const looksLikeTag = trimmed === type || /^[a-z0-9_.:-]+$/i.test(trimmed);
  if (!looksLikeTag || trimmed.includes(failure.summary)) return message;
  return `${trimmed}: ${failure.summary}`;
}

function normalizeExistingFailure(value: unknown): FailureInfo | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const component = typeof o.component === 'string' ? o.component : null;
  const reason = typeof o.reason === 'string' ? o.reason : null;
  const summary = typeof o.summary === 'string' ? o.summary : null;
  if (!component || !reason || !summary) return null;
  return {
    component: component as FailureComponent,
    reason: reason as FailureReason,
    retryable: typeof o.retryable === 'boolean' ? o.retryable : inferRetryable(null, reason as FailureReason),
    summary,
    detail: typeof o.detail === 'string' ? o.detail : null,
    code: typeof o.code === 'string' ? o.code : null,
    status: typeof o.status === 'number' ? o.status : null,
    provider: typeof o.provider === 'string' ? o.provider : null,
    op: typeof o.op === 'string' ? o.op : null,
  };
}

function payloadObject(payload: unknown, payloadJson?: string | null): Record<string, unknown> | null {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function pathValue(obj: Record<string, unknown> | null, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function pathString(obj: Record<string, unknown> | null, path: string[]): string | undefined {
  const value = pathValue(obj, path);
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Error) return value.message;
  return undefined;
}

function pathNumber(obj: Record<string, unknown> | null, path: string[]): number | undefined {
  const value = pathValue(obj, path);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textFromPayload(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  return firstString(
    pathString(payload, ['message']),
    pathString(payload, ['error', 'message']),
    pathString(payload, ['error']),
    pathString(payload, ['detail']),
    pathString(payload, ['llm_error_detail']),
    pathString(payload, ['fail_reason']),
    pathString(payload, ['reason']),
  );
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(...values: Array<unknown>): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function inferComponent(input: {
  source: string | null;
  category: string;
  message: string;
  payload: Record<string, unknown> | null;
  code?: string;
  failReason?: string;
}): FailureComponent {
  const hay = `${input.source ?? ''} ${input.category} ${input.message} ${input.code ?? ''} ${input.failReason ?? ''}`.toLowerCase();
  const provider = firstString(pathString(input.payload, ['provider']), pathString(input.payload, ['category']))?.toLowerCase();
  if (/input_invalid|input_ref_not_found|schema|validation|bad request/.test(hay)) return 'input';
  if (provider === 'robohire' || /robohire|raas api/.test(hay)) return 'robohire';
  if (provider === 'allmeta' || /allmeta|neo4j/.test(hay)) return 'allmeta';
  if (provider === 'partner-pg' || /partner-pg|postgres|pg\.|database/.test(hay)) return 'partner-pg';
  if (input.failReason === 'parse-error' || input.failReason === 'llm-call-error' || input.failReason === 'gateway-unavailable') {
    return 'llm';
  }
  if (provider === 'llm' || /\b(llm|model|kimi|openai|gateway)\b|模型|ai 模型/.test(hay)) return 'llm';
  if (/p1001|p1002|db_unavailable|can't reach database|database/.test(hay)) return 'database';
  if (/ontology|graph|本体|规则库/.test(hay)) return 'ontology';
  if (/event|em_/.test(hay)) return 'event';
  if (/workflow|run|step/.test(hay)) return 'workflow';
  if (input.source === 'system') return 'system';
  return 'agent';
}

function inferReason(input: {
  component: FailureComponent;
  status?: number;
  code?: string;
  failReason?: string;
  depReason?: string;
  message: string;
}): FailureReason {
  const code = (input.code ?? '').toLowerCase();
  const failReason = (input.failReason ?? '').toLowerCase();
  const depReason = (input.depReason ?? '').toLowerCase();
  const m = `${input.message} ${code} ${failReason} ${depReason}`.toLowerCase();

  if (depReason === 'quota' || /insufficient_quota|quota|billing|credit|payment|balance|余额|额度|充值/.test(m)) return 'quota';
  if (depReason === 'rate_limit' || /429|rate.?limit|too many requests|限流/.test(m)) return 'rate_limit';
  if (depReason === 'auth' || /401|403|unauthorized|forbidden|invalid api key|apikey|密钥|无权限/.test(m)) return 'auth';
  if (failReason === 'parse-error' || /parse-error|json.*parse|无法解析|invalid json|not-json|count-mismatch/.test(m)) return 'parse_error';
  if (failReason === 'tool-use-loop-exceeded' || /tool.*loop|loop exceeded|步数限制/.test(m)) return 'tool_loop';
  if (/not_found|not found|missing ref|不存在|找不到/.test(m)) return 'not_found';
  if (failReason === 'ontology-graph-unavailable' || /graph unavailable|neo4j.*unavailable|ontology.*unavailable|规则库.*不可用/.test(m)) return 'network';
  if (/timeout|timed out|execution_timeout|超时/.test(m)) return 'timeout';
  if (depReason === 'network' || /econn|network|fetch failed|socket|dns|enotfound|unreachable|连接/.test(m)) return 'network';
  if (depReason === 'empty' || /empty|空文本|内容为空|blank/.test(m)) return 'empty';
  if (/input_invalid|schema|validation|bad request|invalid input|参数/.test(m)) return 'validation';
  if (/cancelled|canceled|aborted|取消/.test(m)) return 'cancelled';
  if (/p1001|p1002|can't reach database|database server|db_unavailable/.test(m)) return 'db_unavailable';
  if (input.status === 429) return 'rate_limit';
  if (input.status === 401 || input.status === 403) return 'auth';
  if (input.status === 408) return 'timeout';
  if (input.status != null && input.status >= 500) return 'server';
  if (input.status != null && input.status >= 400) return 'validation';
  if (/business|rule violation|rejected|未通过/.test(m)) return 'business';
  if (depReason === 'server' || /5\d\d|server error|internal server|bad gateway|service unavailable/.test(m)) return 'server';
  return 'unknown';
}

function inferRetryable(payload: Record<string, unknown> | null, reason: FailureReason): boolean {
  const explicit = pathValue(payload, ['error', 'retryable']);
  if (typeof explicit === 'boolean') return explicit;
  const rootExplicit = pathValue(payload, ['retryable']);
  if (typeof rootExplicit === 'boolean') return rootExplicit;
  return reason === 'quota' ||
    reason === 'rate_limit' ||
    reason === 'network' ||
    reason === 'server' ||
    reason === 'timeout' ||
    reason === 'parse_error' ||
    reason === 'db_unavailable';
}

function buildSummary(input: {
  component: FailureComponent;
  reason: FailureReason;
  retryable: boolean;
  status?: number;
  code?: string;
  detail?: string;
}): string {
  const componentLabel: Record<FailureComponent, string> = {
    llm: 'LLM',
    robohire: 'RoboHire',
    allmeta: 'Allmeta/Neo4j',
    'partner-pg': 'Partner PG',
    database: '数据库',
    ontology: '本体/规则库',
    workflow: '工作流',
    agent: '智能体',
    input: '输入',
    event: '事件系统',
    system: '系统',
    unknown: '未知组件',
  };
  const reasonLabel: Record<FailureReason, string> = {
    quota: '额度/余额不足',
    rate_limit: '限流',
    auth: '鉴权/密钥失败',
    network: '网络或连接失败',
    server: '上游服务异常',
    timeout: '超时',
    empty: '返回为空',
    parse_error: '结果解析失败',
    tool_loop: '工具调用循环超限',
    not_found: '引用对象不存在',
    validation: '输入或协议校验失败',
    db_unavailable: '数据库不可达',
    cancelled: '运行被取消',
    business: '业务规则失败',
    unknown: '未知错误',
  };
  const suffix = input.retryable ? '可重试' : '需人工处理';
  const code = input.code ? ` ${input.code}` : input.status ? ` HTTP ${input.status}` : '';
  return `${componentLabel[input.component]}${code}: ${reasonLabel[input.reason]} (${suffix})`;
}

function compact(text: string, max = 1000): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}...`;
}

function stringifyForLog(payload: Record<string, unknown>, maxChars: number): string | null {
  try {
    const full = JSON.stringify(payload);
    if (full.length <= maxChars) return full;
  } catch {
    return payload.failure
      ? JSON.stringify({ failure: payload.failure, unserializable: true })
      : null;
  }

  const failure = payload.failure;
  const compactPayload = {
    failure,
    payloadTruncated: true,
    message: typeof payload.message === 'string' ? payload.message.slice(0, 500) : undefined,
    error: typeof payload.error === 'string' ? payload.error.slice(0, 500) : undefined,
    status: payload.status,
    url: payload.url,
    method: payload.method,
  };
  const text = JSON.stringify(compactPayload);
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}
