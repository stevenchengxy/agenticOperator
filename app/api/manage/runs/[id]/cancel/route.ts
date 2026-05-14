// POST /api/manage/runs/[id]/cancel
//
// Marks a running/paused/suspended run as cancelled (status = interrupted).
// Closes any open HumanTask rows for this run.
// Preconditions: run must be in status running | paused | suspended.
//
// Actor: 'operator-unknown' for v1.
// TODO: Gate this with real session auth once auth middleware is in place.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { writeManageAudit } from '@/lib/manage/audit';
import type { CancelBody } from '@/lib/manage/types';

const CANCELLABLE_STATUSES = new Set(['running', 'paused', 'suspended']);

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const run = await prisma.workflowRun.findUnique({ where: { id } });
    if (!run) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (!CANCELLABLE_STATUSES.has(run.status)) {
      return NextResponse.json(
        { error: 'INVALID_STATUS', message: `Run status '${run.status}' cannot be cancelled. Expected: running, paused, or suspended.` },
        { status: 409 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as CancelBody;
    const now = new Date();

    await prisma.workflowRun.update({
      where: { id },
      data: {
        status: 'interrupted',
        completedAt: now,
        lastActivityAt: now,
      },
    });

    // Close any open HumanTask rows for this run atomically
    await prisma.humanTask.updateMany({
      where: { runId: id, status: 'pending' },
      data: { status: 'cancelled', completedAt: now },
    });

    await writeManageAudit({
      action: 'manage.run.cancel',
      traceId: run.id,
      reason: body.reason,
      before: { status: run.status },
      after: { status: 'interrupted', completedAt: now.toISOString() },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[manage/runs/cancel] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
