// Deterministic notification derivation — the algorithmic backbone of the
// 消息通知 center. Every captured signal (errors, infra failures, business
// lifecycle events) is classified here into a message or an alert WITHOUT any
// LLM call. This is load-bearing: the LLM gateway is itself a top alert source,
// so the capture→classify→notify path must never depend on the LLM. The AI
// layer (server/notifications/summarize.ts) only enriches drafts afterward, and
// falls back to this when the gateway is down.

export type NotificationKind = 'message' | 'alert';
export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type NotificationCategory = 'system' | 'agent' | 'event' | 'candidate' | 'job';
export type LinkKind = 'run' | 'trace' | 'rule_check' | 'event' | 'none';
export type Disposition = 'needs_human' | 'auto_handled' | 'info_only';

export interface CaptureInput {
  /** Log level of the source signal. */
  level: 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'critical';
  /** Log category: agent_lifecycle | event_publish | manage_action | tool_call
   *  | db_call | api_call | llm_call | system | agent_error | ... */
  category: string;
  /** Business-facing source label: agent short name | 'LLM 网关' | 'EM' | 'RAAS API' | ... */
  source?: string;
  agent?: string;
  runId?: string | null;
  traceId?: string | null;
  eventInstanceId?: string | null;
  eventName?: string | null;
  message: string;
  anchors?: Record<string, string | null | undefined>;
  /** rule-check audit id, when this signal came from a rule-check run. */
  auditId?: string | null;
  /** Structured dedupe key (e.g. 'llm_gateway_401'). Drives severity + grouping. */
  dedupeHint?: string | null;
  /** Set when a Manager-axis agent already auto-handled this (auto_restart/throttle/scale). */
  managerAction?: string | null;
  /** Business domain (Allmeta id) this signal belongs to. Null = system/cross-domain. */
  domain?: string | null;
}

export interface NotificationDraft {
  kind: NotificationKind;
  severity: NotificationSeverity;
  category: NotificationCategory;
  source: string;
  title: string;
  body: string;
  dedupeKey: string | null;
  disposition: Disposition;
  shouldNotify: boolean;
  linkKind: LinkKind;
  linkId: string | null;
  runId: string | null;
  traceId: string | null;
  eventInstanceId: string | null;
  agent: string | null;
  anchorsJson: string | null;
  managerAction: string | null;
  domain: string | null;
}

export interface DeriveOptions {
  /** 'fallback' = AI manager unavailable → only critical alerts notify. */
  mode?: 'normal' | 'fallback';
}

const INFRA_SOURCES = new Set([
  'LLM 网关', 'EM', 'RAAS API', 'system', '系统', 'Allmeta', 'Partner-PG', '基础设施',
]);
const INFRA_CATEGORIES = new Set(['system', 'llm_call', 'api_call', 'db_call']);
const MESSAGE_CATEGORIES = new Set([
  'agent_lifecycle',
  'event_publish',
  'manage_action',
  'system_lifecycle', // backend start / clean restart — surfaces as an info message
]);

/** dedupeHints whose blast radius is broad enough to be critical regardless of level. */
function isBroadImpact(hint?: string | null): boolean {
  if (!hint) return false;
  return (
    hint.startsWith('llm_gateway') ||
    hint === 'em_degraded' ||
    hint.startsWith('run_stalled') ||
    hint.startsWith('rule_check_parked')
  );
}

export function severityOf(input: CaptureInput): NotificationSeverity {
  if (input.level === 'critical') return 'critical';
  if (input.level === 'error' || input.level === 'warn') {
    return isBroadImpact(input.dedupeHint) ? 'critical' : 'warning';
  }
  return 'info';
}

export function categoryOf(input: CaptureInput): NotificationCategory {
  if (
    input.category === 'system' ||
    INFRA_CATEGORIES.has(input.category) ||
    (input.source != null && INFRA_SOURCES.has(input.source))
  ) {
    return 'system';
  }
  if (input.category === 'event_publish' || input.eventName) return 'event';
  const a = input.anchors ?? {};
  if (a.candidate_id) return 'candidate';
  if (a.job_requisition_id) return 'job';
  return 'agent';
}

export function resolveLink(input: CaptureInput): { linkKind: LinkKind; linkId: string | null } {
  if (input.auditId) return { linkKind: 'rule_check', linkId: input.auditId };
  if (input.runId) return { linkKind: 'run', linkId: input.runId };
  if (input.traceId) return { linkKind: 'trace', linkId: input.traceId };
  if (input.eventInstanceId) return { linkKind: 'event', linkId: input.eventInstanceId };
  return { linkKind: 'none', linkId: null };
}

export function isMessageWorthy(input: CaptureInput): boolean {
  if (input.level === 'debug') return false;
  return MESSAGE_CATEGORIES.has(input.category);
}

// djb2 — small deterministic string hash for auto dedupe keys (not crypto).
function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function dedupeKeyOf(input: CaptureInput): string {
  if (input.dedupeHint) return input.dedupeHint;
  return `auto:${simpleHash(`${input.category}|${input.source ?? ''}|${input.message.slice(0, 80)}`)}`;
}

function cleanAnchors(anchors?: Record<string, string | null | undefined>): string | null {
  if (!anchors) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(anchors)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

function headline(message: string): string {
  const first = message.split('\n')[0].trim();
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/**
 * Classify a captured signal into a notification draft, or null when it is not
 * worth surfacing (plumbing: tool/db/api/debug — it still lives in the audit log).
 * Pure + deterministic. The AI layer enriches alert drafts afterward.
 */
export function deriveNotification(
  input: CaptureInput,
  opts: DeriveOptions = {},
): NotificationDraft | null {
  const isAlert = input.level === 'error' || input.level === 'critical' || input.level === 'warn';
  if (!isAlert && !isMessageWorthy(input)) return null;

  const severity = severityOf(input);
  const category = categoryOf(input);
  const { linkKind, linkId } = resolveLink(input);
  const anchorsJson = cleanAnchors(input.anchors);
  const common = {
    category,
    source: input.source ?? '系统',
    title: headline(input.message),
    body: input.message,
    linkKind,
    linkId,
    runId: input.runId ?? null,
    traceId: input.traceId ?? null,
    eventInstanceId: input.eventInstanceId ?? null,
    agent: input.agent ?? null,
    anchorsJson,
    managerAction: input.managerAction ?? null,
    // System messages are domain-agnostic (always shown); everything else is
    // tagged with its business domain so the view can scope by it.
    domain: category === 'system' ? null : (input.domain ?? null),
  };

  if (isAlert) {
    const mode = opts.mode ?? 'normal';
    const disposition: Disposition = input.managerAction
      ? 'auto_handled'
      : severity === 'critical'
        ? 'needs_human'
        : 'info_only';
    // Deterministic notify policy:
    //   critical → always notify (even in fallback);
    //   warning  → notify in normal mode, suppressed in fallback (only-important);
    //   info     → never (handled by the message branch anyway).
    const shouldNotify =
      severity === 'critical' ? true : mode === 'fallback' ? false : severity === 'warning';
    return {
      kind: 'alert',
      severity,
      dedupeKey: dedupeKeyOf(input),
      disposition,
      shouldNotify,
      ...common,
    };
  }

  return {
    kind: 'message',
    severity: 'info',
    dedupeKey: null,
    disposition: 'info_only',
    shouldNotify: false,
    ...common,
  };
}
