// GET /api/inngest-admin/dlq
// → "dead letter queue": all Failed/Cancelled runs.
//
// Inngest dev server doesn't have a native DLQ feature, but failed runs ARE
// the DLQ for practical purposes — they hold the event payload + step trace
// so an operator can inspect + retry.

import { NextResponse } from 'next/server';
import { listRecentRuns } from '@/lib/inngest-source';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 100));
  try {
    const all = await listRecentRuns({ limit: 500 });
    const dead = all.filter((r) => ['Failed', 'Cancelled'].includes(r.status));
    return NextResponse.json({
      dlq: dead.slice(0, limit).map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt ?? null,
        eventId: r.eventId ?? null,
        function: r.function,
        durationMs: r.finishedAt
          ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
          : null,
      })),
      meta: { total: dead.length, generatedAt: new Date().toISOString() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'inngest-admin-failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}
