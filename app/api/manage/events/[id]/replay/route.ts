// POST /api/manage/events/[id]/replay
//
// Re-publishes a specific EventInstance, triggering downstream consumers again.
// Uses a fresh externalEventId so EM dedup doesn't suppress it.
// No status precondition — any EventInstance can be replayed.
//
// Actor: 'operator-unknown' for v1.
// TODO: Gate this with real session auth once auth middleware is in place.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { em } from '@/server/em';
import { writeManageAudit } from '@/lib/manage/audit';
import type { ReplayBody } from '@/lib/manage/types';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const inst = await prisma.eventInstance.findUnique({ where: { id } });
    if (!inst) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as ReplayBody;

    // Re-publish with a NEW external id so EM dedup doesn't suppress it.
    // causedBy links this replay to the original EventInstance for provenance.
    const result = await em.publish(
      inst.name,
      JSON.parse(inst.payloadSummary ?? '{}'),
      {
        source: 'manage.replay',
        externalEventId: `${inst.id}-replay-${Date.now()}`,
        causedBy: { eventId: inst.id, name: inst.name },
      },
    );

    await writeManageAudit({
      action: 'manage.event.replay',
      traceId: inst.id,
      reason: body.reason,
      before: { name: inst.name, status: inst.status },
      after: { republished: result.accepted, newEventId: result.accepted ? result.eventId : null },
    });

    return NextResponse.json({
      ok: true,
      newEventId: result.accepted ? result.eventId : null,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[manage/events/replay] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
