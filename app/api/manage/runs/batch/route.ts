// POST /api/manage/runs/batch
//
// Applies cancel | pause | resume to up to 100 runs in a single request.
// NOTE: restart is deliberately excluded from batch operations — each restart
// spawns a new run id which makes bulk semantics confusing and error-prone.
//
// Body: { action: 'cancel' | 'pause' | 'resume', runIds: string[], reason?: string }
// Response: { ok: true, succeeded: string[], failed: { id: string; error: string }[] }
//           AuditLog has payload: { batch: true, runIds, succeeded, failed }
//
// Actor: 'operator-unknown' for v1.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { writeManageAudit } from '@/lib/manage/audit';

type BatchAction = 'cancel' | 'pause' | 'resume';

type BatchBody = {
  action: BatchAction;
  runIds: string[];
  reason?: string;
};

const MAX_BATCH = 100;

// Per-action preconditions (valid starting statuses)
const PRECONDITIONS: Record<BatchAction, Set<string>> = {
  cancel: new Set(['running', 'paused', 'suspended']),
  pause: new Set(['running']),
  resume: new Set(['paused']),
};

// Apply a single action to one run. Returns null on success or an error string.
async function applyOne(action: BatchAction, id: string, reason?: string): Promise<string | null> {
  const run = await prisma.workflowRun.findUnique({ where: { id } });
  if (!run) return 'not_found';

  const allowed = PRECONDITIONS[action];
  if (!allowed.has(run.status)) {
    return `INVALID_STATUS:${run.status}`;
  }

  const now = new Date();

  if (action === 'cancel') {
    await prisma.workflowRun.update({
      where: { id },
      data: { status: 'interrupted', completedAt: now, lastActivityAt: now },
    });
    await prisma.humanTask.updateMany({
      where: { runId: id, status: 'pending' },
      data: { status: 'cancelled', completedAt: now },
    });
  } else if (action === 'pause') {
    await prisma.workflowRun.update({
      where: { id },
      data: { status: 'paused', suspendedReason: reason ?? null, lastActivityAt: now },
    });
  } else {
    // resume
    await prisma.workflowRun.update({
      where: { id },
      data: { status: 'running', suspendedReason: null, lastActivityAt: now },
    });
  }
  return null;
}

export async function POST(req: Request): Promise<Response> {
  let body: BatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST', message: 'Body must be valid JSON.' }, { status: 400 });
  }

  const { action, runIds, reason } = body ?? {};

  if (!['cancel', 'pause', 'resume'].includes(action)) {
    return NextResponse.json(
      { error: 'BAD_REQUEST', message: "action must be 'cancel', 'pause', or 'resume'. restart is not available in batch (each restart spawns a new runId)." },
      { status: 400 },
    );
  }

  if (!Array.isArray(runIds) || runIds.length === 0) {
    return NextResponse.json({ error: 'BAD_REQUEST', message: 'runIds must be a non-empty array.' }, { status: 400 });
  }

  if (runIds.length > MAX_BATCH) {
    return NextResponse.json(
      { error: 'BAD_REQUEST', message: `Batch limit is ${MAX_BATCH} runs. Got ${runIds.length}.` },
      { status: 400 },
    );
  }

  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];

  // Process sequentially to avoid SQLite write contention
  for (const id of runIds) {
    try {
      const err = await applyOne(action, id, reason);
      if (err) {
        failed.push({ id, error: err });
      } else {
        succeeded.push(id);
      }
    } catch (e) {
      failed.push({ id, error: (e as Error).message ?? 'internal' });
    }
  }

  // Write one consolidated AuditLog row for the entire batch
  await writeManageAudit({
    action: `manage.run.batch.${action}`,
    traceId: 'batch',
    reason,
    before: { runIds },
    after: { batch: true, runIds, succeeded, failed },
  });

  return NextResponse.json({ ok: true, succeeded, failed });
}
