// Meta-brain tools — the deterministic orchestration core (no LLM). The full ReAct
// loop (conductor) is verified live; here we prove each tool's logic + the
// plan→generate→validate→resolve→finish flow over a hand-built context.

import { describe, it, expect } from "vitest";
import { META_TOOLS } from "./tools";
import { PRESET_AGENTS } from "../registry";
import { buildGoldStandard } from "../gold-standard";
import type { MetaCtx, MetaEvent, SlotState } from "./types";
import type { NodeNeed } from "../orchestrator";

const tool = (name: string) => META_TOOLS.find((t) => t.name === name)!;

// recruitment slots (what Agents-generation must assemble): 3 reusable + 1 novel
const NEEDS: NodeNeed[] = [
  { action: "processResume", triggerEvents: ["RESUME_DOWNLOADED"], emitEvents: ["RESUME_PROCESSED"] },
  { action: "ruleCheckForMatchResume", triggerEvents: ["RESUME_PROCESSED"], emitEvents: ["MATCH_RULE_CHECK_PASSED", "MATCH_RULE_CHECK_FAILED"] },
  { action: "matchResume", triggerEvents: ["MATCH_RULE_CHECK_PASSED"], emitEvents: ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_PASSED_NO_INTERVIEW", "MATCH_FAILED"] },
  { action: "scoreCandidatePotential", triggerEvents: ["MATCH_PASSED_NEED_INTERVIEW"], emitEvents: ["POTENTIAL_SCORED"] }, // novel
];

function mkCtx(): { ctx: MetaCtx; events: MetaEvent[] } {
  const events: MetaEvent[] = [];
  const allEmits = new Set(NEEDS.flatMap((n) => n.emitEvents));
  const entryEvents = [...new Set(NEEDS.flatMap((n) => n.triggerEvents))].filter((t) => !allEmits.has(t));
  const ctx: MetaCtx = {
    domain: "招聘-v1", goal: "test", emit: (e) => events.push(e),
    slots: NEEDS.map((need): SlotState => ({ need, decision: "open", agent: null, reason: "" })),
    registry: PRESET_AGENTS, goldStandard: buildGoldStandard(NEEDS), remaps: [],
    internalEvents: [...new Set(NEEDS.flatMap((n) => n.emitEvents))], entryEvents,
    lastGaps: [], lastComparison: null, spent: { turns: 0 },
  };
  return { ctx, events };
}

describe("plan_orchestration — build-vs-reuse over the slots", () => {
  it("reuses presets that fit, marks the novel slot for generation", async () => {
    const { ctx } = mkCtx();
    const r = await tool("plan_orchestration").execute({ reasoning: "x" }, ctx);
    expect(r.ok).toBe(true);
    const byAction = Object.fromEntries(ctx.slots.map((s) => [s.need.action, s]));
    expect(byAction["processResume"].decision).toBe("reuse");
    expect(byAction["matchResume"].agent?.id).toBe("match-resume-agent");
    expect(byAction["scoreCandidatePotential"].decision).toBe("generate");
    expect(byAction["scoreCandidatePotential"].agent).toBeNull();
  });
});

describe("generate_agents (dryRun) — binds factory output back to slots", () => {
  it("fills the open slot with a signature-matched generated agent", async () => {
    const { ctx } = mkCtx();
    await tool("plan_orchestration").execute({ reasoning: "x" }, ctx);
    const r = await tool("generate_agents").execute({ reasoning: "x", dryRun: true }, ctx);
    expect(r.ok).toBe(true);
    const novel = ctx.slots.find((s) => s.need.action === "scoreCandidatePotential")!;
    expect(novel.agent).toBeTruthy();
    expect(novel.agent!.emitEvents).toContain("POTENTIAL_SCORED");
  });
});

describe("validate_chain → resolve_gap → re-validate", () => {
  it("clean recruitment chain validates with no gaps", async () => {
    const { ctx } = mkCtx();
    await tool("plan_orchestration").execute({ reasoning: "x" }, ctx);
    await tool("generate_agents").execute({ reasoning: "x", dryRun: true }, ctx);
    const r = await tool("validate_chain").execute({ reasoning: "x" }, ctx);
    expect(r.ok).toBe(true);
    expect((r.output as { chainOk: boolean }).chainOk).toBe(true);
  });

  it("remap closes a gap by aliasing an upstream event", async () => {
    const { ctx } = mkCtx();
    // bind a reused agent whose REAL trigger needs an event the chain lacks
    ctx.slots = [
      { need: { action: "a", triggerEvents: ["ENTRY"], emitEvents: ["MID"] }, decision: "reuse",
        agent: { id: "x", name: "A", source: "handwritten", domain: "d", capability: "", triggerEvents: ["ENTRY"], emitEvents: ["MID"], tools: [], codeRef: "r", status: "preset", sandboxProven: true }, reason: "" },
      { need: { action: "b", triggerEvents: ["EXPECTED"], emitEvents: ["DONE"] }, decision: "reuse",
        agent: { id: "y", name: "B", source: "handwritten", domain: "d", capability: "", triggerEvents: ["EXPECTED"], emitEvents: ["DONE"], tools: [], codeRef: "r", status: "preset", sandboxProven: true }, reason: "" },
    ];
    ctx.entryEvents = ["ENTRY"];
    ctx.internalEvents = ["MID", "EXPECTED", "DONE"]; // EXPECTED is internal → unproduced = gap
    const before = await tool("validate_chain").execute({ reasoning: "x" }, ctx);
    expect((before.output as { chainOk: boolean }).chainOk).toBe(false); // EXPECTED unproduced
    // remap MID → EXPECTED (A's output adapts to B's expected trigger)
    const res = await tool("resolve_gap").execute({ reasoning: "x", event: "EXPECTED", neededBy: "B", decision: "remap", remapFrom: "MID" }, ctx);
    expect(res.ok).toBe(true);
    const after = await tool("validate_chain").execute({ reasoning: "x" }, ctx);
    expect((after.output as { chainOk: boolean }).chainOk).toBe(true);
  });

  it("resolve_gap generate reopens the mismatched reused slot", async () => {
    const { ctx } = mkCtx();
    ctx.slots = [
      { need: { action: "b", triggerEvents: ["EXPECTED"], emitEvents: ["DONE"] }, decision: "reuse",
        agent: { id: "y", name: "B", source: "handwritten", domain: "d", capability: "", triggerEvents: ["MISMATCH"], emitEvents: ["DONE"], tools: [], codeRef: "r", status: "preset", sandboxProven: true }, reason: "" },
    ];
    ctx.entryEvents = ["EXPECTED"];
    const res = await tool("resolve_gap").execute({ reasoning: "x", event: "MISMATCH", neededBy: "B", decision: "generate" }, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.slots[0].agent).toBeNull();
    expect(ctx.slots[0].decision).toBe("generate");
  });
});

describe("finish gate", () => {
  it("refuses when slots are unbound", async () => {
    const { ctx } = mkCtx();
    const r = await tool("finish").execute({ reasoning: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("未绑定");
  });

  it("passes when every slot is bound and the chain connects", async () => {
    const { ctx } = mkCtx();
    await tool("plan_orchestration").execute({ reasoning: "x" }, ctx);
    await tool("generate_agents").execute({ reasoning: "x", dryRun: true }, ctx);
    const r = await tool("finish").execute({ reasoning: "x", note: "done" }, ctx);
    expect(r.ok).toBe(true);
    expect((r.output as { complete: boolean }).complete).toBe(true);
  });
});

describe("compare_to_standard — grade vs 招聘-v1", () => {
  it("scores the bound agents against the gold standard", async () => {
    const { ctx } = mkCtx();
    await tool("plan_orchestration").execute({ reasoning: "x" }, ctx);
    await tool("generate_agents").execute({ reasoning: "x", dryRun: true }, ctx);
    const r = await tool("compare_to_standard").execute({ reasoning: "x" }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.lastComparison).toBeTruthy();
    // reused real agents match the standard closely → decent mean
    expect(ctx.lastComparison!.meanTotal).toBeGreaterThan(0.5);
  });
});
