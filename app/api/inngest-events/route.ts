// /api/inngest-events — proxy to local Inngest dev server's /v1/events API.
// Used by:
//   - /events page firehose tab (live stream of all events flowing
//     through the local bus, including RESUME_DOWNLOADED bridged from RAAS)
//   - /api/events/[name]/stream as the source for filtered SSE
//
// Optional ?name=EVENT_NAME filter, ?limit (default 30, max 100).

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { listEventsPage } from "@/lib/inngest-source";
import { eventMatchesDomain, inferEventDomain } from "@/lib/events/domain-scope";
import { deriveEventOutcome, deriveRunOutcome } from "@/lib/monitor/run-outcome";

const RAAS_INNGEST = process.env.RAAS_INNGEST_URL ?? "";

type InngestEvent = {
  id: string;
  internal_id?: string;
  name: string;
  data: unknown;
  ts?: number;
  received_at?: string;
  sourceApp?: string | null;
  domain?: string | null;
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const nameFilter = url.searchParams.get("name");
  const legacyLimit = positiveInt(url.searchParams.get("limit"), 30, 500);
  const page = positiveInt(url.searchParams.get("page"), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(url.searchParams.get("pageSize"), legacyLimit, 500);
  const includeShared = url.searchParams.get("includeShared") === "1";
  const domain = url.searchParams.get("domain") ?? undefined;
  const sinceHoursRaw = Number(url.searchParams.get("sinceHours"));
  const sinceHours = Number.isFinite(sinceHoursRaw) && sinceHoursRaw > 0
    ? sinceHoursRaw
    : undefined;
  const sinceRaw = url.searchParams.get("since");
  const sinceDate = sinceRaw ? new Date(sinceRaw) : null;
  const since = sinceDate && Number.isFinite(sinceDate.getTime()) ? sinceDate : undefined;
  // Shared RAAS is an optional live-only overlay. To page a merged result we
  // need the local prefix up to the requested page; the normal/local path does
  // a direct Postgres skip/take query.
  const localPageSize = includeShared ? Math.min(500, page * pageSize) : pageSize;

  const sourceLabels = ["local", ...(includeShared && RAAS_INNGEST ? ["shared"] : [])];

  const all: Array<InngestEvent & { _source: string; domain: string }> = [];
  const errors: Array<{ source: string; message: string }> = [];
  let localTotal = 0;
  let localSource: "postgres" | "live" = "postgres";

  // Local events go through inngest-source: live Inngest ∪ durable Postgres
  // archive. The live /v1/events buffer is lossy/ephemeral (empties after quiet
  // periods or an Inngest restart), so reading it alone makes /events look
  // frozen even though the archive has the history. nameFilter is passed
  // through so Inngest dev returns the right slice server-side.
  try {
    const local = await listEventsPage({
      page: includeShared ? 1 : page,
      pageSize: localPageSize,
      name: nameFilter ?? undefined,
      domain,
      since,
      sinceHours,
    });
    localTotal = local.total;
    localSource = local.source;
    for (const e of local.items) all.push({ ...e, _source: "local", domain: inferEventDomain(e) });
  } catch (e) {
    errors.push({ source: "local", message: (e as Error).message });
  }

  // Shared (RAAS) Inngest is a separate instance with no local archive mirror —
  // read it live. Inngest dev /v1/events accepts ?name= (NOT event_name) for
  // server-side filtering.
  if (includeShared && RAAS_INNGEST) {
    try {
      const upstreamUrl = new URL(`${RAAS_INNGEST}/v1/events`);
      upstreamUrl.searchParams.set("limit", String(Math.min(1000, page * pageSize)));
      if (nameFilter) upstreamUrl.searchParams.set("name", nameFilter);
      const r = await fetch(upstreamUrl, { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) {
        errors.push({ source: "shared", message: `${r.status} ${r.statusText}` });
      } else {
        const body = (await r.json()) as { data?: InngestEvent[] };
        for (const e of body.data ?? []) all.push({ ...e, _source: "shared", domain: inferEventDomain(e) });
      }
    } catch (e) {
      errors.push({ source: "shared", message: (e as Error).message });
    }
  }

  const sinceMs = since?.getTime() ?? (sinceHours ? Date.now() - sinceHours * 3600_000 : null);
  const scoped = all.filter((event) => {
    if (domain && !eventMatchesDomain(event, domain)) return false;
    if (sinceMs !== null && eventTime(event) < sinceMs) return false;
    return true;
  });

  // Stable newest-first order. Not every upstream id is a ULID, so prefer its
  // explicit timestamp and use id as the deterministic tie-breaker.
  scoped.sort((a, b) => eventTime(b) - eventTime(a) || b.id.localeCompare(a.id));

  const sliced = includeShared
    ? scoped.slice((page - 1) * pageSize, page * pageSize)
    : scoped.slice(0, pageSize);

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

  const eventIds = [...new Set(enriched.flatMap((event) => [event.id, event.internal_id].filter((id): id is string => Boolean(id))))];
  const relatedRuns = eventIds.length > 0
    ? await prisma.inngestRunArchive.findMany({
        where: { OR: eventIds.map((id) => ({ triggerEventIds: { contains: id } })) },
        select: {
          runId: true,
          status: true,
          functionSlug: true,
          eventName: true,
          triggerEventIds: true,
          output: true,
        },
      }).catch(() => [])
    : [];
  const runsByEvent = new Map<string, typeof relatedRuns>();
  for (const run of relatedRuns) {
    for (const id of parseStringArray(run.triggerEventIds)) {
      const rows = runsByEvent.get(id) ?? [];
      rows.push(run);
      runsByEvent.set(id, rows);
    }
  }
  const eventsWithOutcome = enriched.map((event) => {
    const ids = [event.internal_id, event.id].filter((id): id is string => Boolean(id));
    const uniqueRuns = [...new Map(ids.flatMap((id) => runsByEvent.get(id) ?? []).map((run) => [run.runId, run])).values()];
    const processingRuns = uniqueRuns.map((run) => ({
      runId: run.runId,
      status: run.status,
      functionSlug: run.functionSlug,
      outcome: deriveRunOutcome({
        status: run.status,
        functionSlug: run.functionSlug,
        triggerEvent: run.eventName,
        output: safeJson(run.output),
      }),
    }));
    return {
      ...event,
      processingRuns,
      outcome: deriveEventOutcome(event.name, event.data, processingRuns.map((run) => run.outcome)),
    };
  });

  const localIds = new Set(all.filter((event) => event._source === "local").map((event) => event.id));
  const sharedObserved = includeShared
    ? new Set(
        scoped
          .filter((event) => event._source === "shared" && !localIds.has(event.id))
          .map((event) => event.id),
      ).size
    : 0;
  const total = localTotal + sharedObserved;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return NextResponse.json({
    events: eventsWithOutcome,
    page,
    pageSize,
    // Local history is exact and counted in Postgres. Shared rows are live-only
    // and therefore contribute only the unique rows observed in this request.
    total,
    totalPages,
    sources: sourceLabels,
    errors,
    fetchedAt: new Date().toISOString(),
    meta: {
      page,
      pageSize,
      total,
      totalPages,
      source: localSource,
      sharedTotalIsObserved: includeShared,
      generatedAt: new Date().toISOString(),
    },
  });
}

function safeJson(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseStringArray(value: string | null): string[] {
  const parsed = safeJson(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function positiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
}

function eventTime(event: InngestEvent): number {
  if (event.received_at) {
    const n = new Date(event.received_at).getTime();
    if (Number.isFinite(n)) return n;
  }
  return typeof event.ts === "number" ? event.ts : 0;
}
