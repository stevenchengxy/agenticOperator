// 审计日志查询 API — the everything-queryable read over LogEvent.
//   GET /api/log-events?runId=&agent=&traceId=&level=&category=&q=&since=&until=&cursor=&limit=&order=
//   GET /api/log-events?page=&pageSize=... uses numbered pagination + total counts.
// (Named log-events, not logs: .gitignore ignores `logs/`.)
// Filters are all optional; default is the most recent 100 rows by ts desc.
// order=asc + since=<lastTs> is the live-tail mode (审计实时终端 tab polls it
// every 2s; since is inclusive — the client dedupes by row id).
// This is the audit substrate — the curated subset lives at /api/notifications.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { classifyLogFailure } from '@/server/log/failure-classifier';

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
  const pageParam = url.searchParams.get('page');
  const pageSizeParam = url.searchParams.get('pageSize');
  const pageMode = pageParam !== null || pageSizeParam !== null;
  const failureOnly = url.searchParams.get('failureOnly') === '1' || url.searchParams.get('failureOnly') === 'true';
  // payload=full → 完整持久化 payloadJson;默认只回 200 字符预览。
  // 终端 tab 的展开视图需要完整 JSON 才能 pretty-print。
  const fullPayload = url.searchParams.get('payload') === 'full';
  const limit = positiveInt(url.searchParams.get('limit'), 100, 500);
  const pageSize = positiveInt(pageSizeParam, limit, 500);
  const page = positiveInt(pageParam, 1, Number.MAX_SAFE_INTEGER);

  const where: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];
  if (runId) where.runId = runId;
  if (agent) where.agent = agent;
  if (traceId) where.traceId = traceId;
  if (level && level.length) where.level = { in: level };
  if (category && category.length) where.category = { in: category };
  if (q) {
    and.push({ OR: [
      { message: { contains: q, mode: 'insensitive' } },
      { payloadJson: { contains: q, mode: 'insensitive' } },
      { eventName: { contains: q, mode: 'insensitive' } },
    ] });
  }
  if (failureOnly) {
    and.push({
      OR: [
        { level: { in: ['error', 'critical'] } },
        { category: { in: ['dependency', 'anomaly'] } },
        { payloadJson: { contains: '"failure"', mode: 'insensitive' } },
      ],
    });
  }
  const ts: Record<string, Date> = {};
  if (since) ts.gte = new Date(since);
  if (until) ts.lt = new Date(until);
  if (cursor && !pageMode) ts.lt = new Date(cursor); // cursor wins as the upper bound for cursor paging
  if (Object.keys(ts).length) where.ts = ts;
  if (and.length) where.AND = and;

  try {
    const [rows, total] = pageMode
      ? await Promise.all([
          prisma.logEvent.findMany({
            where,
            orderBy: [{ ts: order }, { id: order }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          prisma.logEvent.count({ where }),
        ])
      : [
          await prisma.logEvent.findMany({
            where,
            orderBy: [{ ts: order }, { id: order }],
            take: limit + 1,
          }),
          null,
        ] as const;
    const hasMore = pageMode ? page * pageSize < (total ?? 0) : rows.length > limit;
    const pageRows = pageMode ? rows : hasMore ? rows.slice(0, limit) : rows;
    return NextResponse.json({
      logs: pageRows.map((r) => {
        const failure = classifyLogFailure({
          level: r.level,
          category: r.category,
          source: r.source,
          agent: r.agent,
          eventName: r.eventName,
          message: r.message,
          payloadJson: r.payloadJson,
        });
        return {
          id: r.id,
          ts: r.ts,
          level: r.level,
          category: r.category,
          source: r.source,
          agent: r.agent,
          runId: r.runId,
          traceId: r.traceId,
          eventName: r.eventName,
          kind: r.rawKind,
          anchors: r.anchorsJson ? safeJson(r.anchorsJson) : null,
          message: r.message,
          durationMs: r.durationMs,
          payloadPreview: r.payloadJson ? (fullPayload ? r.payloadJson : r.payloadJson.slice(0, 200)) : null,
          failure,
        };
      }),
      nextCursor: !pageMode && hasMore ? pageRows[pageRows.length - 1]?.ts ?? null : null,
      page: pageMode ? page : undefined,
      pageSize: pageMode ? pageSize : undefined,
      total: total ?? undefined,
      totalPages: total === null ? undefined : Math.max(Math.ceil(total / pageSize), 1),
      hasMore,
      meta: { generatedAt: new Date().toISOString(), failureOnly },
    });
  } catch (e) {
    return NextResponse.json({ logs: [], error: (e as Error).message }, { status: 200 });
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function positiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
}
