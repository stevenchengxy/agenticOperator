// POST /api/agents/[short]/versions/[id]/deploy
//   → restore this version's config snapshot to AgentConfig,
//     demote previous active version, write AgentConfigHistory.
//
// "Deploy" in Phase 0 = config-layer hot-swap only. Code-layer
// rollback requires git revert + redeploy and is out of scope here.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { AGENT_MAP } from '@/lib/agent-mapping';
import type {
  DeployVersionResponse,
  AgentConfigSnapshot,
  AgentVersionRow,
} from '@/lib/agent-versions/types';

export const dynamic = 'force-dynamic';

function resolveAgent(short: string): { short: string; slug: string } | null {
  const meta = AGENT_MAP.find((a) => a.short === short);
  if (!meta) return null;
  const slug =
    meta.inngestId ??
    short.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() + '-agent';
  return { short: meta.short, slug };
}

function rowToApi(row: {
  id: string;
  short: string;
  slug: string;
  versionLabel: string;
  status: string;
  configJson: string | null;
  configHash: string | null;
  capturedFrom: string | null;
  notes: string | null;
  generatedBy: string;
  createdAt: Date;
  deployedAt: Date | null;
}): AgentVersionRow {
  let snap: AgentConfigSnapshot | null = null;
  if (row.configJson) {
    try {
      snap = JSON.parse(row.configJson);
    } catch {
      /* ignore */
    }
  }
  return {
    id: row.id,
    short: row.short,
    slug: row.slug,
    versionLabel: row.versionLabel,
    status: row.status as 'draft' | 'active' | 'archived',
    configJson: snap,
    configHash: row.configHash,
    capturedFrom: row.capturedFrom,
    notes: row.notes,
    generatedBy: row.generatedBy,
    createdAt: row.createdAt.toISOString(),
    deployedAt: row.deployedAt ? row.deployedAt.toISOString() : null,
  };
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ short: string; id: string }> },
): Promise<Response> {
  const { short, id } = await ctx.params;
  const resolved = resolveAgent(short);
  if (!resolved) {
    return NextResponse.json(
      {
        ok: false,
        error: 'AGENT_NOT_FOUND',
        message: `Short '${short}' not in AGENT_MAP`,
      },
      { status: 404 },
    );
  }

  const target = await prisma.agentVersion.findUnique({ where: { id } });
  if (!target || target.short !== resolved.short) {
    return NextResponse.json(
      {
        ok: false,
        error: 'NOT_FOUND',
        message: `Version '${id}' not found for short '${short}'`,
      },
      { status: 404 },
    );
  }
  if (!target.configJson) {
    return NextResponse.json(
      {
        ok: false,
        error: 'NOT_FOUND',
        message: `Version '${id}' has no configJson to deploy`,
      },
      { status: 400 },
    );
  }

  let snap: AgentConfigSnapshot;
  try {
    snap = JSON.parse(target.configJson);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: 'INTERNAL',
        message: `configJson parse failed: ${(e as Error).message}`,
      },
      { status: 500 },
    );
  }

  try {
    // Capture previous active BEFORE we change anything,
    // so the response can tell the UI what just got demoted.
    const previousActive = await prisma.agentVersion.findFirst({
      where: { short: resolved.short, status: 'active' },
      select: { id: true },
    });

    const result = await prisma.$transaction(async (tx) => {
      // 1. Demote any currently active version(s) for this agent.
      await tx.agentVersion.updateMany({
        where: { short: resolved.short, status: 'active' },
        data: { status: 'archived' },
      });

      // 2. Snapshot the BEFORE AgentConfig (for history audit).
      const before = await tx.agentConfig.findUnique({
        where: { id: resolved.slug },
      });

      // 3. Upsert AgentConfig with the snapshot's fields.
      const after = await tx.agentConfig.upsert({
        where: { id: resolved.slug },
        create: {
          id: resolved.slug,
          enabled: snap.enabled,
          temperature: snap.temperature ?? null,
          maxRetries: snap.maxRetries ?? null,
          tier: snap.tier ?? null,
          maxOutputTokens: snap.maxOutputTokens ?? null,
          promptAppend: snap.promptAppend ?? null,
          skillOverrides: snap.skillOverrides ?? null,
          description: snap.description ?? null,
        },
        update: {
          enabled: snap.enabled,
          temperature: snap.temperature ?? null,
          maxRetries: snap.maxRetries ?? null,
          tier: snap.tier ?? null,
          maxOutputTokens: snap.maxOutputTokens ?? null,
          promptAppend: snap.promptAppend ?? null,
          skillOverrides: snap.skillOverrides ?? null,
          description: snap.description ?? null,
        },
      });

      // 4. Mark target version active.
      const updated = await tx.agentVersion.update({
        where: { id: target.id },
        data: { status: 'active', deployedAt: new Date() },
      });

      // 5. Audit row in AgentConfigHistory (reuses existing pattern).
      await tx.agentConfigHistory.create({
        data: {
          agentId: resolved.slug,
          changedBy: 'operator-unknown',
          before: JSON.stringify(before ?? {}),
          after: JSON.stringify(after),
          reason: `Deploy AgentVersion ${target.versionLabel} (id=${target.id})`,
        },
      });

      return updated;
    });

    const body: DeployVersionResponse = {
      ok: true,
      version: rowToApi(result),
      previousActiveId: previousActive?.id ?? null,
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL', message: (e as Error).message },
      { status: 500 },
    );
  }
}
