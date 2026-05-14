// POST /api/manage/agents/[name]/throttle
//
// Sets AgentConfig.throttleUntil = now + untilMs so the stub-factory
// will sleep until that time before processing any new events.
//
// Body: { untilMs: number, reason?: string }
//   untilMs: milliseconds from now to throttle. Max 3600000 (1h).
// Response: { ok: true, throttleUntil: string (ISO), agentName: string }
//
// The stub-factory checks this field at the start of its handler. If
// throttleUntil > now, it sleeps until throttleUntil before proceeding
// and logs an info activity row noting the throttle.
//
// Actor: 'operator-unknown' for v1.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { writeManageAudit } from '@/lib/manage/audit';

const MAX_THROTTLE_MS = 3_600_000; // 1 hour

type ThrottleBody = {
  untilMs: number;
  reason?: string;
};

export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await ctx.params;
  try {
    const body = (await req.json().catch(() => null)) as ThrottleBody | null;

    if (!body || typeof body.untilMs !== 'number' || body.untilMs <= 0) {
      return NextResponse.json(
        { error: 'BAD_REQUEST', message: 'untilMs must be a positive number (milliseconds from now).' },
        { status: 400 },
      );
    }

    if (body.untilMs > MAX_THROTTLE_MS) {
      return NextResponse.json(
        { error: 'BAD_REQUEST', message: `untilMs exceeds maximum of ${MAX_THROTTLE_MS}ms (1 hour).` },
        { status: 400 },
      );
    }

    const throttleUntil = new Date(Date.now() + body.untilMs);
    const throttleReason = body.reason ?? null;

    // Snapshot before for audit
    const before = await prisma.agentConfig.findUnique({ where: { id: name } });

    // Upsert — create the config row if it doesn't exist yet
    const after = await prisma.agentConfig.upsert({
      where: { id: name },
      create: { id: name, throttleUntil, throttleReason },
      update: { throttleUntil, throttleReason },
    });

    await writeManageAudit({
      action: 'manage.agent.throttle',
      traceId: name,
      reason: body.reason,
      before: before ? { throttleUntil: before.throttleUntil, throttleReason: before.throttleReason } : null,
      after: { throttleUntil: after.throttleUntil, throttleReason: after.throttleReason },
    });

    return NextResponse.json({
      ok: true,
      agentName: name,
      throttleUntil: throttleUntil.toISOString(),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[manage/agents/throttle] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
