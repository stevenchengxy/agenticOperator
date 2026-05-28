// POST /api/inngest-admin/replay  body { eventId: "..." }  OR  body { name, data }
// → replay an existing event by id (re-emits with same payload) OR send new event.

import { NextResponse } from 'next/server';
import { replayEvent, sendEvent } from '@/lib/inngest-admin-client';
import { writeManageAudit } from '@/lib/manage/audit';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { eventId?: string; name?: string; data?: unknown };
    if (body.eventId) {
      const res = await replayEvent(body.eventId);
      // 2026-05-27 — 监控页「重跑」按钮走这个端点(不是 /api/manage/*),之前不写
      // 审计 → 操作审计 tab 一直空. 补上,让重放也留运维审计痕迹.
      await writeManageAudit({
        action: 'manage.event.replay',
        traceId: body.eventId,
        before: { source_event_id: body.eventId },
        after: { new_event_id: res.newEventId },
      });
      return NextResponse.json({ ok: true, replayed_from: body.eventId, new_event_id: res.newEventId });
    }
    if (body.name) {
      const res = await sendEvent(body.name, body.data ?? {});
      await writeManageAudit({
        action: 'manage.event.replay',
        traceId: res.id,
        before: { event_name: body.name },
        after: { new_event_id: res.id },
      });
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
