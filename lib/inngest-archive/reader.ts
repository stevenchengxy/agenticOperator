// Postgres-backed reader — serves the same shapes as lib/inngest-admin-client
// but from the durable archive tables instead of the live Inngest dev server.
// Used via lib/inngest-source.ts (PG-first, live fallback) so monitoring keeps
// working when Inngest is down.
//
// Return types are pinned to the live client's via Awaited<ReturnType<...>> so
// the source resolver can return either interchangeably. A `| null` result
// means "not in the archive" → the resolver should fall back to live.
import { prisma } from "../../server/db";
import * as live from "../inngest-admin-client";
import { deriveFlowId, flowLabel } from "../inngest-admin-client";
import { inferEventDomain } from "../events/domain-scope";
import {
  ensureArchivedEventDomains,
  ensureArchivedRunDomains,
} from "../persistence/domain-backfill";

type RecentRunResult = Awaited<ReturnType<typeof live.listRecentRuns>>;
type RunHistoryResult = Awaited<ReturnType<typeof live.getRunHistory>>;
type StepOutputsResult = Awaited<ReturnType<typeof live.getRunStepOutputs>>;
type RunsWithEventsResult = Awaited<ReturnType<typeof live.listRunsWithEvents>>;
type EventsResult = Awaited<ReturnType<typeof live.listEvents>>;

export type PageResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type RecentRunsPageOptions = {
  page?: number;
  pageSize?: number;
  functionSlug?: string;
  domain?: string;
  status?: string[];
  eventName?: string;
  sinceHours?: number;
};

export type EventsPageOptions = {
  page?: number;
  pageSize?: number;
  name?: string;
  domain?: string;
  sinceHours?: number;
  since?: Date;
};

function normalizedPage(page = 1, pageSize = 50): { page: number; pageSize: number } {
  return {
    page: Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1,
    pageSize: Number.isFinite(pageSize) ? Math.min(500, Math.max(1, Math.floor(pageSize))) : 50,
  };
}

