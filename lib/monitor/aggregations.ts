import type {
  MonitorEdgeAgg,
  NodeStatus,
} from './types';

// ── pickNodeStatus ───────────────────────────────────────────────
// One signal wins. Order matters: explicit failure first, then
// degradation, then idle vs healthy.
export function pickNodeStatus(input: {
  running: number;
  completedInWindow: number;
  failedInWindow: number;
  queueDepth: number;
}): NodeStatus {
  const { running, completedInWindow, failedInWindow, queueDepth } = input;
  const totalAttempts = completedInWindow + failedInWindow;
  const errRate = totalAttempts > 0 ? failedInWindow / totalAttempts : 0;
  if (errRate > 0.2) return 'failing';
  if (queueDepth > 50 || errRate > 0.05) return 'degraded';
  if (running === 0 && totalAttempts === 0) return 'idle';
  return 'healthy';
}

// ── sumTokensFromActivities ─────────────────────────────────────
// AgentActivity rows with type='tool' carry token usage inside the
// metadata JSON via server/llm/instrumented.ts withLlmTelemetry().
// We tolerate every shape of broken metadata — never throw, just skip.
export function sumTokensFromActivities(
  rows: Array<{ metadata: string | null }>,
): { prompt: number; completion: number; total: number } {
  let prompt = 0, completion = 0, total = 0;
  for (const r of rows) {
    if (!r.metadata) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(r.metadata);
    } catch {
      continue;
    }
    const pt = numericOrZero(parsed.promptTokens);
    const ct = numericOrZero(parsed.completionTokens);
    const tt = numericOrZero(parsed.totalTokens);
    if (pt || ct || tt) {
      prompt += pt;
      completion += ct;
      total += tt || (pt + ct);
    }
  }
  return { prompt, completion, total };
}

function numericOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ── buildHourlyBuckets ──────────────────────────────────────────
/**
 * Bucket a 24-hour-ish window into hourly slots aligned to clock hour
 * boundaries. Each slot is computed by the caller's `compute(bucketStart,
 * bucketEnd)` callback. Returns exactly 24 buckets, padded backward in time
 * from the earliest produced slot if `since` was less than 24h ago.
 *
 * Bucket boundaries are aligned: bucketStart = Math.floor(since/HOUR)*HOUR,
 * advancing by HOUR until reaching `now`.
 */
export function buildHourlyBuckets<T>(
  since: Date,
  compute: (bucketStart: Date, bucketEnd: Date) => T,
): Array<{ bucket: string; value: T }> {
  const HOUR = 60 * 60 * 1000;
  const buckets: Array<{ bucket: string; value: T }> = [];
  let start = new Date(Math.floor(since.getTime() / HOUR) * HOUR);
  const end = new Date();
  while (start < end && buckets.length < 24) {
    const next = new Date(start.getTime() + HOUR);
    buckets.push({ bucket: start.toISOString(), value: compute(start, next) });
    start = next;
  }
  // Pad backward in time to reach exactly 24 buckets. Each pad bucket
  // gets a timestamp one HOUR earlier than the previous earliest.
  while (buckets.length < 24) {
    const earliestMs = new Date(buckets[0]?.bucket ?? Date.now()).getTime();
    const padStart = new Date(earliestMs - HOUR);
    const padEnd = new Date(earliestMs);
    buckets.unshift({ bucket: padStart.toISOString(), value: compute(padStart, padEnd) });
  }
  return buckets;
}

// ── buildEdgeAggregates ─────────────────────────────────────────
// Edge volume = how many event_instances of the edge's eventName
// landed in the window. Computed by event name lookup, not by trying
// to reason about source agent identity (RAAS messages can be sourced
// from arbitrary publishers).
export function buildEdgeAggregates(
  edges: Array<{ from: string; to: string; eventName: string }>,
  eventInstances: Array<{ name: string; ts: Date; status: string }>,
): MonitorEdgeAgg[] {
  const byName = new Map<string, { count: number; lastAt: Date | null }>();
  for (const ev of eventInstances) {
    if (ev.status !== 'accepted') continue;
    const bucket = byName.get(ev.name) ?? { count: 0, lastAt: null };
    bucket.count += 1;
    if (!bucket.lastAt || ev.ts > bucket.lastAt) bucket.lastAt = ev.ts;
    byName.set(ev.name, bucket);
  }
  return edges.map((e) => {
    const b = byName.get(e.eventName);
    return {
      from: e.from,
      to: e.to,
      eventName: e.eventName,
      countInWindow: b?.count ?? 0,
      lastEventAt: b?.lastAt?.toISOString() ?? null,
    };
  });
}
