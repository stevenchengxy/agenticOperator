// Chain convergence smoke test.
//
// Drives the real derived energy specs through a simulated event bus using the
// same control rules as the factory (once-per-case dedup, depth cap, branch
// gate) to prove the ontology wiring converges: the happy-path chain reaches
// archiveCase/ARCHIVED, fires each agent at most once, terminates in bounded
// steps, and every emitted event carries a complete payload. (The live LLM call
// + logging are exercised by the in-app run, not here.)

import { describe, it, expect, beforeEach } from "vitest";
import { loadSnapshotOntology, type OntologyEvent } from "@/lib/ontology-generator/ontology-source";
import { deriveAgents } from "@/lib/ontology-generator/analyze";
import { parseOrSynthesize } from "./structured-output";
import { claimOnce, resetClaims, MAX_CHAIN_DEPTH } from "./run-state";

const DOMAIN = "能源调度-v1";
const SEED = "DISPATCH_CYCLE_STARTED";
const BRANCH = new Set(["rollingRevision", "raiseRiskEvent", "declareMarket", "assessForecastAccuracy"]);

type Msg = { event: string; depth: number; payload: Record<string, unknown> };

function simulate(enableBranches: boolean) {
  const onto = loadSnapshotOntology(DOMAIN);
  const specs = deriveAgents(onto);
  const eventsByName = new Map<string, OntologyEvent>(onto.events.map((e) => [e.name, e]));

  // bare trigger event → consuming specs (entry agents listen to the seed).
  const consumers = new Map<string, typeof specs>();
  for (const s of specs) {
    const triggers = s.triggerEvents.length ? s.triggerEvents : [SEED];
    for (const t of triggers) {
      const arr = consumers.get(t) ?? [];
      arr.push(s);
      consumers.set(t, arr);
    }
  }

  const caseId = "case-smoke";
  const fired: string[] = [];
  const emittedPayloadsComplete: boolean[] = [];
  const queue: Msg[] = [{ event: SEED, depth: 0, payload: { seeded: true } }];

  let steps = 0;
  const MAX_STEPS = 2000; // independent termination guard for the test itself
  while (queue.length) {
    if (++steps > MAX_STEPS) throw new Error("chain did not terminate");
    const msg = queue.shift()!;
    for (const spec of consumers.get(msg.event) ?? []) {
      if (msg.depth > MAX_CHAIN_DEPTH) continue;
      if (BRANCH.has(spec.actionName) && !enableBranches) continue;
      if (!claimOnce(`${DOMAIN}:${caseId}:${spec.actionName}`)) continue;
      fired.push(spec.actionName);
      for (const emit of spec.emitEvents) {
        const { payload } = parseOrSynthesize("", eventsByName.get(emit), spec.actionName);
        const evt = eventsByName.get(emit);
        const keys = (evt?.payload?.event_data ?? []).map((f) => f.name);
        emittedPayloadsComplete.push(keys.every((k) => k in payload));
        queue.push({ event: emit, depth: msg.depth + 1, payload });
      }
    }
  }

  return { fired, steps, emittedPayloadsComplete };
}

describe("energy chain convergence", () => {
  beforeEach(() => resetClaims());

  it("happy path (no branches) reaches archiveCase and terminates", () => {
    const { fired, steps } = simulate(false);
    expect(fired).toContain("ingestAndOpenCase");
    expect(fired).toContain("forecastOutput");
    expect(fired).toContain("finalizePlan");
    expect(fired).toContain("dispatchInstruction");
    expect(fired).toContain("archiveCase");
    expect(steps).toBeLessThan(2000); // terminated
  });

  it("fires each agent at most once per case", () => {
    const { fired } = simulate(false);
    const counts = new Map<string, number>();
    for (const a of fired) counts.set(a, (counts.get(a) ?? 0) + 1);
    for (const [, c] of counts) expect(c).toBe(1);
  });

  it("post-archive simulated-human chain runs (audit → config → deploy)", () => {
    const { fired } = simulate(false);
    expect(fired).toContain("runOperationAudit");
    expect(fired).toContain("maintainConstraintConfig");
    expect(fired).toContain("validateAndDeploySystemChange");
  });

  it("every emitted event carries a complete payload", () => {
    const { emittedPayloadsComplete } = simulate(false);
    expect(emittedPayloadsComplete.length).toBeGreaterThan(10);
    expect(emittedPayloadsComplete.every(Boolean)).toBe(true);
  });

  it("with branches enabled still terminates (dedup caps loops)", () => {
    const { fired, steps } = simulate(true);
    expect(fired).toContain("rollingRevision");
    expect(fired).toContain("raiseRiskEvent");
    expect(steps).toBeLessThan(2000);
  });
});
