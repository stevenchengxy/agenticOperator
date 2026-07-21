// POST /api/manage/runs/[id]/pause
//
// Marks a running run as paused (status = paused).
// Preconditions: run must be in status running.
//
// NOTE (v1): This only flips the WorkflowRun.status field. The stub agents
// do not yet poll for the PauseFlag at step boundaries. The Behavior-axis
// Manager Agent will gate event dispatch by checking run status as a
// follow-up (Phase 3 of the Manage spec). For full suspend semantics,
// a waitForEvent/PauseFlag mechanism should be added to each agent function.
//
// Actor: 'operator-unknown' for v1.
// TODO: Gate this with real session auth once auth middleware is in place.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { writeManageAudit } from '@/lib/manage/audit';
import type { PauseBody } from '@/lib/manage/types';

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

    if (run.status !== 'running') {
      return NextResponse.json(
        { error: 'INVALID_STATUS', message: `Run status '${run.status}' cannot be paused. Only running runs can be paused.` },
        { status: 409 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as PauseBody;
    const now = new Date();

    await prisma.workflowRun.update({
      where: { id },
      data: {
        status: 'paused',
        suspendedReason: body.reason ?? null,
        lastActivityAt: now,
      },
    });

    await writeManageAudit({
      action: 'manage.run.pause',
      traceId: run.id,
      reason: body.reason,
      before: { status: run.status },
      after: { status: 'paused' },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[manage/runs/pause] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
