// POST /api/inngest-admin/runs/delete  body { runIds: string[] }
// → 监控页「删除」: remove runs from the durable archive (steps cascade) and
//   tombstone them so neither the polling archiver, the write-through
//   middleware, nor the live-merge read path resurrects them. The live Inngest
//   dev server has no run-deletion API, so tombstone-and-hide is the only
//   durable delete semantics available.
//
// Running runs are rejected per-item: hiding a run that is still executing
// (and still consuming resources) would just make it invisible, not gone —
// cancel it first, then delete.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { tombstoneAndDeleteRuns } from '@/lib/inngest-archive/tombstones';
import { writeManageAudit } from '@/lib/manage/audit';

export const dynamic = 'force-dynamic';

const MAX_BATCH = 100;

type DeleteResult = { runId: string; ok: boolean; error?: string };

export async function POST(req: Request) {
  let body: { runIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad-json' }, { status: 400 });
  }
  if (!Array.isArray(body.runIds)) {
    return NextResponse.json({ error: 'runIds-must-be-array' }, { status: 400 });
  }
  const ids = [...new Set(
    body.runIds.filter((x): x is string => typeof x === 'string' && x.trim() !== ''),
  )];
  if (ids.length === 0) {
    return NextResponse.json({ error: 'runIds-empty' }, { status: 400 });
  }
  if (ids.length > MAX_BATCH) {
    return NextResponse.json(
      { error: 'batch-too-large', message: `Batch limit is ${MAX_BATCH} runs. Got ${ids.length}.` },
      { status: 400 },
    );
  }

  try {
    // Archive status is write-through-fresh; a run the archive has never seen
    // (live-only) has no status to check — deleting it is the operator's call.
    const rows = await prisma.inngestRunArchive.findMany({
      where: { runId: { in: ids } },
      select: { runId: true, status: true },
    });
    const statusById = new Map(rows.map((r) => [r.runId, r.status]));
    const results: DeleteResult[] = ids.map((runId) => {
      if (statusById.get(runId) === 'Running') {
        return { runId, ok: false, error: 'run-still-running' };
      }
      return { runId, ok: true };
    });
    const deletable = results.filter((r) => r.ok).map((r) => r.runId);
    if (deletable.length > 0) {
      await tombstoneAndDeleteRuns(deletable);
    }
    const rejected = results.filter((r) => !r.ok);
    await writeManageAudit({
      action: 'manage.run.delete.batch',
      traceId: 'batch',
      before: { run_ids: ids },
      after: {
        batch: true,
        requested: ids.length,
        deleted: deletable,
        rejected,
      },
    });
    return NextResponse.json({
      ok: rejected.length === 0,
      requested: ids.length,
      deleted: deletable.length,
      rejected: rejected.length,
      results,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'delete-failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}
