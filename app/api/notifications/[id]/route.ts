// GET /api/notifications/[id] — one notification + the detailed logs behind it.
//
// Powers the notification detail drawer: the curated row, plus the correlated
// raw LogEvent rows (by run / trace / agent / time-window — see correlate.ts)
// so a human can read the underlying error and locate the problem. Also returns
// the deep-link href. Pure correlation logic lives in correlate.ts (unit-tested);
// this route just runs the query and shapes the response.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { buildLogQuery } from '@/server/notifications/correlate';

/** Resolve a notification's deep-link target (mirrors the list route). */
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
    case 'infra':
      return `/monitor?infra=${encodeURIComponent(linkId)}`;
    default:
      return null;
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const n = await prisma.notification.findUnique({ where: { id } });
    if (!n) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

    const query = buildLogQuery({
      runId: n.runId,
      traceId: n.traceId,
      agent: n.agent,
      firstSeenAt: n.firstSeenAt,
      lastSeenAt: n.lastSeenAt,
    });
    const logs = await prisma.logEvent.findMany(query);

    return NextResponse.json({
      ok: true,
      notification: {
        id: n.id,
        ts: n.ts,
        kind: n.kind,
        severity: n.severity,
        category: n.category,
        source: n.source,
        title: n.title,
        body: n.body,
        aiSummary: n.aiSummary,
        aiSource: n.aiSource,
        llmModel: n.llmModel,
        count: n.count,
        firstSeenAt: n.firstSeenAt,
        lastSeenAt: n.lastSeenAt,
        status: n.status,
        disposition: n.disposition,
        managerAction: n.managerAction,
        readAt: n.readAt,
        runId: n.runId,
        traceId: n.traceId,
        agent: n.agent,
      },
      href: hrefFor(n.linkKind, n.linkId),
      logs: logs.map((l) => ({
        id: l.id,
        ts: l.ts,
        level: l.level,
        category: l.category,
        source: l.source,
        agent: l.agent,
        message: l.message,
        payloadJson: l.payloadJson,
      })),
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
