// lib/candidate-lock/classify.ts
//
// RMHR error classifier — distinguishes 故障 (infra faults) from 业务 rejects
// (e.g. unresolvable recruiter email). Pure function; no IO, no Inngest.
//
// The caller is responsible for wiring reportDependencyDegraded — this module
// only classifies. DepProvider 'rmhr' is not yet in dependency-health types so
// we do NOT call reportDependencyDegraded here.

import { RmhrApiError } from './rmhr-client';
import type { DepReason } from '../dependency-health/types';

// ─── Public type ────────────────────────────────────────────────────────────

/**
 * RmhrClassification — what one RMHR call outcome means.
 *
 *   ok: true          — call succeeded (snapshot parsed cleanly).
 *   reason: 'email-unresolvable'
 *                     — 业务拒绝: the recruiter email does not exist in RMHR's
 *                       system (data problem). Non-retryable; no point re-uploading.
 *   reason: 'infra-fault'
 *                     — 故障/网络/配置: the call failed for a technical reason.
 *                       recoverable=true  → park and retry (transient).
 *                       recoverable=false → non-retryable (bad creds / bad input).
 *
 * depReason is present when there is a 1-to-1 mapping to dependency-health
 * DepReason so the controller can record a dependency signal without re-parsing.
 */
export type RmhrClassification =
  | { ok: true }
  | { ok: false; reason: 'infra-fault'; recoverable: boolean; depReason?: DepReason }
  | { ok: false; reason: 'email-unresolvable'; recoverable: false };

// ─── Code → DepReason map ───────────────────────────────────────────────────

function recoverableDepReason(
  code: 'NETWORK' | 'SERVER' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED',
): DepReason {
  switch (code) {
    case 'NETWORK':        return 'network';
    case 'SERVER':         return 'server';
    case 'RATE_LIMITED':   return 'rate_limit';
    case 'QUOTA_EXHAUSTED': return 'quota';
  }
}

// ─── Classifier ─────────────────────────────────────────────────────────────

/**
 * classifyRmhr — classify any error thrown by uploadByRecruiterEmail (or
 * returned from parseRmhrResponse).
 *
 * Principle: every non-ok outcome is STILL a failure — this function only
 * classifies; it never swallows. The caller decides what to do (park, fail, record).
 *
 * Decision table:
 *   RmhrApiError BUSINESS, msg includes '邮箱' → email-unresolvable, non-retryable
 *   RmhrApiError BUSINESS, other msg           → infra-fault, non-retryable
 *     (unusual data-reject that doesn't fit 邮箱 pattern — treat conservatively)
 *   RmhrApiError NETWORK / SERVER / RATE_LIMITED / QUOTA_EXHAUSTED
 *                                              → infra-fault, recoverable, depReason mapped
 *   RmhrApiError CLIENT (4xx non-business/auth) → infra-fault, non-retryable
 *   any other Error / unknown                  → infra-fault, recoverable
 *     (unknown = defensive: assume transient so we don't silently drop resumes)
 */
export function classifyRmhr(err: unknown): RmhrClassification {
  if (err instanceof RmhrApiError) {
    switch (err.code) {
      case 'BUSINESS': {
        // 业务拒绝 — NOT an infra fault but still a failure.
        // 邮箱不存在/解析失败 is the canonical BUSINESS case.
        if (err.message.includes('邮箱')) {
          return { ok: false, reason: 'email-unresolvable', recoverable: false };
        }
        // Other BUSINESS rejects (unexpected data patterns) — classify as
        // infra-fault (conservative) so the caller logs a dependency signal.
        return { ok: false, reason: 'infra-fault', recoverable: false };
      }

      case 'NETWORK':
      case 'SERVER':
      case 'RATE_LIMITED':
      case 'QUOTA_EXHAUSTED': {
        return {
          ok: false,
          reason: 'infra-fault',
          recoverable: true,
          depReason: recoverableDepReason(err.code),
        };
      }

      case 'CLIENT': {
        // 4xx non-business (bad creds / auth / malformed request).
        // Retrying won't help — non-retryable.
        return { ok: false, reason: 'infra-fault', recoverable: false };
      }

      default: {
        // Exhaustive fallback — should not happen given the typed union.
        return { ok: false, reason: 'infra-fault', recoverable: false };
      }
    }
  }

  // Non-RmhrApiError (plain Error, string, null, etc.) — unknown origin.
  // Treat as recoverable transient fault so we don't silently drop resumes.
  return { ok: false, reason: 'infra-fault', recoverable: true };
}
