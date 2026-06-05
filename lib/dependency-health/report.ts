// External Dependency Health — the report-and-fail helper.
//
// Called by the agents at the point a RoboHire/LLM call is found degraded. Does
// exactly two things, in order:
//   1. write ONE structured signal into the unified audit log (LogEvent,
//      category 'dependency') for the monitor to read; and
//   2. throw, so the run stops being a false "success".
//
// Throw kind depends on recoverability: out-of-funds / throttle / transient
// infra are RETRIABLE (the run parks and auto-resumes once you top up / the
// vendor recovers — candidates aren't dropped); bad credentials / bad input
// are NonRetriable (hard fail, no point retrying).

import { NonRetriableError } from 'inngest';
import { recordLogEvent as realRecordLogEvent } from '@/server/log/log-event';
import type { DepOutcome, DepReason } from './types';

type Degraded = Extract<DepOutcome, { ok: false }>;

export interface ReportContext {
  agent?: string;
  runId?: string | null;
  traceId?: string | null;
  /** Allmeta business-domain id the affected agent belongs to. */
  domain: string;
  anchors?: Record<string, string | null | undefined>;
}

interface ReportDeps {
  recordLogEvent?: typeof realRecordLogEvent;
}

const RECOVERABLE: ReadonlySet<DepReason> = new Set<DepReason>(['quota', 'rate_limit', 'network', 'server']);

function friendlyProvider(provider: Degraded['provider']): string {
  return provider === 'llm' ? 'LLM 网关' : 'RoboHire';
}

function cleanAnchors(anchors?: Record<string, string | null | undefined>): Record<string, string> | undefined {
  if (!anchors) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(anchors)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Record the degraded-dependency signal and throw to fail the run. Never
 * returns. `deps.recordLogEvent` is injectable for tests.
 */
export async function reportDependencyDegraded(
  o: Degraded,
  ctx: ReportContext,
  deps: ReportDeps = {},
): Promise<never> {
  const record = deps.recordLogEvent ?? realRecordLogEvent;
  const anchors = cleanAnchors(ctx.anchors);

  await record({
    type: 'dependency_degraded',
    message: `${friendlyProvider(o.provider)} ${o.op} 退化:${o.reason} — ${o.detail}`,
    source: o.provider === 'llm' ? 'LLM 网关' : 'RoboHire',
    agent: ctx.agent ?? null,
    runId: ctx.runId ?? null,
    traceId: ctx.traceId ?? null,
    payloadJson: JSON.stringify({
      provider: o.provider,
      op: o.op,
      reason: o.reason,
      detail: o.detail,
      domain: ctx.domain,
      anchors,
      inngestRunId: ctx.runId ?? null,
    }),
  });

  const msg = `external dependency degraded — ${o.provider}/${o.op} ${o.reason}: ${o.detail}`;
  if (RECOVERABLE.has(o.reason)) throw new Error(msg);
  throw new NonRetriableError(msg);
}
