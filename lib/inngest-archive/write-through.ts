// Write-through persistence: archive Inngest events/runs into Postgres at the
// moment they happen (called from the Inngest middleware), so nothing is lost
// when the ephemeral Inngest dev server restarts. Writes the SAME archive tables
// the 30s poller writes, idempotently — the poller is now a reconciliation net.
//
// Relative imports (not @/) so this stays runnable under tsx alongside the
// archiver, matching writer.ts / mappers.ts.
import { prisma } from "../../server/db";
import type { InngestEvent } from "../inngest-admin-client";
import { getRunHistory } from "../inngest-admin-client";
import { archiveEvents, archiveRunTrace } from "./writer";
import { toDate, safeJson, type RunHistory } from "./mappers";
import { inferRunDomain } from "../events/domain-scope";

export type TriggerEventSnapshot = {
  id?: string;
  name?: string;
  data?: unknown;
  ts?: number;
  received_at?: string;
  sourceApp?: string | null;
  source_app?: string | null;
};

/** Persist freshly-sent events. `ids` come from inngest.send()'s return value. */
export async function recordSentEvents(
  payloads: { name: string; data?: unknown; ts?: number; sourceApp?: string | null }[],
  ids: string[],
): Promise<number> {
  const events: InngestEvent[] = [];
  payloads.forEach((p, i) => {
    const id = ids[i];
    if (!id) return;
    const ev: InngestEvent = {
      id,
      name: p.name,
      data: p.data ?? null,
      sourceApp: p.sourceApp ?? null,
    };
    if (p.ts !== undefined) ev.ts = p.ts;
    events.push(ev);
  });
  if (events.length === 0) return 0;
  return archiveEvents(events);
}

/** Create the run row as Running on its first request. Never downgrades status. */
export async function recordRunStart(args: {
  runId: string;
  functionSlug: string;
  functionName: string;
  startedAtIso: string;
  appId?: string;
  eventName?: string;
  eventId?: string;
  event?: TriggerEventSnapshot;
}): Promise<void> {
  const startedAt = toDate(args.startedAtIso);
  const eventId = args.event?.id ?? args.eventId;
  const eventName = args.event?.name ?? args.eventName;
  const eventPayload = args.event && "data" in args.event ? safeJson(args.event.data) : null;
  const appId = args.appId ?? null;
  const domain = inferRunDomain({
    appId,
    functionSlug: args.functionSlug,
    eventName,
  });

  // Events entering Inngest from an external producer never pass AO's
  // wrapSendEvent hook. Persist the triggering event from onRunStart as a
  // second, idempotent write-through path so the polling window cannot lose it.
  if (eventId && eventName) {
    await archiveEvents([
      {
        id: eventId,
        name: eventName,
        data: args.event?.data ?? null,
        ts: args.event?.ts,
        received_at: args.event?.received_at ?? args.startedAtIso,
        sourceApp: args.event?.sourceApp ?? args.event?.source_app ?? null,
      },
    ]);
  }
  await prisma.inngestRunArchive.upsert({
    where: { runId: args.runId },
    create: {
      runId: args.runId,
      functionSlug: args.functionSlug,
      functionName: args.functionName,
      appId,
      domain,
      status: "Running",
      startedAt,
      eventName: eventName ?? null,
      triggerEventIds: eventId ? JSON.stringify([eventId]) : null,
      eventPayload,
    },
    // Row already exists (e.g. poller raced): refresh metadata, leave status alone.
    update: {
      functionSlug: args.functionSlug,
      functionName: args.functionName,
      appId,
      domain,
      startedAt,
      ...(eventName ? { eventName } : {}),
      ...(eventId ? { triggerEventIds: JSON.stringify([eventId]) } : {}),
      ...(eventPayload !== null ? { eventPayload } : {}),
    },
  });
}

/** Write the terminal status + output directly (lossless, no network). */
export async function recordRunFinish(args: {
  runId: string;
  functionSlug: string;
  functionName: string;
  status: "Completed" | "Failed" | "Cancelled";
  finishedAtIso: string;
  output: unknown;
  appId?: string;
  eventData?: unknown;
  eventName?: string;
  eventId?: string;
}): Promise<void> {
  const endedAt = toDate(args.finishedAtIso);
  const existing = await prisma.inngestRunArchive.findUnique({
    where: { runId: args.runId },
    select: { startedAt: true },
  });
  const durationMs =
    existing?.startedAt && endedAt
      ? endedAt.getTime() - existing.startedAt.getTime()
      : null;
  const output = safeJson(args.output);
  const eventName = args.eventName ?? null;
  const triggerEventIds = args.eventId ? JSON.stringify([args.eventId]) : null;
  const appId = args.appId ?? null;
  const domain = inferRunDomain({ appId, functionSlug: args.functionSlug, eventName });
  const eventPayload = safeJson(args.eventData);
  await prisma.inngestRunArchive.upsert({
    where: { runId: args.runId },
    create: {
      runId: args.runId,
      functionSlug: args.functionSlug,
      functionName: args.functionName,
      appId,
      domain,
      status: args.status,
      endedAt,
      durationMs,
      output,
      eventName,
      triggerEventIds,
      eventPayload,
    },
    update: {
      status: args.status,
      endedAt,
      durationMs,
      output,
      eventName,
      appId,
      domain,
      ...(triggerEventIds ? { triggerEventIds } : {}),
      ...(eventPayload !== null ? { eventPayload } : {}),
    },
  });
}

/**
 * Immediately snapshot the run's step trace (steps were recorded by Inngest in
 * prior requests, so they're available now). Reuses archiveRunTrace (canonical
 * `#${i}` step ids, sets traceFetched=true). Status/output are FORCED to the
 * known-terminal values so a not-yet-terminal live fetch can't clobber them.
 * Best-effort: on any failure the row stays traceFetched=false and the poller
 * backstops the steps.
 */
export async function captureRunTrace(args: {
  runId: string;
  status: string;
  output: unknown;
  finishedAtIso: string;
}): Promise<number> {
  const history = (await getRunHistory(args.runId)) as RunHistory | null;
  if (!history) return 0;
  return archiveRunTrace(args.runId, {
    ...history,
    status: args.status,
    output: args.output,
    finishedAt: args.finishedAtIso,
  });
}
