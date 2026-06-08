// Notification → raw-log correlation (spec §4). Given a notification, decide
// which LogEvent rows are the "detailed logs" behind it, so the detail drawer
// can show a human the underlying error and let them locate the problem.
//
// buildLogQuery is PURE (returns Prisma findMany args) so the priority order is
// unit-tested without a DB: runId > traceId > agent+window > system window.

export type LogLevel = 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'critical';

export interface CorrelationInput {
  runId: string | null;
  traceId: string | null;
  agent: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface LogQuery {
  where: Record<string, unknown>;
  orderBy: { ts: 'asc' };
  take: number;
}

const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // ±10 min around the notification span
const TAKE = 100;
const NOISY_LEVELS_EXCLUDED: LogLevel[] = ['warn', 'error', 'critical'];

/**
 * Resolve the LogEvent query for a notification, most-specific correlation key
 * first. Falls back to a time-windowed system scan (errors only) when the
 * notification has no run/trace/agent anchor — e.g. a backend crash-restart.
 */
export function buildLogQuery(n: CorrelationInput, windowMs = DEFAULT_WINDOW_MS): LogQuery {
  const orderBy = { ts: 'asc' as const };
  if (n.runId) return { where: { runId: n.runId }, orderBy, take: TAKE };
  if (n.traceId) return { where: { traceId: n.traceId }, orderBy, take: TAKE };

  const ts = {
    gte: new Date(n.firstSeenAt.getTime() - windowMs),
    lte: new Date(n.lastSeenAt.getTime() + windowMs),
  };
  if (n.agent) return { where: { agent: n.agent, ts }, orderBy, take: TAKE };
  // System notification with no anchor: show the alarming logs in the window.
  return { where: { ts, level: { in: NOISY_LEVELS_EXCLUDED } }, orderBy, take: TAKE };
}
