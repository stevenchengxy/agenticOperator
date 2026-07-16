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
import { notificationHref } from '@/lib/notifications/deep-link';

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
  // 待办列表与徽标同口径:排除已解除的(needs_human 行都是 alert,status 非空)。
  if (needsHuman) {
    where.disposition = 'needs_human';
    where.status = { not: 'resolved' };
  }
  if (unread) where.readAt = null;
  if (cursor) where.lastSeenAt = { lt: new Date(cursor) }; // 翻页游标跟排序键一致
  Object.assign(where, scope); // domain scope (system always shown)

  // 待办口径:needs_human 且未解除(resolved 行不再需要人;needs_human 行都是
  // alert,status 非空,not 'resolved' 安全)。
  const needsHumanWhere = {
    disposition: 'needs_human',
    readAt: null,
    status: { not: 'resolved' },
  } as const;
  // 红点口径:只数 shouldNotify=true 的未读 — 不然 426 条 info 消息让红点常亮
  // 失去信号价值(2026-06-11 审计;spec 2026-06-01:红点语义由 shouldNotify 驱动)。
  const unreadNotifyWhere = { readAt: null, shouldNotify: true } as const;

  try {
    if (countsOnly) {
      const [needsHumanCount, unreadCount, unreadNotifyCount] = await Promise.all([
        prisma.notification.count({ where: { ...needsHumanWhere, ...scope } }),
        prisma.notification.count({ where: { readAt: null, ...scope } }),
        prisma.notification.count({ where: { ...unreadNotifyWhere, ...scope } }),
      ]);
      return NextResponse.json({
        notifications: [],
        nextCursor: null,
        counts: { byCategory: {}, byKind: {}, needsHuman: needsHumanCount, unread: unreadCount, unreadNotify: unreadNotifyCount },
        meta: { generatedAt: new Date().toISOString() },
      });
    }
    const [rows, byCategory, byKind, needsHumanCount, unreadCount, unreadNotifyCount] = await Promise.all([
      // 排序用 lastSeenAt:告警 re-fire 只 bump lastSeenAt 不动 ts,按 ts 排会让
      // 正在 firing 的 critical 被更新的消息埋没(2026-06-11 审计:5 条停滞告警
      // 压在 400+ 行下面);message 的 lastSeenAt 恒等于 ts,排序不变。
      prisma.notification.findMany({ where, orderBy: { lastSeenAt: 'desc' }, take: limit + 1 }),
      prisma.notification.groupBy({ by: ['category'], _count: { _all: true }, where: scope }),
      prisma.notification.groupBy({ by: ['kind'], _count: { _all: true }, where: scope }),
      prisma.notification.count({ where: { ...needsHumanWhere, ...scope } }),
      prisma.notification.count({ where: { readAt: null, ...scope } }),
      prisma.notification.count({ where: { ...unreadNotifyWhere, ...scope } }),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const notifications = page.map((n) => {
      // A re-fired deduped alert updates title/body/lastSeenAt immediately. Do
      // not keep showing an AI summary generated for an older occurrence.
      const aiFresh =
        n.aiSummary != null &&
        n.aiGeneratedAt != null &&
        n.aiGeneratedAt.getTime() >= n.lastSeenAt.getTime();
      return {
        id: n.id,
        ts: n.ts,
        kind: n.kind,
        severity: n.severity,
        category: n.category,
        domain: n.domain,
        source: n.source,
        title: n.title,
        body: aiFresh ? n.aiSummary : n.body,
        aiSource: aiFresh ? n.aiSource : null,
        count: n.count,
        disposition: n.disposition,
        managerAction: n.managerAction,
        status: n.status,
        readAt: n.readAt,
        lastSeenAt: n.lastSeenAt,
        anchors: n.anchorsJson ? safeJson(n.anchorsJson) : null,
        href: notificationHref(n.linkKind, n.linkId),
        runId: n.runId,
        traceId: n.traceId,
      };
    });

    return NextResponse.json({
      notifications,
      nextCursor: hasMore ? page[page.length - 1]?.lastSeenAt ?? null : null,
      counts: {
        byCategory: Object.fromEntries(byCategory.map((g) => [g.category, g._count._all])),
        byKind: Object.fromEntries(byKind.map((g) => [g.kind, g._count._all])),
        needsHuman: needsHumanCount,
        unread: unreadCount,
        unreadNotify: unreadNotifyCount,
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
      // 同 key 的旧 ack 行先删 — 否则第二个 incarnation 翻 'ack' 时撞
      // @@unique([dedupeKey,status]) → P2002 → 500(与 resolveAlerts 同约定)。
      const row = await prisma.notification.findUnique({
        where: { id: body.id },
        select: { dedupeKey: true },
      });
      if (row?.dedupeKey) {
        await prisma.notification.deleteMany({
          where: { dedupeKey: row.dedupeKey, status: 'ack', id: { not: body.id } },
        });
      }
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
