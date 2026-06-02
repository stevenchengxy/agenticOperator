// POST /api/agent-drafts/[id]/restore  — bring an archived agent back from the
// recycle bin to `draft` (status='draft', archivedAt cleared). From there the
// operator can re-deploy it. Works for ontology shells and real-agent overrides.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { MANAGED_SOURCES } from "@/lib/ontology-generator/draft-store";
import { resyncDomainApp } from "@/server/inngest/domain-app";

export const dynamic = "force-dynamic";

export async function POST(
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
  if (!MANAGED_SOURCES.includes(existing.capturedFrom ?? "")) {
    return NextResponse.json({ ok: false, error: "NOT_MANAGEABLE" }, { status: 403 });
  }
  if (existing.status !== "archived") {
    return NextResponse.json({ ok: false, error: "NOT_ARCHIVED" }, { status: 409 });
  }

  const row = await prisma.agentVersion.update({
    where: { id },
    data: { status: "draft", archivedAt: null },
    select: { id: true, domain: true },
  });
  if (row.domain) {
    await resyncDomainApp(row.domain).catch(() => {});
  }
  return NextResponse.json({ ok: true, id, status: "draft" });
}
