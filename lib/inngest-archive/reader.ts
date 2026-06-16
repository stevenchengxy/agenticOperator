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

type RecentRunResult = Awaited<ReturnType<typeof live.listRecentRuns>>;
type RunHistoryResult = Awaited<ReturnType<typeof live.getRunHistory>>;
type StepOutputsResult = Awaited<ReturnType<typeof live.getRunStepOutputs>>;
type RunsWithEventsResult = Awaited<ReturnType<typeof live.listRunsWithEvents>>;
type EventsResult = Awaited<ReturnType<typeof live.listEvents>>;

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

export async function listRecentRuns(
  opts: { limit?: number; functionSlug?: string; sinceHours?: number } = {},
): Promise<RecentRunResult> {
  const limit = opts.limit ?? 50;
  const sinceHours = opts.sinceHours ?? 24;
  const from = new Date(Date.now() - sinceHours * 3600_000);
  const rows = await prisma.inngestRunArchive.findMany({
    where: {
      startedAt: { gte: from },
      ...(opts.functionSlug ? { functionSlug: opts.functionSlug } : {}),
    },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.runId,
    status: r.status,
    startedAt: r.startedAt?.toISOString() ?? "",
    finishedAt: r.endedAt?.toISOString() ?? undefined,
    function: { name: r.functionName ?? r.functionSlug, slug: r.functionSlug },
    eventName: r.eventName ?? undefined,
    eventId: firstTriggerId(r.triggerEventIds),
  }));
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
    orderBy: { archivedAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    internal_id: r.internalId ?? undefined,
    name: r.name,
    data: parseMaybeJson(r.data),
    ts: r.ts ? r.ts.getTime() : undefined,
    received_at: r.receivedAt?.toISOString() ?? undefined,
  }));
}

export async function listRunsWithEvents(
  functionSlug: string,
  opts: { limit?: number; sinceHours?: number } = {},
): Promise<RunsWithEventsResult> {
  const limit = opts.limit ?? 100;
  const sinceHours = opts.sinceHours ?? 24;
  const from = new Date(Date.now() - sinceHours * 3600_000);
  const rows = await prisma.inngestRunArchive.findMany({
    where: { functionSlug, startedAt: { gte: from } },
    orderBy: { startedAt: "desc" },
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
