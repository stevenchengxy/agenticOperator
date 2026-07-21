// GET /api/em/event-instances
//
// Generic list endpoint over the EventInstance table.
// Drives the DLQ / Rejected / Instances / Causality sub-tabs on /events.
//
// Query params:
//   status     "accepted" | "rejected_schema" | "rejected_filter" | "duplicate" | "meta_rejection" | "em_degraded"
//   statusIn   comma-separated list, takes priority over status
//   name       event name exact match
//   source     publisher source exact match
//   externalEventId    lookup by upstream id (returns 0 or 1 row)
//   causedByEventId    lookup direct children in the causality graph
//   q          substring match on name OR external_event_id (case-insensitive on lowered)
//   limit      default 100, max 500
//   cursor     pagination cursor (last seen id, descending by ts)

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { eventMatchesDomain, inferEventDomain } from "@/lib/events/domain-scope";
import { ensureEventInstanceDomains } from "@/lib/persistence/domain-backfill";

export const dynamic = "force-dynamic";

export type EventInstanceRow = {
  id: string;
  externalEventId: string | null;
  name: string;
  source: string;
  status: string;
  rejectionType: string | null;
  rejectionReason: string | null;
  schemaErrors: unknown | null;
  schemaVersionUsed: string | null;
  triedVersions: string[] | null;
  causedByEventId: string | null;
  causedByName: string | null;
  payloadSummary: string | null;
  domain: string;
  ts: string;
};

export type EventInstancesResponse = {
  rows: EventInstanceRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  nextCursor: string | null;
  meta: { generatedAt: string };
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const statusInRaw = url.searchParams.get("statusIn");
  const name = url.searchParams.get("name") ?? undefined;
  const source = url.searchParams.get("source") ?? undefined;
  const externalEventId = url.searchParams.get("externalEventId") ?? undefined;
  const causedByEventId = url.searchParams.get("causedByEventId") ?? undefined;
  const q = url.searchParams.get("q")?.trim() ?? "";
  const limit = positiveInt(url.searchParams.get("limit"), 100, 500);
  const pageMode = url.searchParams.has("page") || url.searchParams.has("pageSize");
  const page = positiveInt(url.searchParams.get("page"), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(url.searchParams.get("pageSize"), limit, 500);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const domain = url.searchParams.get("domain") ?? undefined;

  const where: Record<string, unknown> = {};
  if (statusInRaw) {
    where.status = { in: statusInRaw.split(",").map((s) => s.trim()).filter(Boolean) };
  } else if (status) {
    where.status = status;
  }
  if (name) where.name = name;
  if (source) where.source = source;
  if (externalEventId) where.externalEventId = externalEventId;
  if (causedByEventId) where.causedByEventId = causedByEventId;
  if (q) {
    // SQLite doesn't support `mode: 'insensitive'`; the columns are stored
    // mixed-case but event names are conventionally UPPER_SNAKE so we match
    // raw on `name`, and case-sensitively on externalEventId.
    where.OR = [
      { name: { contains: q.toUpperCase() } },
      { externalEventId: { contains: q } },
    ];
  }
  if (domain) {
    where.domain = inferEventDomain({ domain });
  }

  let rows: EventInstanceRow[] = [];
  let total = 0;
  try {
    if (domain) {
      // Complete the one-time legacy backfill before count/skip so domain
      // totals are exact; new writes already persist this value.
      await ensureEventInstanceDomains();
    }
    const [items, count] = await Promise.all([
      prisma.eventInstance.findMany({
        where,
        orderBy: [{ ts: "desc" }, { id: "desc" }],
        take: pageMode ? pageSize : limit + 1,
        ...(pageMode
          ? { skip: (page - 1) * pageSize }
          : cursor
            ? { cursor: { id: cursor }, skip: 1 }
            : {}),
      }),
      prisma.eventInstance.count({ where }),
    ]);
    const mapped = items.map(toRow);
    // `domain` is already filtered in SQL. eventMatchesDomain is retained as
    // a defensive assertion for rows written by an older process during a
    // rolling upgrade, but it no longer changes count/page boundaries.
    const scoped = domain ? mapped.filter((r) => eventMatchesDomain(r, domain)) : mapped;
    const hasMore = pageMode ? page * pageSize < count : scoped.length > limit;
    rows = pageMode ? scoped : scoped.slice(0, limit);
    total = count;
    const nextCursor = hasMore ? rows[rows.length - 1]!.id : null;
    const body: EventInstancesResponse = {
      rows,
      total,
      page,
      pageSize: pageMode ? pageSize : limit,
      totalPages: Math.max(1, Math.ceil(total / (pageMode ? pageSize : limit))),
      nextCursor,
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      {
        error: "INTERNAL",
        message: (err as Error).message,
      },
      { status: 500 },
    );
  }
}

function toRow(r: {
  id: string;
  externalEventId: string | null;
  name: string;
  source: string;
  status: string;
  rejectionType: string | null;
  rejectionReason: string | null;
  schemaErrors: string | null;
  schemaVersionUsed: string | null;
  triedVersions: string | null;
  causedByEventId: string | null;
  causedByName: string | null;
  payloadSummary: string | null;
  domain: string | null;
  ts: Date;
}): EventInstanceRow {
  const payload = parseJson(r.payloadSummary);
  return {
    id: r.id,
    externalEventId: r.externalEventId,
    name: r.name,
    source: r.source,
    status: r.status,
    rejectionType: r.rejectionType,
    rejectionReason: r.rejectionReason,
    schemaErrors: parseJson(r.schemaErrors),
    schemaVersionUsed: r.schemaVersionUsed,
    triedVersions: parseJsonArray(r.triedVersions),
    causedByEventId: r.causedByEventId,
    causedByName: r.causedByName,
    payloadSummary: r.payloadSummary,
    domain: r.domain ?? inferEventDomain({ name: r.name, data: payload }),
    ts: r.ts.toISOString(),
  };
}

function positiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
}

function parseJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function parseJsonArray(s: string | null): string[] | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
