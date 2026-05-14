import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import type { MonitorQueueResponse } from '@/lib/monitor/types';

const VALID_BUCKETS = ['accepted', 'pending', 'rejected', 'dlq'] as const;
type Bucket = typeof VALID_BUCKETS[number];

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const bucketParam = (url.searchParams.get('bucket') ?? 'accepted') as Bucket;
  if (!VALID_BUCKETS.includes(bucketParam)) {
    return NextResponse.json({ error: 'bad_bucket' }, { status: 400 });
  }
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));

  try {
    if (bucketParam === 'dlq') {
      const [rows, total] = await Promise.all([
        prisma.dLQEntry.findMany({
          orderBy: { createdAt: 'desc' },
          skip: offset, take: limit,
        }),
        prisma.dLQEntry.count(),
      ]);
      const body: MonitorQueueResponse = {
        bucket: 'dlq',
        total,
        offset, limit,
        rows: rows.map(r => ({
          id: r.id,
          eventName: r.eventName,
          reason: r.reason,
          retries: r.retries,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
        })),
      };
      return NextResponse.json(body);
    }

    // EventInstance status values per spec: accepted | rejected_schema |
    // rejected_filter | duplicate | meta_rejection | em_degraded
    const statusFilter = {
      accepted: 'accepted',
      pending:  'pending',       // no canonical "pending" yet — see note
      rejected: { in: ['rejected_schema', 'rejected_filter', 'duplicate', 'meta_rejection'] },
    }[bucketParam] as any;

    const [rows, total] = await Promise.all([
      prisma.eventInstance.findMany({
        where: { status: statusFilter },
        orderBy: { ts: 'desc' },
        skip: offset, take: limit,
      }),
      prisma.eventInstance.count({ where: { status: statusFilter } }),
    ]);

    const body: MonitorQueueResponse = {
      bucket: bucketParam,
      total,
      offset, limit,
      rows: rows.map(r => ({
        id: r.id,
        name: r.name,
        source: r.source,
        status: r.status,
        ts: r.ts.toISOString(),
        rejectionReason: r.rejectionReason ?? undefined,
        schemaErrors: r.schemaErrors ? safeParse(r.schemaErrors) : undefined,
      })),
    };
    return NextResponse.json(body);
  } catch (e) {
    console.error('[/api/monitor/queue] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}
