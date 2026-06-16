// /api/inngest-events — proxy to local Inngest dev server's /v1/events API.
// Used by:
//   - /events page firehose tab (live stream of all events flowing
//     through the local bus, including RESUME_DOWNLOADED bridged from RAAS)
//   - /api/events/[name]/stream as the source for filtered SSE
//
// Optional ?name=EVENT_NAME filter, ?limit (default 30, max 100).

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { listEvents } from "@/lib/inngest-source";

const RAAS_INNGEST = process.env.RAAS_INNGEST_URL ?? "";

type InngestEvent = {
  id: string;
  internal_id?: string;
  name: string;
  data: unknown;
  ts?: number;
  received_at?: string;
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const nameFilter = url.searchParams.get("name");
  const limitParam = Number(url.searchParams.get("limit") ?? 30);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitParam) ? limitParam : 30));
  const includeShared = url.searchParams.get("includeShared") === "1";

  const sourceLabels = ["local", ...(includeShared && RAAS_INNGEST ? ["shared"] : [])];

  const all: Array<InngestEvent & { _source: string }> = [];
  const errors: Array<{ source: string; message: string }> = [];

  // Local events go through inngest-source: live Inngest ∪ durable Postgres
  // archive. The live /v1/events buffer is lossy/ephemeral (empties after quiet
  // periods or an Inngest restart), so reading it alone makes /events look
  // frozen even though the archive has the history. nameFilter is passed
  // through so Inngest dev returns the right slice server-side.
  try {
    const localEvents = await listEvents(limit, nameFilter ?? undefined);
    for (const e of localEvents) all.push({ ...e, _source: "local" });
  } catch (e) {
    errors.push({ source: "local", message: (e as Error).message });
  }

  // Shared (RAAS) Inngest is a separate instance with no local archive mirror —
  // read it live. Inngest dev /v1/events accepts ?name= (NOT event_name) for
  // server-side filtering.
  if (includeShared && RAAS_INNGEST) {
    try {
      const upstreamUrl = new URL(`${RAAS_INNGEST}/v1/events`);
      upstreamUrl.searchParams.set("limit", String(limit));
      if (nameFilter) upstreamUrl.searchParams.set("name", nameFilter);
      const r = await fetch(upstreamUrl, { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) {
        errors.push({ source: "shared", message: `${r.status} ${r.statusText}` });
      } else {
        const body = (await r.json()) as { data?: InngestEvent[] };
        for (const e of body.data ?? []) all.push({ ...e, _source: "shared" });
      }
    } catch (e) {
      errors.push({ source: "shared", message: (e as Error).message });
    }
  }

  // Sort newest first by id (ULIDs sort chronologically)
  all.sort((a, b) => (b.id > a.id ? 1 : -1));

  const sliced = all.slice(0, limit);

  // Enrich with EventInstance.source so the UI can show direction badges.
  // We look up by externalEventId (= the Inngest event id) for RAAS-bridged
  // events, and by the row's own id for internally published events.
  // Best-effort: any DB error is silently ignored and events get source=null.
  type EnrichedEvent = (typeof sliced)[number] & { source: string | null };
  let enriched: EnrichedEvent[] = sliced.map((e) => ({ ...e, source: null }));
  try {
    const ids = sliced.map((e) => e.internal_id ?? e.id).filter(Boolean);
    if (ids.length > 0) {
      const rows = await prisma.eventInstance.findMany({
        where: { externalEventId: { in: ids } },
        select: { externalEventId: true, source: true },
      });
      const byExtId = new Map(rows.map((r) => [r.externalEventId, r.source]));
      enriched = sliced.map((e) => ({
        ...e,
        source: byExtId.get(e.internal_id ?? e.id) ?? null,
      }));
    }
  } catch {
    // DB unavailable — silently continue without source enrichment
  }

  return NextResponse.json({
    events: enriched,
    sources: sourceLabels,
    errors,
    fetchedAt: new Date().toISOString(),
  });
}
