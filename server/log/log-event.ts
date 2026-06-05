// LogEvent — the unified, queryable audit log. Every AgentActivity write is
// mirrored here (fire-and-forget) with a normalized (level, category) and the
// correlation keys (runId, agent), so /api/log-events can answer "show me everything
// for this run / agent / severity / time window" across all agents — the
// "审计日志全可查" requirement. Writing never throws (audit must not break work).

import { prisma } from '@/server/db';
import { recordNotification } from '@/server/notifications/ingest';

export type LogLevel = 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'critical';

export interface LevelCategory {
  level: LogLevel;
  category: string;
}

// Maps an AgentActivity `type` string (server/agent-logger.ts) to a normalized
// (level, category). Pure + total — unknown types default to info/info.
export function levelCategoryFor(type: string): LevelCategory {
  switch (type) {
    case 'agent_error':
      return { level: 'error', category: 'error' };
    case 'dependency_degraded':
      // External paid dependency (RoboHire / LLM gateway) returned an error or
      // an empty-200. Its own `dependency` category is the queryable lane the
      // monitor reads (lib/monitor/dependency.ts). See the dep-health spec.
      return { level: 'warn', category: 'dependency' };
    case 'dependency_reset':
      // Operator "I topped up" marker — degraded-call signals at/before it are
      // ignored. Its own category so the read port can find it. See reset.ts.
      return { level: 'info', category: 'dependency_reset' };
    case 'step.failed':
      return { level: 'error', category: 'step' };
    case 'anomaly':
      return { level: 'warn', category: 'anomaly' };
    case 'tool':
      return { level: 'info', category: 'tool' };
    case 'decision':
      return { level: 'info', category: 'decision' };
    case 'event_received':
    case 'event_emitted':
      return { level: 'info', category: 'event' };
    case 'agent_start':
    case 'agent_complete':
      return { level: 'info', category: 'lifecycle' };
    case 'hitl':
      return { level: 'notice', category: 'hitl' };
    case 'step.started':
    case 'step.completed':
    case 'step.retrying':
      return { level: 'info', category: 'step' };
    default:
      return { level: 'info', category: 'info' };
  }
}

// Maps a JSONL file-logger `kind` (lib/agent-logger) to the canonical
// AgentActivity type understood by levelCategoryFor. Pure + total.
export function typeForFileKind(kind: string): string {
  if (kind === 'handler.start') return 'agent_start';
  if (kind === 'handler.done') return 'agent_complete';
  if (kind === 'handler.error') return 'agent_error';
  if (kind === 'handler.raw_input') return 'event_received';
  if (kind.startsWith('emit.')) return 'event_emitted';
  if (kind.startsWith('api.')) return 'tool';
  if (kind === 'step.start') return 'step.started';
  if (kind === 'step.end') return 'step.completed';
  if (kind === 'step.error') return 'step.failed';
  if (kind.endsWith('.failed')) return 'anomaly';
  if (kind.endsWith('.error')) return 'agent_error';
  return 'info';
}

// File-logger ctx.agent (AGENT_NAME constants) → canonical AGENT_MAP short, so
// the AgentActivity rows the bridge writes group correctly in /monitor
// (overview rollup, agent pages, run-detail trail). Pure + total.
const FILE_AGENT_TO_SHORT: Record<string, string> = {
  ruleCheck: 'RuleCheck',
  createJD: 'JDGenerator',
  matchResume: 'Matcher',
  resumeParser: 'ResumeParser',
  interviewInviter: 'InterviewInviter',
};
export function canonicalShortForFileAgent(name: string): string {
  return FILE_AGENT_TO_SHORT[name] ?? name;
}

// Verbose, low-signal kinds we keep in the audit log (LogEvent) but DON'T
// mirror into AgentActivity, to keep the /monitor run timeline readable.
const ACTIVITY_SKIP_KINDS = new Set(['step.start', 'step.end', 'handler.raw_input']);

export interface RecordLogEventInput {
  type: string;
  message: string;
  source?: string;
  agent?: string | null;
  runId?: string | null;
  traceId?: string | null;
  eventName?: string | null;
  payloadJson?: string | null;
  durationMs?: number | null;
}

/** Fire-and-forget write into the unified audit log. Never throws. */
export async function recordLogEvent(input: RecordLogEventInput): Promise<void> {
  const { level, category } = levelCategoryFor(input.type);
  try {
    await prisma.logEvent.create({
      data: {
        level,
        category,
        source: input.source ?? 'agent',
        agent: input.agent ?? null,
        runId: input.runId ?? null,
        traceId: input.traceId ?? null,
        eventName: input.eventName ?? null,
        message: input.message.slice(0, 2000),
        payloadJson: input.payloadJson ?? null,
        durationMs: input.durationMs ?? null,
      },
    });
  } catch (e) {
    console.warn(`[log-event] recordLogEvent failed (${input.type}): ${(e as Error).message}`);
  }
}

export interface MirrorFileLogInput {
  agent: string;
  runId?: string | null;
  traceId?: string | null;
  kind: string;
  payload?: unknown;
}

/**
 * Bridge: mirror one JSONL file-logger entry (lib/agent-logger) into the unified
 * audit log, and route unrecoverable errors to the notification center. This is
 * what makes the REAL agents (which log to files, not the DB) show up in
 * /api/log-events and 消息通知. Fire-and-forget — never throws.
 */
export async function mirrorAgentFileLog(input: MirrorFileLogInput): Promise<void> {
  const type = typeForFileKind(input.kind);
  let payloadJson: string | null = null;
  if (input.payload !== undefined) {
    try {
      payloadJson = JSON.stringify(input.payload).slice(0, 4000);
    } catch {
      payloadJson = null;
    }
  }
  await recordLogEvent({
    type,
    message: input.kind,
    source: 'agent',
    agent: input.agent,
    runId: input.runId ?? null,
    traceId: input.traceId ?? null,
    payloadJson,
  });
  // Also mirror into AgentActivity (name-aligned) so the existing /monitor
  // views (run-detail timeline, overview rollup, per-agent pages) — which read
  // AgentActivity — surface the real agent narrative. Skip the verbose kinds.
  if (!ACTIVITY_SKIP_KINDS.has(input.kind)) {
    try {
      await prisma.agentActivity.create({
        data: {
          runId: input.runId ?? null,
          nodeId: input.agent,
          agentName: canonicalShortForFileAgent(input.agent),
          type,
          narrative: input.kind,
          metadata: payloadJson,
        },
      });
    } catch (e) {
      console.warn(`[log-event] AgentActivity mirror failed (${input.kind}): ${(e as Error).message}`);
    }
  }
  if (type === 'agent_error') {
    void recordNotification({
      level: 'error',
      category: 'agent_error',
      source: input.agent,
      agent: input.agent,
      runId: input.runId ?? null,
      traceId: input.traceId ?? null,
      message: `${input.agent} 运行异常:${input.kind}`,
      dedupeHint: `agent_error.${input.agent}`,
    }).catch(() => {});
  }
}
