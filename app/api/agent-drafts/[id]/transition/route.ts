// POST /api/agent-drafts/[id]/transition
//
// Body:  { to: 'draft' | 'active' | 'offline' }
// Moves a managed agent through its lifecycle:
//   draft   → active  (部署 / 上线)
//   active  ⇄ offline (上线 / 下线)
//   *       → draft    (放回草稿)
//
// Works for ontology shells (id = AgentVersion.id) AND for real production
// agents (id = "real:<domain>:<short>"): the first action on a real agent
// upserts a lifecycle OVERRIDE row (capturedFrom='real-agent') — the agent's
// code/registration is never touched, only its managed status.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import {
  MANAGED_SOURCES,
  REAL_AGENT_SOURCE,
  isValidTransition,
  parseRealAgentId,
  realOverrideLabel,
  rowToDraftRow,
  type ShellVersionRow,
} from "@/lib/ontology-generator/draft-store";
import { AGENT_MAP } from "@/lib/agent-mapping";
import { resyncDomainApp } from "@/server/inngest/domain-app";

export const dynamic = "force-dynamic";

const ROW_SELECT = {
  id: true, short: true, slug: true, domain: true,
  versionLabel: true, status: true, configJson: true, createdAt: true,
} as const;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let to: unknown;
  try {
    ({ to } = (await req.json()) as { to?: unknown });
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_BODY" }, { status: 400 });
  }
  if (!isValidTransition(to)) {
    return NextResponse.json({ ok: false, error: "INVALID_TRANSITION" }, { status: 400 });
  }

  // Real agent with no override yet → upsert the lifecycle override.
  const real = parseRealAgentId(id);
  if (real) {
    const meta = AGENT_MAP.find((a) => a.short === real.short && a.domain === real.domain);
    const row = (await prisma.agentVersion.upsert({
      where: { short_versionLabel: { short: real.short, versionLabel: realOverrideLabel(real.domain) } },
      create: {
        short: real.short,
        slug: meta?.inngestName ?? real.short,
        versionLabel: realOverrideLabel(real.domain),
        domain: real.domain,
        status: to,
        capturedFrom: REAL_AGENT_SOURCE,
        generatedBy: "fleet-manage",
        deployedAt: to === "active" ? new Date() : null,
        archivedAt: null,
        notes: `real-agent lifecycle override (${real.short})`,
      },
      update: {
        status: to,
        deployedAt: to === "active" ? new Date() : undefined,
        archivedAt: null,
      },
      select: ROW_SELECT,
    })) as ShellVersionRow;
    if (row.domain) await resyncDomainApp(row.domain).catch(() => {});
    return NextResponse.json({ ok: true, row: rowToDraftRow(row) });
  }

  const existing = await prisma.agentVersion.findUnique({
    where: { id },
    select: { id: true, capturedFrom: true },
  });
  if (!existing) {
    return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }
  // Only manageable agents — never a real production config snapshot.
  if (!MANAGED_SOURCES.includes(existing.capturedFrom ?? "")) {
    return NextResponse.json({ ok: false, error: "NOT_MANAGEABLE" }, { status: 403 });
  }

  const row = (await prisma.agentVersion.update({
    where: { id },
    data: {
      status: to,
      deployedAt: to === "active" ? new Date() : undefined,
      archivedAt: null,
    },
    select: ROW_SELECT,
  })) as ShellVersionRow;

  if (row.domain) {
    await resyncDomainApp(row.domain).catch(() => {});
  }

  return NextResponse.json({ ok: true, row: rowToDraftRow(row) });
}
