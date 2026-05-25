// Real EventInstance payloads as test fixtures (Bundle N).
//
// Today: test-case-generator.ts synthesizes event.data from heuristics
// keyed off event name. Synthetic payloads catch easy cases but miss
// "code reads event.data.requirement_id but RAAS actually sends
// event.data.job_requisition_id" — a real-world bug class that only
// surfaces in production today.
//
// Bundle N reads recent accepted EventInstance rows from the local DB
// (event_instances table) for a given event name, picks one with a
// non-trivial payloadSummary, and returns its data as the happy-path
// fixture payload. Falls back to synthetic when nothing real is available.
//
// PRIVACY NOTE: real EventInstance rows contain real candidate data
// (names, emails, ids). Today this only flows through:
//   - server-side eval pipeline (stays inside operator's session)
//   - the UI rendered to the logged-in operator
// We don't write real payloads to any persisted artifact (no PR body,
// no use-case doc). If the use case expands to shared artifacts, add an
// anonymization pass first.

import { prisma } from '@/server/db';

export type RealEventFixture = {
  /** Trigger event name we picked the row for (matches incoming query). */
  eventName: string;
  /** Source of the row (rpa.* / raas-bridge / etc.) — informational. */
  source: string;
  /** The actual payload from EventInstance.payloadSummary (parsed JSON).
   *  Already includes envelope structure ({ payload: {...}, trace?: {...} }
   *  for RAAS-bridge events). */
  data: Record<string, unknown>;
  /** Row id for traceability (operator can click through to the original event). */
  eventInstanceId: string;
  /** Timestamp the original event arrived. */
  ts: Date;
};

/**
 * Pick a recent representative payload for `eventName`. Filters:
 *   - status: 'accepted' only (rejected payloads are by definition
 *     unrepresentative)
 *   - payloadSummary must parse to a non-empty object
 *   - Limit 5 most recent → pick the one with most keys (more realistic)
 *
 * Returns null when nothing matches; caller should fall back to synthetic.
 */
export async function pickRealEventFixture(
  eventName: string,
): Promise<RealEventFixture | null> {
  const rows = await prisma.eventInstance.findMany({
    where: { name: eventName, status: 'accepted' },
    orderBy: { ts: 'desc' },
    take: 5,
    select: {
      id: true,
      source: true,
      payloadSummary: true,
      ts: true,
    },
  });

  // Parse each payload and pick the one with the most top-level keys —
  // proxy for "most representative of real production shape".
  let best: { row: (typeof rows)[number]; parsed: Record<string, unknown>; keyCount: number } | null = null;
  for (const row of rows) {
    if (!row.payloadSummary) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payloadSummary);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const keyCount = Object.keys(parsed).length;
    if (keyCount === 0) continue;
    if (!best || keyCount > best.keyCount) {
      best = { row, parsed: parsed as Record<string, unknown>, keyCount };
    }
  }

  if (!best) return null;
  return {
    eventName,
    source: best.row.source,
    data: best.parsed,
    eventInstanceId: best.row.id,
    ts: best.row.ts,
  };
}

/** Same as pickRealEventFixture but returns the bare payload + null when
 *  no match. Convenience wrapper for callers that don't need metadata. */
export async function pickRealEventPayload(
  eventName: string,
): Promise<Record<string, unknown> | null> {
  const f = await pickRealEventFixture(eventName);
  return f?.data ?? null;
}
