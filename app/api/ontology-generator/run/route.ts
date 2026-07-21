// POST /api/ontology-generator/run
//
// Body: { domainId: string, scenario?: string, enableBranches?: boolean }
// Fires the seed event that kicks off a deployed ontology agent chain — the
// "运行一次演示" button on the deploy result screen. For a runnable domain it
// first activates every agent (deploy = activate), registers the per-domain
// Inngest app, builds the scenario dataset, and seeds it on the event so the
// chain runs on real numbers and the human gates fire.

import { NextResponse } from "next/server";
import { inngest } from "@/server/inngest/client";
import { prisma } from "@/server/db";
import { resetClaims } from "@/server/inngest/domains/energy/run-state";
import { ENERGY_SEED_EVENT } from "@/server/inngest/domains/energy";
import { ensureEnergyDeployed } from "@/server/inngest/domains/energy/deploy";
import { buildScenarioData, SCENARIOS, type Scenario } from "@/server/inngest/domains/energy/sim-data";
import { COST_CONTROL_SEED_EVENT } from "@/server/inngest/domains/feikong";
import { ensureCostControlDeployed } from "@/server/inngest/domains/feikong/deploy";
import { buildFeikongScenario, FEIKONG_SCENARIOS, type FeikongScenario } from "@/server/inngest/domains/feikong/sim-data";
import { registerDomainApp } from "@/server/inngest/domain-app";
import { ENERGY_DOMAIN_ID, COST_CONTROL_DOMAIN_ID } from "@/lib/domain-ids";

export const dynamic = "force-dynamic";

type RunnablePack = {
  seedEvent: string;
  scenarios: string[];
  /** Build the deterministic dataset threaded onto every event (has `.dsNo`). */
  buildDataset: (scenario: string) => { dsNo?: string; expect?: unknown } & Record<string, unknown>;
  ensureDeployed: () => Promise<{ deployed: number; total: number }>;
};

// Map an Allmeta domain id → its runnable agent pack. Only domains here can be
// seeded; everything else returns "no runnable seed".
const RUNNABLE: Record<string, RunnablePack> = {
  [ENERGY_DOMAIN_ID]: {
    seedEvent: ENERGY_SEED_EVENT,
    scenarios: SCENARIOS as unknown as string[],
    buildDataset: (s) => buildScenarioData(s as Scenario) as never,
    ensureDeployed: ensureEnergyDeployed,
  },
  [COST_CONTROL_DOMAIN_ID]: {
    seedEvent: COST_CONTROL_SEED_EVENT,
    scenarios: FEIKONG_SCENARIOS as unknown as string[],
    buildDataset: (s) => buildFeikongScenario(s as FeikongScenario) as never,
    ensureDeployed: ensureCostControlDeployed,
  },
};

export async function POST(req: Request) {
  let domainId = "";
  let enableBranches = false;
  let scenarioReq = "";
  try {
    const body = (await req.json()) as { domainId?: unknown; enableBranches?: unknown; scenario?: unknown };
    if (typeof body?.domainId === "string") domainId = body.domainId.trim();
    if (body?.enableBranches === true) enableBranches = true;
    if (typeof body?.scenario === "string") scenarioReq = body.scenario.trim();
  } catch {
    // fall through → 400 below
  }

  const pack = RUNNABLE[domainId];
  if (!pack) {
    return NextResponse.json(
      { ok: false, error: `domain "${domainId}" has no runnable seed` },
      { status: 400 },
    );
  }
  // Validate scenario against the pack; default to its first scenario (happy).
  const scenario = pack.scenarios.includes(scenarioReq) ? scenarioReq : pack.scenarios[0];

  // Fresh run → clear the once-per-case dedup so a re-run actually fires.
  resetClaims();

  // Energy: risk-redline needs branch agents on so raiseRiskEvent fires.
  if (domainId === ENERGY_DOMAIN_ID && scenario === "risk-redline") enableBranches = true;

  const dataset = pack.buildDataset(scenario);

  // deploy = activate (so the self-gated agents fire), then register/re-introspect
  // the per-domain Inngest app so the dev server has the current (real) function
  // set before we seed — both idempotent, best-effort (a failure just leaves the
  // self-gate dormant rather than blocking the request).
  let deployed: { deployed: number; total: number } | null = null;
  try {
    deployed = await pack.ensureDeployed();
  } catch {
    /* best-effort */
  }
  try {
    await registerDomainApp(domainId);
  } catch {
    /* best-effort */
  }

  // A WorkflowRun gives the chain a real run id: agents log against it (the
  // AgentActivity.runId FK is satisfied) and the run surfaces in /monitor.
  // Fall back to a synthetic id if the row can't be written.
  let caseId = `case-${domainId}-seed`;
  try {
    const run = await prisma.workflowRun.create({
      data: {
        triggerEvent: pack.seedEvent,
        triggerData: JSON.stringify({ domainId, scenario, enableBranches, dsNo: dataset?.dsNo }),
        status: "running",
      },
      select: { id: true },
    });
    caseId = run.id;
  } catch {
    // keep synthetic caseId — LogEvent still records (no FK there)
  }

  const result = await inngest.send({
    name: pack.seedEvent,
    data: {
      caseId,
      domainId,
      scenario,
      dataset,
      _depth: 0,
      enableBranches,
      source_action: "(seed)",
      payload: { seeded: true, dsNo: dataset?.dsNo },
    },
  });

  return NextResponse.json({ ok: true, domainId, scenario, seedEvent: pack.seedEvent, caseId, deployed, expect: dataset?.expect ?? null, ids: result.ids });
}
