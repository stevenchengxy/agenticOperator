// DELETE /api/agent-drafts/[id]
//
// Permanently removes a SHELL agent draft (the AgentVersion row). Only allowed
// for ontology-generated shells that are in the `draft` state — deploy/offline
// it back to draft first. Deleting just removes the row; for ontology agents
// that self-gate on AgentVersion.status (energy pack), a missing row means the
// agent is simply dormant, so this is always safe.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { ONTOLOGY_GEN_SOURCE } from "@/lib/ontology-generator/draft-store";
import { resyncDomainApp } from "@/server/inngest/domain-app";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const existing = await prisma.agentVersion.findUnique({
    where: { id },
    select: { id: true, capturedFrom: true, status: true, domain: true },
  });
  if (!existing) {
    return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }
  // Hard guard: never delete a real production agent version.
  if (existing.capturedFrom !== ONTOLOGY_GEN_SOURCE) {
    return NextResponse.json({ ok: false, error: "NOT_A_SHELL" }, { status: 403 });
  }
  // Only drafts are deletable — force an explicit 放回草稿 first.
  if (existing.status !== "draft") {
    return NextResponse.json(
      { ok: false, error: "NOT_A_DRAFT" },
      { status: 409 },
    );
  }

  await prisma.agentVersion.delete({ where: { id } });

  // The deleted shell may have been part of a domain app's set — re-sync so
  // Inngest drops it (no-op if the app is offline / it wasn't active).
  if (existing.domain) {
    await resyncDomainApp(existing.domain).catch(() => {});
  }

  return NextResponse.json({ ok: true, id });
}
