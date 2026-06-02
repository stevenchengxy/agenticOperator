// DELETE /api/agent-drafts/[id]  — SOFT delete → recycle bin
//
// Sets status='archived' + archivedAt (NOT a hard delete) so the agent can be
// restored from the recycle bin. Works for ontology-generated shells AND for
// real-agent lifecycle overrides (capturedFrom='real-agent') — never for a real
// production config snapshot. For ontology agents that self-gate on
// AgentVersion.status, an archived row reads as not-active → dormant, so this is
// safe; the registered Inngest function itself is never unregistered.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import {
  MANAGED_SOURCES,
  REAL_AGENT_SOURCE,
  parseRealAgentId,
  realOverrideLabel,
} from "@/lib/ontology-generator/draft-store";
import { AGENT_MAP } from "@/lib/agent-mapping";
import { resyncDomainApp } from "@/server/inngest/domain-app";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Real agent → upsert its lifecycle override as archived (recycle bin).
  const real = parseRealAgentId(id);
  if (real) {
    const meta = AGENT_MAP.find((a) => a.short === real.short && a.domain === real.domain);
    const created = await prisma.agentVersion.upsert({
      where: { short_versionLabel: { short: real.short, versionLabel: realOverrideLabel(real.domain) } },
      create: {
        short: real.short,
        slug: meta?.inngestName ?? real.short,
        versionLabel: realOverrideLabel(real.domain),
        domain: real.domain,
        status: "archived",
        capturedFrom: REAL_AGENT_SOURCE,
        generatedBy: "fleet-manage",
        archivedAt: new Date(),
        notes: `real-agent lifecycle override (${real.short})`,
      },
      update: { status: "archived", archivedAt: new Date() },
      select: { id: true, domain: true },
    });
    if (created.domain) await resyncDomainApp(created.domain).catch(() => {});
    return NextResponse.json({ ok: true, id: created.id, status: "archived" });
  }

  const existing = await prisma.agentVersion.findUnique({
    where: { id },
    select: { id: true, capturedFrom: true, status: true, domain: true },
  });
  if (!existing) {
    return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }
  // Only manageable agents (ontology shells + real-agent overrides) — never a
  // real production config snapshot.
  if (!MANAGED_SOURCES.includes(existing.capturedFrom ?? "")) {
    return NextResponse.json({ ok: false, error: "NOT_MANAGEABLE" }, { status: 403 });
  }

  const row = await prisma.agentVersion.update({
    where: { id },
    data: { status: "archived", archivedAt: new Date() },
    select: { id: true, domain: true },
  });

  // A previously-active shell leaving the live set → re-sync the domain app.
  if (row.domain) {
    await resyncDomainApp(row.domain).catch(() => {});
  }

  return NextResponse.json({ ok: true, id, status: "archived" });
}
