// GET /api/inngest-admin/runs?fn=<slug>&limit=50
// → list recent runs (optionally filtered to one function slug).

import { NextResponse } from 'next/server';
import { listRecentRuns } from '@/lib/inngest-source';
import { getRunTokenUsage } from '@/lib/monitor/run-token-usage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fn = url.searchParams.get('fn') ?? undefined;
  const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50));

  try {
    const runs = await listRecentRuns({ limit, functionSlug: fn });
    const tokenByRun = await getRunTokenUsage(runs.map((r) => r.id));
    return NextResponse.json({
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt ?? null,
        eventName: r.eventName ?? null,
        eventId: r.eventId ?? null,
        function: r.function,
        durationMs: r.finishedAt
          ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
          : null,
        tokenUsage: tokenByRun[r.id] ?? { prompt: 0, completion: 0, total: 0 },
      })),
      meta: { total: runs.length, generatedAt: new Date().toISOString() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'inngest-admin-failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}
