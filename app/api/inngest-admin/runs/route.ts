// GET /api/inngest-admin/runs?page=1&pageSize=50&fn=<slug>&domain=&status=&event=&sinceHours=24
// → list recent runs (optionally filtered to one function slug).

import { NextResponse } from 'next/server';
import { listRecentRunsPage } from '@/lib/inngest-source';
import { getRunTokenUsage } from '@/lib/monitor/run-token-usage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fn = url.searchParams.get('fn') ?? undefined;
  const legacyLimit = positiveInt(url.searchParams.get('limit'), 50, 500);
  const page = positiveInt(url.searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(url.searchParams.get('pageSize'), legacyLimit, 500);
  const domain = url.searchParams.get('domain')?.trim() || undefined;
  const statuses = url.searchParams.get('status')
    ?.split(',')
    .map((s) => titleCase(s.trim()))
    .filter(Boolean);
  const eventName = url.searchParams.get('event')?.trim() || undefined;
  const sinceHoursRaw = url.searchParams.get('sinceHours');
  const sinceHours =
    sinceHoursRaw && sinceHoursRaw !== 'all'
      ? Number(sinceHoursRaw)
      : undefined;

  try {
    const result = await listRecentRunsPage({
      page,
      pageSize,
      functionSlug: fn,
      domain,
      status: statuses,
      eventName,
      ...(Number.isFinite(sinceHours) && sinceHours! > 0 ? { sinceHours } : {}),
    });
    const runs = result.items;
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
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
      meta: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
        source: result.source,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'inngest-admin-failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}

function positiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : value;
}
