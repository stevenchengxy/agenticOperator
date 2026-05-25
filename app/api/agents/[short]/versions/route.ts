// GET /api/agents/[short]/versions
//   → list all versions of an agent, descending by createdAt
//
// POST /api/agents/[short]/versions
//   → capture current AgentConfig as a new AgentVersion row

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { AGENT_MAP } from '@/lib/agent-mapping';
import {
  snapshotAgentConfig,
  hashSnapshot,
  generateVersionLabel,
} from '@/lib/agent-versions/snapshot';
import type {
  VersionsListResponse,
  AgentVersionRow,
  AgentConfigSnapshot,
  CaptureVersionRequest,
} from '@/lib/agent-versions/types';

export const dynamic = 'force-dynamic';

/**
 * Resolve a short code from AGENT_MAP → (short, slug) pair.
 * slug = inngestId if present, else `<kebab-short>-agent` convention.
 * Returns null if short is not in AGENT_MAP.
 */
function resolveAgent(short: string): { short: string; slug: string } | null {
  const meta = AGENT_MAP.find((a) => a.short === short);
  if (!meta) return null;
  const slug =
    meta.inngestId ??
    short.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() + '-agent';
  return { short: meta.short, slug };
}

function dbRowToApiRow(row: {
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
  codeBlob?: string | null;
}): AgentVersionRow {
  let snap: AgentConfigSnapshot | null = null;
  if (row.configJson) {
    try {
      snap = JSON.parse(row.configJson) as AgentConfigSnapshot;
    } catch {
      snap = null;
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
    // Codegen rows carry the generated TypeScript so the Open-PR dialog
    // can render it without an extra fetch. Other rows leave it null.
    codeBlob: row.capturedFrom === 'codegen' ? row.codeBlob ?? null : null,
  };
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ short: string }> },
): Promise<Response> {
  const { short } = await ctx.params;
  const resolved = resolveAgent(short);
  if (!resolved) {
    return NextResponse.json(
      { error: 'AGENT_NOT_FOUND', message: `Short '${short}' not in AGENT_MAP` },
      { status: 404 },
    );
  }

  try {
    const rows = await prisma.agentVersion.findMany({
      where: { short: resolved.short },
      orderBy: { createdAt: 'desc' },
    });
    const versions = rows.map(dbRowToApiRow);
    const active = versions.find((v) => v.status === 'active') ?? null;
    const body: VersionsListResponse = {
      versions,
      activeVersionId: active?.id ?? null,
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: 'INTERNAL', message: (e as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ short: string }> },
): Promise<Response> {
  const { short } = await ctx.params;
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

  const body = ((await req.json().catch(() => ({}))) ?? {}) as CaptureVersionRequest;

  try {
    // Branch on capture source. codegen-supplied artifacts get persisted
    // directly; otherwise we snapshot the live AgentConfig (legacy path).
    if (body.codegen) {
      const { codeBlob, specJson, promptText, modelUsed } = body.codegen;
      const codeHash = await sha256Hex(codeBlob);

      // Reject codegen duplicates by code hash — same generated code, same row.
      const dup = await prisma.agentVersion.findFirst({
        where: { short: resolved.short, codeHash },
        select: { id: true, versionLabel: true },
      });
      if (dup) {
        return NextResponse.json(
          {
            ok: false,
            error: 'CONFLICT',
            message: `Identical generated code already captured as version '${dup.versionLabel}' (id ${dup.id}).`,
          },
          { status: 409 },
        );
      }

      const versionLabel = body.versionLabel?.trim() || generateVersionLabel();
      const row = await prisma.agentVersion.create({
        data: {
          short: resolved.short,
          slug: resolved.slug,
          versionLabel,
          status: 'draft',
          codeBlob,
          codeHash,
          specJson,
          promptText,
          modelUsed,
          capturedFrom: 'codegen',
          generatedBy: 'codegen-pipeline',
          notes: body.notes ?? null,
        },
      });
      return NextResponse.json({ ok: true, version: dbRowToApiRow(row) });
    }

    const snap = await snapshotAgentConfig(resolved.slug);
    if (!snap) {
      return NextResponse.json(
        {
          ok: false,
          error: 'NO_CONFIG',
          message: `No AgentConfig row exists for slug '${resolved.slug}'. Edit the agent config first to create one.`,
        },
        { status: 400 },
      );
    }
    const configHash = hashSnapshot(snap);

    // Reject silent duplicates — operator should know they're capturing
    // a config identical to a previous version.
    const dup = await prisma.agentVersion.findFirst({
      where: { short: resolved.short, configHash },
      select: { id: true, versionLabel: true },
    });
    if (dup) {
      return NextResponse.json(
        {
          ok: false,
          error: 'CONFLICT',
          message: `Identical config already captured as version '${dup.versionLabel}' (id ${dup.id}).`,
        },
        { status: 409 },
      );
    }

    const versionLabel = body.versionLabel?.trim() || generateVersionLabel();
    const row = await prisma.agentVersion.create({
      data: {
        short: resolved.short,
        slug: resolved.slug,
        versionLabel,
        status: 'draft',
        configJson: JSON.stringify(snap),
        configHash,
        capturedFrom: 'current-config',
        notes: body.notes ?? null,
      },
    });
    return NextResponse.json({ ok: true, version: dbRowToApiRow(row) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL', message: (e as Error).message },
      { status: 500 },
    );
  }
}

// Node's WebCrypto SHA-256 — keeps us off the `crypto` polyfill detour and
// runs inside the Next.js runtime regardless of node vs edge.
async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
