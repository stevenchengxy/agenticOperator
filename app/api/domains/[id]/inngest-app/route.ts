// GET  /api/domains/[id]/inngest-app  — current Inngest-app state for a domain
// POST /api/domains/[id]/inngest-app  { action: 'register' | 'offline' }
//
// Registers (or takes offline) the per-domain Inngest app. The agents deployed
// in this domain become live functions on `agentic-operator-<id>` when online.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import {
  getDomainApp,
  registerDomainApp,
  offlineDomainApp,
} from "@/server/inngest/domain-app";
import { ONTOLOGY_GEN_SOURCE } from "@/lib/ontology-generator/draft-store";

export const dynamic = "force-dynamic";

async function deployedCount(domain: string): Promise<number> {
  return prisma.agentVersion.count({
    where: { capturedFrom: ONTOLOGY_GEN_SOURCE, domain, status: "active" },
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = await getDomainApp(id);
  return NextResponse.json({ ...state, deployedCount: await deployedCount(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let action: unknown;
  try {
    ({ action } = (await req.json()) as { action?: unknown });
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_BODY" }, { status: 400 });
  }

  if (action === "register") {
    const r = await registerDomainApp(id);
    const state = await getDomainApp(id);
    return NextResponse.json({ ...r, state: { ...state, deployedCount: await deployedCount(id) } }, { status: r.ok ? 200 : 502 });
  }
  if (action === "offline") {
    const r = await offlineDomainApp(id);
    const state = await getDomainApp(id);
    return NextResponse.json({ ...r, state: { ...state, deployedCount: await deployedCount(id) } }, { status: r.ok ? 200 : 502 });
  }
  return NextResponse.json({ ok: false, error: "UNKNOWN_ACTION" }, { status: 400 });
}
