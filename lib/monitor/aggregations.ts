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
