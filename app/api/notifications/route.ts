// 消息通知中心 API — reads the curated Notification table.
//   GET  /api/notifications?kind=&category=&severity=&needsHuman=&unread=&cursor=&limit=
//   POST /api/notifications   { action: 'read' | 'read_all' | 'ack', id? }
//
// The full log/trace lives in the audit log; this endpoint serves only the
// surfaced message+alert subset for the notification center UI.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { summarizePendingAlerts } from '@/server/notifications/summarize';

/** Resolve a notification's deep-link target (the run/event single process). */
function hrefFor(linkKind: string | null, linkId: string | null): string | null {
  if (!linkId) return null;
  switch (linkKind) {
    case 'rule_check':
      return `/rule-check/audits/${linkId}`;
    case 'run':
      return `/monitor/runs/${linkId}`;
    case 'trace':
      return `/correlations/${linkId}`;
    case 'event':
      return `/events?eventInstanceId=${encodeURIComponent(linkId)}`;
    default:
      return null;
  }
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind'); // message | alert
  const category = url.searchParams.get('category'); // system|agent|event|candidate|job
  const severity = url.searchParams.get('severity')?.split(',').filter(Boolean);
  const needsHuman = url.searchParams.get('needsHuman') === '1';
  const unread = url.searchParams.get('unread') === '1';
  const cursor = url.searchParams.get('cursor'); // ISO ts
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);

  // Lazy-on-view: kick off AI enrichment of un-summarized firing alerts in the
  // background (fire-and-forget — AO runs as a persistent `next start` server,
  // so this completes after the response). The response below returns the
  // deterministic body immediately; AI summaries appear on the next refresh.
  void summarizePendingAlerts(8).catch(() => {});

  const where: Record<string, unknown> = {};
  if (kind === 'message' || kind === 'alert') where.kind = kind;
  if (category) where.category = category;
  if (severity && severity.length) where.severity = { in: severity };
  if (needsHuman) where.disposition = 'needs_human';
  if (unread) where.readAt = null;
  if (cursor) where.ts = { lt: new Date(cursor) };

  try {
    const [rows, byCategory, byKind, needsHumanCount, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { ts: 'desc' }, take: limit + 1 }),
      prisma.notification.groupBy({ by: ['category'], _count: { _all: true } }),
      prisma.notification.groupBy({ by: ['kind'], _count: { _all: true } }),
      prisma.notification.count({ where: { disposition: 'needs_human', readAt: null } }),
      prisma.notification.count({ where: { readAt: null } }),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const notifications = page.map((n) => ({
      id: n.id,
      ts: n.ts,
      kind: n.kind,
      severity: n.severity,
      category: n.category,
      source: n.source,
      title: n.title,
      body: n.aiSummary ?? n.body,
      aiSource: n.aiSource,
      count: n.count,
      disposition: n.disposition,
      managerAction: n.managerAction,
      status: n.status,
      readAt: n.readAt,
      anchors: n.anchorsJson ? safeJson(n.anchorsJson) : null,
      href: hrefFor(n.linkKind, n.linkId),
      runId: n.runId,
      traceId: n.traceId,
    }));

    return NextResponse.json({
      notifications,
      nextCursor: hasMore ? page[page.length - 1]?.ts ?? null : null,
      counts: {
        byCategory: Object.fromEntries(byCategory.map((g) => [g.category, g._count._all])),
        byKind: Object.fromEntries(byKind.map((g) => [g.kind, g._count._all])),
        needsHuman: needsHumanCount,
        unread: unreadCount,
      },
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json(
      { notifications: [], counts: null, error: (e as Error).message },
      { status: 200 },
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: { action?: string; id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const now = new Date();
  try {
    if (body.action === 'read' && body.id) {
      await prisma.notification.update({ where: { id: body.id }, data: { readAt: now } });
      return NextResponse.json({ ok: true });
    }
    if (body.action === 'read_all') {
      const r = await prisma.notification.updateMany({ where: { readAt: null }, data: { readAt: now } });
      return NextResponse.json({ ok: true, updated: r.count });
    }
    if (body.action === 'ack' && body.id) {
      await prisma.notification.update({ where: { id: body.id }, data: { status: 'ack', readAt: now } });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
