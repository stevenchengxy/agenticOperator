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

/** Persist freshly-sent events. `ids` come from inngest.send()'s return value. */
export async function recordSentEvents(
  payloads: { name: string; data?: unknown; ts?: number }[],
  ids: string[],
): Promise<number> {
  const events: InngestEvent[] = payloads
    .map((p, i) => ({ id: ids[i], name: p.name, data: p.data ?? null, ts: p.ts }))
    .filter((e): e is InngestEvent => Boolean(e.id));
  if (events.length === 0) return 0;
  return archiveEvents(events);
}

/** Create the run row as Running on its first request. Never downgrades status. */
export async function recordRunStart(args: {
  runId: string;
  functionSlug: string;
  functionName: string;
  startedAtIso: string;
  eventName?: string;
  eventId?: string;
}): Promise<void> {
  const startedAt = toDate(args.startedAtIso);
  await prisma.inngestRunArchive.upsert({
    where: { runId: args.runId },
    create: {
      runId: args.runId,
      functionSlug: args.functionSlug,
      functionName: args.functionName,
      status: "Running",
      startedAt,
      eventName: args.eventName ?? null,
      triggerEventIds: args.eventId ? JSON.stringify([args.eventId]) : null,
    },
    // Row already exists (e.g. poller raced): refresh metadata, leave status alone.
    update: {
      functionSlug: args.functionSlug,
      functionName: args.functionName,
      startedAt,
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
  await prisma.inngestRunArchive.upsert({
    where: { runId: args.runId },
    create: {
      runId: args.runId,
      functionSlug: args.functionSlug,
      functionName: args.functionName,
      status: args.status,
      endedAt,
      durationMs,
      output,
      eventName,
      triggerEventIds,
    },
    update: { status: args.status, endedAt, durationMs, output, eventName },
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