function pageResult<T>(items: T[], total: number, page: number, pageSize: number): PageResult<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function parseMaybeJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function firstTriggerId(triggerEventIds: string | null): string | undefined {
  if (!triggerEventIds) return undefined;
  try {
    const arr = JSON.parse(triggerEventIds);
    return Array.isArray(arr) && arr.length > 0 ? String(arr[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** `${runId}#<index>` → index, for stable step ordering. */
function stepIndex(id: string): number {
  const n = Number(id.split("#")[1]);
  return Number.isFinite(n) ? n : 0;
}

function mapRunRow(r: {
  runId: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  functionName: string | null;
  functionSlug: string;
  appId: string | null;
  eventName: string | null;
  triggerEventIds: string | null;
}): RecentRunResult[number] {
  return {
    id: r.runId,
    status: r.status,
    startedAt: r.startedAt?.toISOString() ?? "",
    finishedAt: r.endedAt?.toISOString() ?? undefined,
    function: {
      name: r.functionName ?? r.functionSlug,
      slug: r.functionSlug,
      appID: r.appId ?? undefined,
    },
    eventName: r.eventName ?? undefined,
    eventId: firstTriggerId(r.triggerEventIds),
  };
}

function mapEventRow(r: {
  id: string;
  internalId: string | null;
  name: string;
  data: string;
  ts: Date | null;
  receivedAt: Date | null;
  sourceApp: string | null;
  domain: string | null;
  occurredAt?: Date | null;
}): EventsResult[number] {
  const data = parseMaybeJson(r.data);
  return {
    id: r.id,
    internal_id: r.internalId ?? undefined,
    name: r.name,
    data,
    ts: r.ts ? r.ts.getTime() : undefined,
    received_at: r.receivedAt?.toISOString() ?? undefined,
    sourceApp: r.sourceApp ?? undefined,
    domain: r.domain ?? inferEventDomain({ name: r.name, data, sourceApp: r.sourceApp }),
  };
}

export async function listRecentRuns(
  opts: { limit?: number; functionSlug?: string; sinceHours?: number } = {},
): Promise<RecentRunResult> {
  const limit = opts.limit ?? 50;
  const from =
    typeof opts.sinceHours === "number" && Number.isFinite(opts.sinceHours) && opts.sinceHours > 0
      ? new Date(Date.now() - opts.sinceHours * 3600_000)
      : null;
  const rows = await prisma.inngestRunArchive.findMany({
    where: {
      ...(from ? { startedAt: { gte: from } } : {}),
      ...(opts.functionSlug ? { functionSlug: opts.functionSlug } : {}),
    },
    orderBy: [{ startedAt: "desc" }, { runId: "desc" }],
    take: limit,
  });
  return rows.map(mapRunRow);
}

/** Exact Postgres pagination for the monitor run list. */
export async function listRecentRunsPage(
  opts: RecentRunsPageOptions = {},
): Promise<PageResult<RecentRunResult[number]>> {
  const { page, pageSize } = normalizedPage(opts.page, opts.pageSize);
  if (opts.domain) await ensureArchivedRunDomains();
  const from =
    typeof opts.sinceHours === "number" && Number.isFinite(opts.sinceHours) && opts.sinceHours > 0
      ? new Date(Date.now() - opts.sinceHours * 3600_000)
      : null;
  const where = {
    ...(from ? { startedAt: { gte: from } } : {}),
    ...(opts.functionSlug ? { functionSlug: opts.functionSlug } : {}),
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.status?.length ? { status: { in: opts.status } } : {}),
    ...(opts.eventName ? { eventName: opts.eventName } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.inngestRunArchive.findMany({
      where,
      orderBy: [{ startedAt: "desc" }, { runId: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.inngestRunArchive.count({ where }),
  ]);
  return pageResult(rows.map(mapRunRow), total, page, pageSize);
}

export async function getRunHistory(runId: string): Promise<RunHistoryResult | null> {
  const run = await prisma.inngestRunArchive.findUnique({
    where: { runId },
    include: { steps: true },
  });
  if (!run) return null; // not archived → caller falls back to live

  const steps = [...run.steps]
    .sort((a, b) => stepIndex(a.id) - stepIndex(b.id))
    .map((s) => ({
      name: s.name,
      status: s.status ?? "",
      durationMs: s.durationMs,
      startedAt: s.startedAt?.toISOString() ?? null,
      endedAt: s.endedAt?.toISOString() ?? null,
      stepOp: s.stepOp,
      stepID: s.spanId,
      attempts: s.attempts,
      output: parseMaybeJson(s.output),
      input: parseMaybeJson(s.input),
      error: (s.error ? parseMaybeJson(s.error) : null) as RunHistoryResult["steps"][number]["error"],
    }));

  return {
    id: run.runId,
    status: run.status,
    startedAt: run.startedAt?.toISOString() ?? "",
    finishedAt: run.endedAt?.toISOString() ?? undefined,
    output: parseMaybeJson(run.output),
    function: { name: run.functionName ?? run.functionSlug, slug: run.functionSlug },
    event: run.eventPayload
      ? {
          id: firstTriggerId(run.triggerEventIds) ?? "",
          name: run.eventName ?? "",
          payload: run.eventPayload,
          createdAt: run.startedAt?.toISOString() ?? "",
        }
      : undefined,
    steps,
  };
}

export async function getRunStepOutputs(runId: string): Promise<StepOutputsResult | null> {
  const run = await prisma.inngestRunArchive.findUnique({
    where: { runId },
    select: { traceFetched: true, steps: true },
  });
  // Not archived, or trace not yet captured → let caller fall back to live.
  if (!run || !run.traceFetched) return null;
  return [...run.steps]
    .sort((a, b) => stepIndex(a.id) - stepIndex(b.id))
    .map((s) => ({
      spanID: s.spanId,
      name: s.name,
      stepOp: s.stepOp,
      status: s.status,
      attempts: s.attempts,
      durationMs: s.durationMs,
      queuedAt: s.queuedAt?.toISOString() ?? null,
      startedAt: s.startedAt?.toISOString() ?? null,
      endedAt: s.endedAt?.toISOString() ?? null,
      output: s.output,
      outputError: null,
    }));
}

/**
 * Recent events from the durable archive, newest-first, shaped exactly like the
 * live client's listEvents. The live Inngest dev server's /v1/events buffer is
 * lossy and ephemeral (empties after quiet periods / restarts), so reading the
 * archive keeps the /events page + overview stream populated. Ordered by
 * archivedAt (always non-null, ≈ capture/chronological order) since received_at
 * can be null for some rows; the source resolver re-sorts the merged union.
 */
export async function listEvents(limit = 50, name?: string): Promise<EventsResult> {
  const rows = await prisma.inngestEventArchive.findMany({
    where: name ? { name } : {},
    orderBy: [{ archivedAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return rows.map(mapEventRow);
}

/** Exact Postgres pagination for the durable Inngest event history. */
export async function listEventsPage(
  opts: EventsPageOptions = {},
): Promise<PageResult<EventsResult[number]>> {
  const { page, pageSize } = normalizedPage(opts.page, opts.pageSize);
  await ensureArchivedEventDomains();
  const from = opts.since && Number.isFinite(opts.since.getTime())
    ? opts.since
    : typeof opts.sinceHours === "number" && Number.isFinite(opts.sinceHours) && opts.sinceHours > 0
      ? new Date(Date.now() - opts.sinceHours * 3600_000)
      : null;
  const where = {
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(from ? { occurredAt: { gte: from } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.inngestEventArchive.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.inngestEventArchive.count({ where }),
  ]);
  return pageResult(rows.map(mapEventRow), total, page, pageSize);
}

export async function listRunsWithEvents(
  functionSlug: string,
  opts: { limit?: number; sinceHours?: number } = {},
): Promise<RunsWithEventsResult> {
  const limit = opts.limit ?? 100;
  const from =
    typeof opts.sinceHours === "number" && Number.isFinite(opts.sinceHours) && opts.sinceHours > 0
      ? new Date(Date.now() - opts.sinceHours * 3600_000)
      : null;
  const rows = await prisma.inngestRunArchive.findMany({
    where: { functionSlug, ...(from ? { startedAt: { gte: from } } : {}) },
    orderBy: [{ startedAt: "desc" }, { runId: "desc" }],
    take: limit,
  });
  return rows.map((r) => {
    const eventPayload = (parseMaybeJson(r.eventPayload) ?? null) as Record<
      string,
      unknown
    > | null;
    const eventId = firstTriggerId(r.triggerEventIds) ?? "";
    return {
      runId: r.runId,
      status: r.status,
      startedAt: r.startedAt?.toISOString() ?? "",
      finishedAt: r.endedAt?.toISOString() ?? undefined,
      durationMs: r.durationMs ?? null,
      eventName: r.eventName ?? "",
      eventId,
      eventPayload,
      flowId: r.flowId ?? deriveFlowId(eventPayload, eventId || r.runId),
      label: flowLabel(eventPayload),
    };
  });
}

/**
 * Single archived event by Inngest id — matches either the REST id or the
 * internal ULID (callers pass whichever they have; runs carry the internal id
 * in triggerEventIds while /v1/events rows key on the REST id).
 *
 * This is the replay fallback: the live /v1/events buffer is lossy/ephemeral,
 * so "重跑/重发" on any event that aged out of it can only be served from here.
 */
export async function getEventById(eventId: string): Promise<EventsResult[number] | null> {
  if (!eventId) return null;
  const row = await prisma.inngestEventArchive.findFirst({
    where: { OR: [{ id: eventId }, { internalId: eventId }] },
  });
  return row ? mapEventRow(row) : null;
}

/**
 * Runs triggered by an event, from the durable run archive (matched via the
 * triggerEventIds JSON string[] column). Shape mirrors the live client's
 * getEventRuns (/v1/events/:id/runs) so the source resolver can merge them.
 */
export async function listRunsByTriggerEvent(eventId: string): Promise<live.InngestRun[]> {
  if (!eventId) return [];
  const rows = await prisma.inngestRunArchive.findMany({
    where: { triggerEventIds: { contains: eventId } },
    orderBy: [{ startedAt: "desc" }, { runId: "desc" }],
    take: 50,
  });
  return rows.map((r) => ({
    run_id: r.runId,
    run_started_at: r.startedAt?.toISOString(),
    ended_at: r.endedAt?.toISOString() ?? null,
    status: r.status as live.InngestRun["status"],
    output: parseMaybeJson(r.output),
    function_id: r.functionSlug,
    event_id: firstTriggerId(r.triggerEventIds),
  }));
}

/**
 * Last-resort replay source: the trigger event as captured on a run archive
 * row (eventName + eventPayload = the event's data). Covers events that never
 * made it into the event archive (archiver poll gap / outage) but whose runs
 * did — without this, exactly those runs' "重跑" would be impossible.
 */
export async function getTriggerEventFromRuns(
  eventId: string,
): Promise<{ name: string; data: unknown } | null> {
  if (!eventId) return null;
  const row = await prisma.inngestRunArchive.findFirst({
    where: {
      triggerEventIds: { contains: eventId },
      eventName: { not: null },
      eventPayload: { not: null },
    },
    orderBy: [{ startedAt: "desc" }],
    select: { eventName: true, eventPayload: true },
  });
  if (!row?.eventName || !row.eventPayload) return null;
  return { name: row.eventName, data: parseMaybeJson(row.eventPayload) };
}

// Read-path tombstone filter, re-exported here so lib/inngest-source (which
// treats this module as the archive boundary) can hide operator-deleted runs
// that the live Inngest buffer still returns.
export { listTombstonedAmong as listTombstonedRunIds } from "./tombstones";
