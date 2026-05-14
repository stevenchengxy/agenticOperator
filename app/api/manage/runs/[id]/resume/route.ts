// POST /api/manage/runs/[id]/resume
//
// Resumes a paused run (status: paused → running).
// Preconditions: run must be in status paused.
//
// NOTE (v1): This only flips the WorkflowRun.status field. If the underlying
// Inngest function is truly suspended via waitForEvent, emit the resume event
// that the paused step is waiting on (not yet implemented — requires the
// Behavior-axis Manager Agent to know which event to emit per run).
//
// Actor: 'operator-unknown' for v1.
// TODO: Gate this with real session auth once auth middleware is in place.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { writeManageAudit } from '@/lib/manage/audit';
import type { ResumeBody } from '@/lib/manage/types';

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

    if (run.status !== 'paused') {
      return NextResponse.json(
        { error: 'NOT_PAUSED', message: `Run status '${run.status}' cannot be resumed. Only paused runs can be resumed.` },
        { status: 409 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as ResumeBody;
    const now = new Date();

    await prisma.workflowRun.update({
      where: { id },
      data: {
        status: 'running',
        suspendedReason: null,
        lastActivityAt: now,
      },
    });

    await writeManageAudit({
      action: 'manage.run.resume',
      traceId: run.id,
      reason: body.reason,
      before: { status: 'paused' },
      after: { status: 'running' },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[manage/runs/resume] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
