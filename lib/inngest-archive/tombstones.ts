// Run tombstones — make operator deletion stick.
//
// The live Inngest dev server has no run-deletion API (only cancelRun/rerun),
// and deleted archive rows would come back through two writers: the polling
// archiver (scripts/inngest-archiver.ts → writer.ts) and the in-process
// write-through middleware. So 监控页「删除」does two things atomically:
// write a tombstone, then delete the archive row (steps cascade). Writers
// consult the tombstone before upserting; the live-merge read path
// (lib/inngest-source.ts) filters tombstoned ids out of live results.
//
// Known micro-race: an upsert that passed the tombstone check just before the
// tombstone commits can land after the delete and linger. The window is
// milliseconds against a ~30s poll cadence; the next operator delete clears it.
import { prisma } from "../../server/db";

/** Record tombstones for runIds (idempotent). */
export async function addRunTombstones(runIds: string[]): Promise<void> {
  const ids = [...new Set(runIds.filter(Boolean))];
  if (ids.length === 0) return;
  await prisma.inngestRunTombstone.createMany({
    data: ids.map((runId) => ({ runId })),
    skipDuplicates: true,
  });
}

/** Of the given ids, the ones that are tombstoned (for read-path filtering). */
export async function listTombstonedAmong(runIds: string[]): Promise<string[]> {
  const ids = [...new Set(runIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await prisma.inngestRunTombstone.findMany({
    where: { runId: { in: ids } },
    select: { runId: true },
  });
  return rows.map((r) => r.runId);
}

/** True when this single runId is tombstoned — the writers' guard. */
export async function isRunTombstoned(runId: string): Promise<boolean> {
  if (!runId) return false;
  const row = await prisma.inngestRunTombstone.findUnique({
    where: { runId },
    select: { runId: true },
  });
  return row != null;
}

/**
 * Tombstone + delete archive rows for the given runIds, in that order inside
 * one transaction (tombstone-first closes the writer resurrection window).
 * Step rows cascade via the InngestStepArchive FK. Returns the archive-row
 * delete count (ids that were live-only still get tombstoned and hidden).
 */
export async function tombstoneAndDeleteRuns(runIds: string[]): Promise<{ deleted: number }> {
  const ids = [...new Set(runIds.filter(Boolean))];
  if (ids.length === 0) return { deleted: 0 };
  const [, del] = await prisma.$transaction([
    prisma.inngestRunTombstone.createMany({
      data: ids.map((runId) => ({ runId })),
      skipDuplicates: true,
    }),
    prisma.inngestRunArchive.deleteMany({ where: { runId: { in: ids } } }),
  ]);
  return { deleted: del.count };
}
