// GET /api/manage/audit
//
// Query AuditLog rows with optional filters.
// Query params:
//   ?action=   filter by eventName (exact match)
//   ?traceId=  filter by traceId (runId, eventId, or agent name)
//   ?since=    ISO date string — only rows created at or after this time
//   ?limit=    default 50, max 200
//   ?offset=   for pagination, default 0
//
// Response: { rows: AuditLogRow[], total: number, limit: number, offset: number }
// Sorted by createdAt desc (newest first).

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') ?? undefined;
  const traceId = url.searchParams.get('traceId') ?? undefined;
  const since = url.searchParams.get('since') ?? undefined;
  const rawLimit = parseInt(url.searchParams.get('limit') ?? `${DEFAULT_LIMIT}`, 10);
  const rawOffset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? DEFAULT_LIMIT : rawLimit, MAX_LIMIT);
  const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  // Build where clause
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  if (action) where.eventName = action;
  if (traceId) where.traceId = traceId;
  if (since) {
    const sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      return NextResponse.json(
        { error: 'BAD_REQUEST', message: `'since' must be a valid ISO date string.` },
        { status: 400 },
      );
    }
    where.createdAt = { gte: sinceDate };
  }

  try {
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return NextResponse.json({
      rows: rows.map((r) => ({
        id: r.id,
        action: r.eventName,
        traceId: r.traceId,
        payload: r.payload,
        source: r.source,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      limit,
      offset,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[manage/audit] query failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
