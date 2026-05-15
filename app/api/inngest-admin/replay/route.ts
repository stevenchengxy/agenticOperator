// POST /api/inngest-admin/replay  body { eventId: "..." }  OR  body { name, data }
// → replay an existing event by id (re-emits with same payload) OR send new event.

import { NextResponse } from 'next/server';
import { replayEvent, sendEvent } from '@/lib/inngest-admin-client';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { eventId?: string; name?: string; data?: unknown };
    if (body.eventId) {
      const res = await replayEvent(body.eventId);
      return NextResponse.json({ ok: true, replayed_from: body.eventId, new_event_id: res.newEventId });
    }
    if (body.name) {
      const res = await sendEvent(body.name, body.data ?? {});
      return NextResponse.json({ ok: true, new_event_id: res.id });
    }
    return NextResponse.json({ error: 'missing-eventId-or-name' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: 'replay-failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}
