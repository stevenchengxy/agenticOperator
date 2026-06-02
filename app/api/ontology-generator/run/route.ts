// POST /api/ontology-generator/run
//
// Body: { domainId: string, enableBranches?: boolean }
// Fires the seed event that kicks off a deployed ontology agent chain — the
// "运行一次演示" button on the deploy result screen. Only the entry agent
// (action with no trigger) listens for the seed; undeployed agents no-op via
// their AgentVersion self-gate, so nothing runs until the operator deploys.

import { NextResponse } from "next/server";
import { inngest } from "@/server/inngest/client";
import { prisma } from "@/server/db";
import { resetClaims } from "@/server/inngest/domains/energy/run-state";

export const dynamic = "force-dynamic";

// Map an Allmeta domain id → its seed event. Only domains with a runnable agent
// pack can be seeded.
const SEED_EVENT: Record<string, string> = {
  "nengyuandiaodu-v1": "nengyuandiaodu-v1/DISPATCH_CYCLE_STARTED",
};

export async function POST(req: Request) {
  let domainId = "";
  let enableBranches = false;
  try {
    const body = (await req.json()) as { domainId?: unknown; enableBranches?: unknown };
    if (typeof body?.domainId === "string") domainId = body.domainId.trim();
    if (body?.enableBranches === true) enableBranches = true;
  } catch {
    // fall through → 400 below
  }

  const seedEvent = SEED_EVENT[domainId];
  if (!seedEvent) {
    return NextResponse.json(
      { ok: false, error: `domain "${domainId}" has no runnable seed` },
      { status: 400 },
    );
  }

  // Fresh run → clear the once-per-case dedup so a re-run actually fires.
  resetClaims();

  // A WorkflowRun gives the chain a real run id: agents log against it (the
  // AgentActivity.runId FK is satisfied) and the run surfaces in /monitor.
  // Fall back to a synthetic id if the row can't be written.
  let caseId = `case-${domainId}-${Date.now()}`;
  try {
    const run = await prisma.workflowRun.create({
      data: {
        triggerEvent: seedEvent,
        triggerData: JSON.stringify({ domainId, enableBranches }),
        status: "running",
      },
      select: { id: true },
    });
    caseId = run.id;
  } catch {
    // keep synthetic caseId — LogEvent still records (no FK there)
  }

  const result = await inngest.send({
    name: seedEvent,
    data: {
      caseId,
      domainId,
      _depth: 0,
      enableBranches,
      source_action: "(seed)",
      payload: { seeded: true },
    },
  });

  return NextResponse.json({ ok: true, domainId, seedEvent, caseId, ids: result.ids });
}
