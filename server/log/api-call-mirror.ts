// External API call → LogEvent mirror.
//
// logApiCall (lib/external-api-log.ts) writes every RoboHire / Allmeta /
// partner-pg / RMHR call to logs/<category>-YYYY-MM-DD.log. Files are durable
// but unqueryable — the 审计日志全可查 requirement and the /analytics per-agent
// call charts need these rows in Postgres. This module mirrors each entry into
// LogEvent on its own lane:
//
//   category = 'api'            ← the lane stats read (distinct from the ALS
//                                  'tool' lane written by logger.apiCall, so a
//                                  call dual-logged by both paths never double
//                                  counts in 'api'-lane aggregations)
//   source   = provider          ('robohire' | 'allmeta' | 'partner-pg' | 'rmhr')
//   eventName= operation label   ('RoboHire.parseResume', 'pg.INSERT candidate')
//   agent / runId / traceId      attribution from the entry (caller-resolved)
//
// Full request/response bodies are persisted in Postgres as well as the local
// JSONL compatibility sink, so audit history survives a host replacement.
// Fire-and-forget —
// a mirror failure must never break the business call it observes.

import { prisma } from '@/server/db';
import type { ApiLogEntry } from '@/lib/external-api-log';
import { classifyFailure, messageWithFailureSummary, stringifyPayloadForLog } from './failure-classifier';

export interface ApiCallLogEventRow {
  level: string;
  category: string;
  source: string;
  agent: string | null;
  runId: string | null;
  traceId: string | null;
  eventName: string | null;
  message: string;
  payloadJson: string | null;
  durationMs: number | null;
}

/** Pure mapping ApiLogEntry → LogEvent row shape. */
export function apiLogToLogEvent(entry: ApiLogEntry): ApiCallLogEventRow {
  const failed = !!entry.error || (entry.status != null && entry.status >= 400);
  const statusPart = entry.error ? `ERROR ${entry.error}` : `${entry.status ?? '-'}`;
  const baseMessage =
    `${entry.label}${entry.method ? ` ${entry.method}` : ''}${entry.url ? ` ${entry.url}` : ''} → ${statusPart}`.slice(
      0,
      2000,
    );
  const payload = {
    url: entry.url,
    method: entry.method,
    status: entry.status,
    error: entry.error,
    request: entry.request,
    response: entry.response,
    meta: entry.meta,
  };
  const failure = classifyFailure({
    type: failed ? 'agent_error' : 'tool',
    level: failed ? 'error' : 'info',
    category: 'api',
    source: entry.category,
    agent: entry.agent ?? null,
    eventName: entry.label,
    message: baseMessage,
    payload,
    status: entry.status ?? null,
  });
  const payloadJson = stringifyPayloadForLog(payload, failure, Number.MAX_SAFE_INTEGER);
  const message = messageWithFailureSummary(baseMessage, failed ? 'agent_error' : 'tool', failure).slice(0, 2000);
  return {
    level: failed ? 'error' : 'info',
    category: 'api',
    source: entry.category,
    agent: entry.agent ?? null,
    runId: entry.run_id ?? null,
    traceId: entry.trace_id ?? null,
    eventName: entry.label.slice(0, 200),
    message,
    payloadJson,
    durationMs: entry.duration_ms ?? null,
  };
}

/** Fire-and-forget mirror into LogEvent. Never throws. */
export async function mirrorApiCall(entry: ApiLogEntry): Promise<void> {
  // Hermetic tests: client unit tests (robohire-client.test.ts 等) exercise
  // logApiCall with mocked fetch — they must not write rows into the dev DB.
  if (process.env.VITEST) return;
  try {
    await prisma.logEvent.create({ data: apiLogToLogEvent(entry) });
  } catch (e) {
    console.warn(`[api-call-mirror] LogEvent write failed (${entry.label}): ${(e as Error).message}`);
  }
}
