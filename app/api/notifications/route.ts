// 消息通知中心 API — reads the curated Notification table.
//   GET  /api/notifications?kind=&category=&severity=&needsHuman=&unread=&cursor=&limit=&domain=
//   POST /api/notifications   { action: 'read' | 'read_all' | 'ack', id? }
//
// The full log/trace lives in the audit log; this endpoint serves only the
// surfaced message+alert subset for the notification center UI.
//
// Domain scope: when `domain` is passed (the active 业务领域 from the AppBar),
// notifications are scoped to that domain — other domains' notifications are
// hidden — EXCEPT category='system' (系统消息), which always shows regardless of
// domain. Null-domain (legacy / cross-domain business) rows are folded into the
// recruitment default so the original recruitment view is unchanged.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { summarizePendingAlerts } from '@/server/notifications/summarize';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';

/** Build the domain-scope where-fragment: system always shows; otherwise scope
 *  to the active domain (recruitment default also absorbs null-domain rows). */
function domainScopeWhere(domain: string | null): Record<string, unknown> {
  if (!domain) return {};
  const isRecruitmentDefault =
    domain === RECRUITMENT_DOMAIN_ID || domain === 'RAAS-v1' || domain === 'raas';
  const or: Record<string, unknown>[] = [{ category: 'system' }, { domain }];
  if (isRecruitmentDefault) or.push({ domain: null });
  return { OR: or };
}

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
  const domain = url.searchParams.get('domain')?.trim() || null; // active 业务领域
  // countsOnly=1 — 轻量徽标模式(LeftNav/AppBar 每 10s 轮询):只回 counts,
  // 不取行、不触发 AI 富化。
  const countsOnly = url.searchParams.get('countsOnly') === '1';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
  const scope = domainScopeWhere(domain);

  // Lazy-on-view: kick off AI enrichment of un-summarized firing alerts in the
  // background (fire-and-forget — AO runs as a persistent `next start` server,
  // so this completes after the response). The response below returns the
  // deterministic body immediately; AI summaries appear on the next refresh.
  // Per-alert failures are logged inside summarizePendingAlerts (the only
  // reachable failure path); it also carries an in-flight guard against the
  // overlapping pollers.
  if (!countsOnly) void summarizePendingAlerts(8).catch(() => {});

  const where: Record<string, unknown> = {};
  if (kind === 'message' || kind === 'alert') where.kind = kind;
  if (category) where.category = category;
  if (severity && severity.length) where.severity = { in: severity };
  if (needsHuman) where.disposition = 'needs_human';
  if (unread) where.readAt = null;
  if (cursor) where.ts = { lt: new Date(cursor) };
  Object.assign(where, scope); // domain scope (system always shown)

  try {
    if (countsOnly) {
      const [needsHumanCount, unreadCount] = await Promise.all([
        prisma.notification.count({ where: { disposition: 'needs_human', readAt: null, ...scope } }),
        prisma.notification.count({ where: { readAt: null, ...scope } }),
      ]);
      return NextResponse.json({
        notifications: [],
        nextCursor: null,
        counts: { byCategory: {}, byKind: {}, needsHuman: needsHumanCount, unread: unreadCount },
        meta: { generatedAt: new Date().toISOString() },
      });
    }
    const [rows, byCategory, byKind, needsHumanCount, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { ts: 'desc' }, take: limit + 1 }),
      prisma.notification.groupBy({ by: ['category'], _count: { _all: true }, where: scope }),
      prisma.notification.groupBy({ by: ['kind'], _count: { _all: true }, where: scope }),
      prisma.notification.count({ where: { disposition: 'needs_human', readAt: null, ...scope } }),
      prisma.notification.count({ where: { readAt: null, ...scope } }),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const notifications = page.map((n) => ({
      id: n.id,
      ts: n.ts,
      kind: n.kind,
      severity: n.severity,
      category: n.category,
      domain: n.domain,
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
  let body: { action?: string; id?: string; domain?: string };
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
      // Scope read_all to the caller's active 业务领域 (same scope the list view
      // shows) — without it, 招聘域点"全部已读"会把能源/费控域的未读一并清掉。
      // No domain passed → legacy behavior (everything), kept for callers that
      // genuinely operate cross-domain.
      const scope = domainScopeWhere(body.domain?.trim() || null);
      const r = await prisma.notification.updateMany({
        where: { readAt: null, ...scope },
        data: { readAt: now },
      });
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
