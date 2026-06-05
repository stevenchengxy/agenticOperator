// External Dependency Health — per-call classifier (pure, AO-side).
//
// "什么叫退化" is defined here, ONCE, for both providers. Given either the error
// a call threw OR the 200 response it returned, decide whether the dependency
// behaved. Structured errors map straight to a DepReason; a 200 that came back
// with nothing usable is `empty` (the silent-degrade case). The 没钱/故障/说不准
// *judgment* is NOT here — that's windowed and lives in lib/monitor/dependency.ts.

import { RobohireApiError } from '../robohire-client';
import type { DepOutcome, DepReason } from './types';

function fail(provider: 'robohire' | 'llm', op: string, reason: DepReason, detail: string): DepOutcome {
  return { ok: false, provider, op, reason, detail };
}

// ── RoboHire ────────────────────────────────────────────────────────────────

function robohireReason(e: RobohireApiError): DepReason {
  switch (e.code) {
    case 'QUOTA_EXHAUSTED':
      return 'quota';
    case 'RATE_LIMITED':
      return 'rate_limit';
    case 'NETWORK':
      return 'network';
    case 'SERVER':
      return 'server';
    case 'CLIENT':
      // 401/403 = expired/revoked key (ambiguous: billing or misconfig); other
      // 4xx = bad input. Both land in `auth` → caller treats as non-retriable.
      return 'auth';
    default:
      return 'server';
  }
}

/** True when a 200 response body carries nothing the agent can use downstream. */
function isEmptyRobohirePayload(op: string, data: Record<string, unknown> | null | undefined): boolean {
  if (!data || typeof data !== 'object') return true;
  switch (op) {
    case 'parseResume':
      return !(
        data.name ||
        data.email ||
        data.phone ||
        data.summary ||
        (Array.isArray(data.experience) && data.experience.length > 0) ||
        (Array.isArray(data.education) && data.education.length > 0) ||
        (Array.isArray(data.skills) && data.skills.length > 0)
      );
    case 'matchResume':
      // score 0 is a valid match result — guard on the type, not truthiness.
      return typeof data.matchScore !== 'number';
    case 'generateJd':
      return !(data.title || data.description || data.qualifications || data.hardRequirements);
    case 'inviteCandidate':
      return !(data.login_url || data.qrcode_url || data.user_id != null || data.reused);
    default:
      return Object.keys(data).length === 0;
  }
}

/**
 * Classify one RoboHire call. Pass the thrown error (any) OR the parsed
 * `{ data }` response. Returns `{ ok: true }` when the call is healthy.
 */
export function classifyRobohire(op: string, errOrResponse: unknown): DepOutcome {
  if (errOrResponse instanceof RobohireApiError) {
    return fail('robohire', op, robohireReason(errOrResponse), errOrResponse.message);
  }
  if (errOrResponse instanceof Error) {
    // Unwrapped failure (shouldn't normally happen — the client wraps fetch
    // errors — but stay defensive). Treat as a transient network fault.
    return fail('robohire', op, 'network', errOrResponse.message);
  }
  const data = (errOrResponse as { data?: Record<string, unknown> } | null | undefined)?.data;
  if (isEmptyRobohirePayload(op, data)) {
    return fail('robohire', op, 'empty', `${op} 返回 200 但内容为空`);
  }
  return { ok: true };
}

// ── LLM gateway ───────────────────────────────────────────────────────────────

function llmReason(message: string): DepReason {
  const m = message.toLowerCase();
  if (/insufficient_quota|quota|billing|credit|payment|balance/.test(m)) return 'quota';
  if (/429|rate.?limit|too many requests/.test(m)) return 'rate_limit';
  if (/401|403|unauthorized|forbidden|invalid api key/.test(m)) return 'auth';
  if (/timeout|econn|network|fetch failed|socket|dns|enotfound|unreachable/.test(m)) return 'network';
  if (/5\d\d|server error|internal server|bad gateway|service unavailable/.test(m)) return 'server';
  return 'server';
}

/**
 * Classify one LLM call. Pass the thrown error OR the completion text. A blank
 * completion is `empty` (gateway answered but gave us nothing to decide on).
 */
export function classifyLlm(op: string, errOrText: unknown): DepOutcome {
  if (typeof errOrText === 'string') {
    if (errOrText.trim() === '') return fail('llm', op, 'empty', 'LLM 返回空文本');
    return { ok: true };
  }
  if (errOrText instanceof Error) {
    return fail('llm', op, llmReason(errOrText.message), errOrText.message);
  }
  return fail('llm', op, 'server', 'LLM 调用异常(未知)');
}
