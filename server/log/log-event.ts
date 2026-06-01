// LogEvent — the unified, queryable audit log. Every AgentActivity write is
// mirrored here (fire-and-forget) with a normalized (level, category) and the
// correlation keys (runId, agent), so /api/log-events can answer "show me everything
// for this run / agent / severity / time window" across all agents — the
// "审计日志全可查" requirement. Writing never throws (audit must not break work).

import { prisma } from '@/server/db';

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
