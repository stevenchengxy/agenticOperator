// Archive writer — persists Inngest data into the Postgres mirror tables.
// Used by scripts/inngest-archiver.ts. Relative imports keep it tsx-runnable.
import { prisma } from "../../server/db";
import type { InngestEvent } from "../inngest-admin-client";
import {
  eventToRow,
  runToCreate,
  runToUpdate,
  historyToStepRows,
  runTraceFields,
  type RecentRun,
  type RunHistory,
} from "./mappers";

/** Insert any new events. Events are immutable, so skipDuplicates is correct. */
export async function archiveEvents(events: InngestEvent[]): Promise<number> {
  const rows = events.filter((e) => e?.id).map(eventToRow);
  if (rows.length === 0) return 0;
  const res = await prisma.inngestEventArchive.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return res.count;
}

export type RunSyncState = { status: string; traceFetched: boolean };

/** Map<runId, {status, traceFetched}> for every archived run. */
export async function readRunSyncState(): Promise<Map<string, RunSyncState>> {
  const rows = await prisma.inngestRunArchive.findMany({
    select: { runId: true, status: true, traceFetched: true },
  });
  return new Map(rows.map((r) => [r.runId, { status: r.status, traceFetched: r.traceFetched }]));
}

/** Create or update a run's scalar/timing fields (never touches traceFetched). */
export async function upsertRun(run: RecentRun): Promise<void> {
  await prisma.inngestRunArchive.upsert({
    where: { runId: run.id },
    create: runToCreate(run),
    update: runToUpdate(run),
  });
}

/**
 * Persist a run's full step trace + run-level output/payload, marking
 * traceFetched=true. Step rows are replaced wholesale (delete + insert) so
 * re-fetches are idempotent regardless of span ordering. Returns step count.
 */
export async function archiveRunTrace(runId: string, history: RunHistory): Promise<number> {
  const steps = historyToStepRows(runId, history);
  await prisma.$transaction([
    prisma.inngestRunArchive.update({
      where: { runId },
      data: runTraceFields(runId, history),
    }),
    prisma.inngestStepArchive.deleteMany({ where: { runId } }),
    ...(steps.length
      ? [prisma.inngestStepArchive.createMany({ data: steps, skipDuplicates: true })]
      : []),
  ]);
  return steps.length;
}

/** Heartbeat: bump cursor poll time + cumulative counts (or record an error). */
export async function updateCursor(stats: {
  events: number;
  runs: number;
  steps: number;
  error?: string;
}): Promise<void> {
  const now = new Date();
  await prisma.inngestArchiveCursor.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      lastPollAt: now,
      lastSuccessAt: stats.error ? null : now,
      eventsArchived: stats.events,
      runsArchived: stats.runs,
      stepsArchived: stats.steps,
      lastError: stats.error ?? null,
      lastErrorAt: stats.error ? now : null,
    },
    update: {
      lastPollAt: now,
      eventsArchived: { increment: stats.events },
      runsArchived: { increment: stats.runs },
      stepsArchived: { increment: stats.steps },
      ...(stats.error
        ? { lastError: stats.error, lastErrorAt: now }
        : { lastSuccessAt: now, lastError: null }),
    },
  });
}
