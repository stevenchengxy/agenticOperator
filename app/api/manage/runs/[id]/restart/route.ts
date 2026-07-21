// POST /api/manage/runs/[id]/restart
//
// Re-publishes the run's original trigger event, creating a new execution.
// Preconditions: run must be in status failed | completed | timed_out.
// Returns: { ok: true, restarted: eventId | null }
//
// Actor: 'operator-unknown' for v1.
// TODO: Gate this with real session auth once auth middleware is in place.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { em } from '@/server/em';
import { writeManageAudit } from '@/lib/manage/audit';
import type { RestartBody } from '@/lib/manage/types';

const VALID_STATUSES = new Set(['failed', 'completed', 'timed_out']);

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

    if (!VALID_STATUSES.has(run.status)) {
      return NextResponse.json(
        { error: 'INVALID_STATUS', message: `Run status '${run.status}' cannot be restarted. Expected: failed, completed, or timed_out.` },
        { status: 409 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as RestartBody;
    const triggerData = JSON.parse(run.triggerData ?? '{}');

    // Re-publish the original trigger event with a NEW external id so it is
    // not deduped against the original. causedBy links it to this run for
    // causality tracing.
    const result = await em.publish(
      run.triggerEvent,
      { ...triggerData, _replayOf: run.id },
      {
        source: 'manage.restart',
        externalEventId: `${run.id}-restart-${Date.now()}`,
        causedBy: { eventId: run.id, name: run.triggerEvent },
      },
    );

    await writeManageAudit({
      action: 'manage.run.restart',
      traceId: run.id,
      reason: body.reason,
      before: { status: run.status, triggerEvent: run.triggerEvent },
      after: { republished: result.accepted, eventId: result.accepted ? result.eventId : null },
    });

    return NextResponse.json({
      ok: true,
      restarted: result.accepted ? result.eventId : null,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[manage/runs/restart] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
