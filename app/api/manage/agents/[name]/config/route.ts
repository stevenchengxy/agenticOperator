// POST /api/manage/agents/[name]/config
//
// Upserts an AgentConfig row for the given agent name.
// Writes an AgentConfigHistory row and an AuditLog row on every successful save.
//
// Editable fields in v1: temperature, maxRetries, promptAppend.
// Note: tier and maxOutputTokens are also accepted but per spec §3.6 they
// require a deployment change for full effect. They are stored here but UI
// should note this.
//
// Actor: 'operator-unknown' for v1.
// TODO: Gate this with real session auth once auth middleware is in place.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { writeManageAudit } from '@/lib/manage/audit';
import type { AgentConfigBody } from '@/lib/manage/types';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await ctx.params;
  try {
    const body = (await req.json().catch(() => null)) as AgentConfigBody | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'VALIDATION', message: 'Request body must be a JSON object.' }, { status: 400 });
    }

    // Validate numeric ranges for editable fields
    if (body.temperature !== undefined && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2)) {
      return NextResponse.json({ error: 'VALIDATION', message: 'temperature must be a number between 0 and 2.' }, { status: 400 });
    }
    if (body.maxRetries !== undefined && (typeof body.maxRetries !== 'number' || body.maxRetries < 0 || body.maxRetries > 10 || !Number.isInteger(body.maxRetries))) {
      return NextResponse.json({ error: 'VALIDATION', message: 'maxRetries must be an integer between 0 and 10.' }, { status: 400 });
    }

    // Snapshot current config for audit before/after comparison
    const before = await prisma.agentConfig.findUnique({ where: { id: name } });

    // Build the update payload — only include fields that were supplied
    const updateData: {
      temperature?: number | null;
      maxRetries?: number | null;
      tier?: string | null;
      maxOutputTokens?: number | null;
      promptAppend?: string | null;
    } = {};

    if (body.temperature !== undefined) updateData.temperature = body.temperature;
    if (body.maxRetries !== undefined) updateData.maxRetries = body.maxRetries;
    if (body.tier !== undefined) updateData.tier = body.tier || null;
    if (body.maxOutputTokens !== undefined) updateData.maxOutputTokens = body.maxOutputTokens;
    if ('promptAppend' in body) updateData.promptAppend = body.promptAppend ?? null;

    const after = await prisma.agentConfig.upsert({
      where: { id: name },
      create: { id: name, ...updateData },
      update: updateData,
    });

    // Write history row
    await prisma.agentConfigHistory.create({
      data: {
        agentId: name,
        changedBy: 'operator-unknown', // TODO: real auth
        before: JSON.stringify(before ?? {}),
        after: JSON.stringify(after),
        reason: body.reason ?? null,
      },
    });

    await writeManageAudit({
      action: 'manage.agent.config',
      traceId: name,
      reason: body.reason,
      before,
      after,
    });

    return NextResponse.json({ ok: true, config: after });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[manage/agents/config] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
