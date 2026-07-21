// POST /api/inngest-admin/replay
//   body { eventId: "..." }        → replay one existing event by id
//   body { eventIds: ["...", …] }  → batch replay (monitor 批量重试, max 100)
//   body { name, data }            → send a fresh event
//
// Replays re-emit the original payload. Lookup goes through lib/inngest-source
// (live buffer first, durable Postgres archive fallback) so history that aged
// out of the dev server's lossy event buffer stays replayable.

import { NextResponse } from 'next/server';
import { replayEvent, sendEvent } from '@/lib/inngest-source';
import { writeManageAudit } from '@/lib/manage/audit';

export const dynamic = 'force-dynamic';

const MAX_BATCH = 100;
const BATCH_CONCURRENCY = 5;

type ReplayResult = { eventId: string; ok: boolean; newEventId?: string; error?: string };

async function replayBatch(ids: string[]): Promise<ReplayResult[]> {
  const results: ReplayResult[] = new Array(ids.length);
  let cursor = 0;
  // Small worker pool — replaying re-emits real events; a serial loop would be
  // slow for 100 runs while an unbounded fan-out would hammer the dev server.
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, ids.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= ids.length) return;
        const eventId = ids[i];
        try {
          const res = await replayEvent(eventId);
          results[i] = { eventId, ok: true, newEventId: res.newEventId };
        } catch (err) {
          results[i] = { eventId, ok: false, error: (err as Error).message };
        }
      }
    }),
  );
  return results;
}

export async function POST(req: Request) {
  let body: { eventId?: string; eventIds?: unknown; name?: string; data?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad-json' }, { status: 400 });
  }
  try {
    if (body.eventIds !== undefined) {
      if (!Array.isArray(body.eventIds)) {
        return NextResponse.json({ error: 'eventIds-must-be-array' }, { status: 400 });
      }
      const ids = [...new Set(
        body.eventIds.filter((x): x is string => typeof x === 'string' && x.trim() !== ''),
      )];
      if (ids.length === 0) {
        return NextResponse.json({ error: 'eventIds-empty' }, { status: 400 });
      }
      if (ids.length > MAX_BATCH) {
        return NextResponse.json(
          { error: 'batch-too-large', message: `Batch limit is ${MAX_BATCH} events. Got ${ids.length}.` },
          { status: 400 },
        );
      }
      const results = await replayBatch(ids);
      const replayed = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      // One consolidated audit row per batch (same convention as manage.run.batch.*).
      await writeManageAudit({
        action: 'manage.event.replay.batch',
        traceId: 'batch',
        before: { event_ids: ids },
        after: {
          batch: true,
          requested: ids.length,
          replayed: replayed.map((r) => ({ from: r.eventId, new_event_id: r.newEventId })),
          failed: failed.map((r) => ({ from: r.eventId, error: r.error })),
        },
      });
      return NextResponse.json({
        ok: failed.length === 0,
        requested: ids.length,
        replayed: replayed.length,
        failed: failed.length,
        results,
      });
    }
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
