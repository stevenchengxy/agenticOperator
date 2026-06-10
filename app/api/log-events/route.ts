// 审计日志查询 API — the everything-queryable read over LogEvent.
//   GET /api/log-events?runId=&agent=&traceId=&level=&category=&q=&since=&until=&cursor=&limit=&order=
// (Named log-events, not logs: .gitignore ignores `logs/`.)
// Filters are all optional; default is the most recent 100 rows by ts desc.
// order=asc + since=<lastTs> is the live-tail mode (审计实时终端 tab polls it
// every 2s; since is inclusive — the client dedupes by row id).
// This is the audit substrate — the curated subset lives at /api/notifications.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const runId = url.searchParams.get('runId');
  const agent = url.searchParams.get('agent');
  const traceId = url.searchParams.get('traceId');
  const level = url.searchParams.get('level')?.split(',').filter(Boolean);
  const category = url.searchParams.get('category')?.split(',').filter(Boolean);
  const q = url.searchParams.get('q');
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  const cursor = url.searchParams.get('cursor');
  const order = url.searchParams.get('order') === 'asc' ? ('asc' as const) : ('desc' as const);
  // payload=full → 整段 payloadJson(写入时已截 4000);默认 200 字符预览。
  // 终端 tab 的展开视图需要完整 JSON 才能 pretty-print。
  const fullPayload = url.searchParams.get('payload') === 'full';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);

  const where: Record<string, unknown> = {};
  if (runId) where.runId = runId;
  if (agent) where.agent = agent;
  if (traceId) where.traceId = traceId;
  if (level && level.length) where.level = { in: level };
  if (category && category.length) where.category = { in: category };
  if (q) where.message = { contains: q, mode: 'insensitive' };
  const ts: Record<string, Date> = {};
  if (since) ts.gte = new Date(since);
  if (until) ts.lt = new Date(until);
  if (cursor) ts.lt = new Date(cursor); // cursor wins as the upper bound for paging
  if (Object.keys(ts).length) where.ts = ts;

  try {
    const rows = await prisma.logEvent.findMany({
      where,
      orderBy: { ts: order },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return NextResponse.json({
      logs: page.map((r) => ({
        id: r.id,
        ts: r.ts,
        level: r.level,
        category: r.category,
        source: r.source,
        agent: r.agent,
        runId: r.runId,
        traceId: r.traceId,
        eventName: r.eventName,
        message: r.message,
        durationMs: r.durationMs,
        payloadPreview: r.payloadJson ? (fullPayload ? r.payloadJson : r.payloadJson.slice(0, 200)) : null,
      })),
      nextCursor: hasMore ? page[page.length - 1]?.ts ?? null : null,
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json({ logs: [], error: (e as Error).message }, { status: 200 });
  }
}
