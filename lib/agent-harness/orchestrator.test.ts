// Meta-Orchestrator core — the build-vs-reuse plan over a domain's node-slots.
// Deterministic: given the ontology's actions + the registry, it decides per slot
// reuse-or-generate.

import { describe, it, expect } from "vitest";
import { planFromOntology, composeExecution, assembleOrchestration, validateChain, runOrchestration, type NodeNeed, type OrchestrationPlan, type GenerateDispatch } from "./orchestrator";
import { PRESET_AGENTS } from "./registry";
import type { RegistryAgent } from "./types";

// recruitment domain node-slots (the 6 ontology actions, by event signature)
const RECRUIT_NEEDS: NodeNeed[] = [
  { action: "processResume", triggerEvents: ["RESUME_DOWNLOADED"], emitEvents: ["RESUME_PROCESSED"] },
  { action: "ruleCheckForMatchResume", triggerEvents: ["RESUME_PROCESSED"], emitEvents: ["MATCH_RULE_CHECK_PASSED", "MATCH_RULE_CHECK_FAILED"] },
  { action: "matchResume", triggerEvents: ["MATCH_RULE_CHECK_PASSED"], emitEvents: ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED"] },
  { action: "inviteInternalInterview", triggerEvents: ["INTERVIEW_INVITATION_REQUESTED"], emitEvents: ["INTERVIEW_INVITATION_SENT"] },
  { action: "createJD", triggerEvents: ["JD_GENERATION_REQUESTED"], emitEvents: ["JD_GENERATED"] },
  { action: "scoreCandidatePotential", triggerEvents: ["MATCH_PASSED_NEED_INTERVIEW"], emitEvents: ["POTENTIAL_SCORED"] }, // NOVEL — no preset
];

describe("planFromOntology — build-vs-reuse over a domain", () => {
  const plan = planFromOntology(RECRUIT_NEEDS, PRESET_AGENTS, "招聘-v1");

  it("reuses preset agents whose event signature fits the slot", () => {
    const byAction = Object.fromEntries(plan.nodes.map((n) => [n.action, n]));
    expect(byAction["processResume"].decision).toBe("reuse");
    expect(byAction["processResume"].agent?.id).toBe("resume-parser-agent");
    expect(byAction["ruleCheckForMatchResume"].decision).toBe("reuse");
    expect(byAction["ruleCheckForMatchResume"].agent?.id).toBe("rule-check-agent");
    expect(byAction["matchResume"].decision).toBe("reuse");
    expect(byAction["matchResume"].agent?.id).toBe("match-resume-agent");
  });

  it("marks a NOVEL slot (no matching preset) for generation", () => {
    const novel = plan.nodes.find((n) => n.action === "scoreCandidatePotential")!;
    expect(novel.decision).toBe("generate");
    expect(novel.agent).toBeNull();
  });

  it("counts reuse vs generate + derives the entry events", () => {
    expect(plan.reuseCount).toBeGreaterThanOrEqual(4); // most recruitment slots reuse presets
    expect(plan.generateCount).toBeGreaterThanOrEqual(1); // the novel one
    expect(plan.entryEvents).toContain("RESUME_DOWNLOADED");
    expect(plan.entryEvents).toContain("JD_GENERATION_REQUESTED");
    expect(plan.summary).toContain("复用");
  });

  it("an empty registry forces generation of every slot (cold start)", () => {
    const cold = planFromOntology(RECRUIT_NEEDS, [] as RegistryAgent[], "招聘-v1");
    expect(cold.reuseCount).toBe(0);
    expect(cold.generateCount).toBe(RECRUIT_NEEDS.length);
  });
});

describe("composeExecution — validate the COMPOSED chain over real signatures", () => {
  it("clean: reuse + generate that chain → chainOk, no gaps", () => {
    const plan = planFromOntology([
      { action: "a", triggerEvents: ["RESUME_DOWNLOADED"], emitEvents: ["RESUME_PROCESSED"] },
      { action: "b", triggerEvents: ["RESUME_PROCESSED"], emitEvents: ["MATCH_RULE_CHECK_PASSED", "MATCH_RULE_CHECK_FAILED"] },
    ], PRESET_AGENTS, "招聘-v1");
    const m = composeExecution(plan);
    expect(m.chainOk).toBe(true);
    expect(m.gaps).toEqual([]);
    expect(m.reuse.length).toBe(2);
  });

  it("catches a gap when a REUSED agent emits a different event than the slot expected", () => {
    // Hand-built plan: node A is reused but the bound agent emits MID_TYPO, while
    // node B consumes MID (not a real entry) → broken hop.
    const reusedA: RegistryAgent = {
      id: "agentA", name: "A", source: "handwritten", domain: "d", capability: "a",
      triggerEvents: ["ENTRY"], emitEvents: ["MID_TYPO"], tools: [], codeRef: "x", status: "preset", sandboxProven: true,
    };
    const plan: OrchestrationPlan = {
      domain: "d",
      nodes: [
        { action: "A", triggerEvents: ["ENTRY"], emitEvents: ["MID"], decision: "reuse", agent: reusedA, reason: "" },
        { action: "B", triggerEvents: ["MID"], emitEvents: ["DONE"], decision: "generate", agent: null, reason: "" },
      ],
      // MID is an INTERNAL event (slot A is supposed to produce it) → B consuming an
      // unproduced internal event is a real gap. ENTRY is external (entry point).
      reuseCount: 1, generateCount: 1, entryEvents: ["ENTRY"], internalEvents: ["MID", "DONE"], danglingTriggers: [], summary: "",
    };
    const m = composeExecution(plan);
    expect(m.chainOk).toBe(false);
    expect(m.gaps[0].event).toBe("MID");
    expect(m.gaps[0].neededBy).toBe("B");
  });

  it("does NOT flag an external/platform trigger as a gap (independent agent)", () => {
    // an agent triggered by an external event no agent produces is a legit entry.
    const plan: OrchestrationPlan = {
      domain: "d",
      nodes: [
        { action: "indep", triggerEvents: ["EXTERNAL_PLATFORM_EVENT"], emitEvents: ["DONE"], decision: "generate", agent: null, reason: "" },
      ],
      reuseCount: 0, generateCount: 1, entryEvents: ["EXTERNAL_PLATFORM_EVENT"], internalEvents: ["DONE"], danglingTriggers: [], summary: "",
    };
    const m = composeExecution(plan);
    expect(m.chainOk).toBe(true);
    expect(m.gaps).toEqual([]);
  });
});

describe("assembleOrchestration — the full loop's pure core (plan + generated → result)", () => {
  // a 2-slot chain: slot A reuses a preset, slot B is novel → generated
  const needs: NodeNeed[] = [
    { action: "processResume", triggerEvents: ["RESUME_DOWNLOADED"], emitEvents: ["RESUME_PROCESSED"] },
    { action: "enrichProfile", triggerEvents: ["RESUME_PROCESSED"], emitEvents: ["PROFILE_ENRICHED"] }, // novel
  ];
  const plan = planFromOntology(needs, PRESET_AGENTS, "招聘-v1");

  it("complete when the generated agent fills the novel slot AND the chain connects", () => {
    // the factory built enrichProfile with the slot's signature → chain connects
    const generated: RegistryAgent[] = [{
      id: "gen-enrich", name: "enrichProfile", source: "generated", domain: "招聘-v1", capability: "enrich",
      triggerEvents: ["RESUME_PROCESSED"], emitEvents: ["PROFILE_ENRICHED"], tools: [], codeRef: "v1", status: "draft", sandboxProven: true,
    }];
    const r = assembleOrchestration(plan, generated);
    expect(r.reused.length).toBe(1);        // processResume reused a preset
    expect(r.generated.length).toBe(1);     // enrichProfile generated
    expect(r.complete).toBe(true);
    expect(r.chainOk).toBe(true);
    expect(r.summary).toContain("端到端连通");
  });

  it("NOT complete when a generated agent's WRONG emit leaves a downstream INTERNAL event unproduced", () => {
    // 3-slot chain so a mid-chain break surfaces: enrichProfile should emit
    // PROFILE_ENRICHED (consumed by scoreProfile) but emits the wrong event → the
    // internal event PROFILE_ENRICHED has no producer → real gap.
    const chain: NodeNeed[] = [
      { action: "processResume", triggerEvents: ["RESUME_DOWNLOADED"], emitEvents: ["RESUME_PROCESSED"] },
      { action: "enrichProfile", triggerEvents: ["RESUME_PROCESSED"], emitEvents: ["PROFILE_ENRICHED"] },
      { action: "scoreProfile", triggerEvents: ["PROFILE_ENRICHED"], emitEvents: ["PROFILE_SCORED"] },
    ];
    const chainPlan = planFromOntology(chain, PRESET_AGENTS, "招聘-v1");
    const broken: RegistryAgent[] = [
      { id: "g-enrich", name: "enrichProfile", source: "generated", domain: "招聘-v1", capability: "", triggerEvents: ["RESUME_PROCESSED"], emitEvents: ["WRONG_EMIT"], tools: [], codeRef: "v", status: "draft", sandboxProven: false },
      { id: "g-score", name: "scoreProfile", source: "generated", domain: "招聘-v1", capability: "", triggerEvents: ["PROFILE_ENRICHED"], emitEvents: ["PROFILE_SCORED"], tools: [], codeRef: "v", status: "draft", sandboxProven: false },
    ];
    const r = assembleOrchestration(chainPlan, broken);
    expect(r.chainOk).toBe(false);
    expect(r.gaps.some((g) => g.event === "PROFILE_ENRICHED")).toBe(true);
  });

  it("NOT complete when the factory returns nothing for a novel slot (unfilled)", () => {
    const r = assembleOrchestration(plan, []);
    expect(r.generated.length).toBe(0);
    expect(r.complete).toBe(false); // 1 reused < 2 slots → not filled
  });
});

describe("validateChain — connectivity over real signatures", () => {
  it("ignores empty/placeholder events", () => {
    const { chainOk } = validateChain([{ name: "x", triggerEvents: ["—", ""], emitEvents: [] }], []);
    expect(chainOk).toBe(true);
  });
});

describe("runOrchestration — FULL LOOP e2e (plan → dispatch → assemble), DB-tolerant", () => {
  // inline mock dispatch (no heavy factory import): the Generation Harness builds each
  // novel slot to its exact signature, like a successful factory run would.
  const inlineMock: GenerateDispatch = async (needs) => needs.map((n, i) => ({
    id: `gen-${i}`, name: n.action, source: "generated" as const, domain: "招聘-v1",
    capability: `generated ${n.action}`, triggerEvents: n.triggerEvents, emitEvents: n.emitEvents,
    tools: [], codeRef: `gen:${n.action}`, status: "draft", sandboxProven: true,
  }));

  it("recruitment domain orchestrates to a COMPLETE, connected chain", async () => {
    const r = await runOrchestration(RECRUIT_NEEDS, "招聘-v1", inlineMock);
    // robust to live-DB state: extra generated agents only ADD reuse candidates.
    expect(r.reused.length).toBeGreaterThanOrEqual(4);     // presets cover most slots
    expect(r.reused.length + r.generated.length).toBe(RECRUIT_NEEDS.length); // every slot filled
    expect(r.chainOk).toBe(true);                          // composed chain connects
    expect(r.complete).toBe(true);
  });

  it("cold registry (no presets/generated) → factory builds ALL slots, still completes", async () => {
    // a non-recruitment domain has no presets; with a DB-down/empty generated set the
    // registry is empty → every slot is generated by the (mock) factory.
    const needs: NodeNeed[] = [
      { action: "ingest", triggerEvents: ["DOC_IN"], emitEvents: ["DOC_PARSED"] },
      { action: "classify", triggerEvents: ["DOC_PARSED"], emitEvents: ["DOC_CLASSIFIED"] },
    ];
    const r = await runOrchestration(needs, "novel-domain-xyz", inlineMock);
    expect(r.generated.length).toBe(2);
    expect(r.complete).toBe(true);
  });
});
