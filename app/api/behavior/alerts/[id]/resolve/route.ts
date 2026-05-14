// POST /api/behavior/alerts/[id]/resolve
//
// Marks a BehaviorAlert as resolved (resolvedAt = now()).
// Optionally writes an AuditLog row with a note.
//
// Body: { note?: string }
// Response: { ok: true, resolvedAt: string }
//
// Used by the /behavior UI "Resolve" button on each open alert.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { writeManageAudit } from '@/lib/manage/audit';

type ResolveBody = {
  note?: string;
};

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const alert = await prisma.behaviorAlert.findUnique({ where: { id } });
    if (!alert) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (alert.resolvedAt) {
      return NextResponse.json(
        { error: 'ALREADY_RESOLVED', message: `Alert ${id} was already resolved at ${alert.resolvedAt.toISOString()}.` },
        { status: 409 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as ResolveBody;
    const now = new Date();

    await prisma.behaviorAlert.update({
      where: { id },
      data: { resolvedAt: now },
    });

    // Write an audit note if provided
    await writeManageAudit({
      action: 'behavior.alert.resolve',
      traceId: id,
      reason: body.note,
      before: { resolvedAt: null, alertKey: alert.alertKey },
      after: { resolvedAt: now.toISOString() },
    });

    return NextResponse.json({ ok: true, resolvedAt: now.toISOString() });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[behavior/alerts/resolve] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
