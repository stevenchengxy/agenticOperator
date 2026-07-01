// Fully-AI / atomic finish gate. `finish` is a real ACCEPTANCE gate: it runs the
// same deterministic validation as validate_graph (coverage + event-graph closure
// + groundedness + authored-prompt) and only succeeds if everything passes. There
// is NO force-allow and NO degraded-shell fabrication — an unmet criterion makes
// finish FAIL (ok:false), so the brain must fix it or the run fails honestly.

import { describe, it, expect } from "vitest";
import { P1_TOOLS, specsFingerprint } from "./index";
import type { BrainCtx } from "../brain/types";

/** RANK-1: green sandbox evidence matching the given specs (so finish's behavioral
 *  gate passes). A test that wants finish to SUCCEED must attach this. */
function greenSandbox(specs: ReturnType<typeof spec>[]) {
  return {
    specsFingerprint: specsFingerprint(specs as never),
    deployed: specs.length, agentsRan: specs.length, ranAgents: specs.map((s) => s.short),
    reachedTerminal: true, reachedSuccessTerminal: true, fullChainRan: true, partial: false, degradedAgents: [], ts: 1,
  };
}

const finish = P1_TOOLS.find((t) => t.name === "finish")!;

const agentAction = (name: string, trigger: string[], emit: string[]) => ({
  name, actor: ["Agent"], trigger, triggered_event: emit,
  target_objects: [], tool_use: [], system_prompt: "", user_prompt: "",
});

type SpecOverride = { actionName: string; trigger: string[]; emit: string[]; promptSource?: string; noCode?: boolean };
function spec(o: SpecOverride) {
  // Fully-AI: an accepted agent carries LLM-written code (codeSource="ai"). The
  // finish gate refuses any spec without it. `noCode: true` models a not-yet-
  // codegen'd agent.
  const hasCode = !o.noCode;
  return {
    key: o.actionName, actionName: o.actionName, slug: `test-${o.actionName}`, short: `${o.actionName}Agent`,
    domainId: "test-domain", nameZh: o.actionName, kind: "llm",
    trigger: o.trigger, emit: o.emit, tools: ["real.tool"], unresolvedTools: [],
    objects: [], systemPrompt: "由大脑亲自写的系统提示", userPrompt: "x", steps: [], ruleRefs: [],
    retries: 1, hitl: false, confidence: 0.9, promptSource: o.promptSource ?? "llm", toolFlow: "parallel",
    generatedCode: hasCode
      ? `import { inngest } from '@/server/inngest/client';\nexport const ${o.actionName}Agent = inngest.createFunction({ id: '${o.actionName}', name: '${o.actionName}', triggers: [] }, async () => ({ ok: true }));`
      : undefined,
    codeSource: hasCode ? ("ai" as const) : undefined,
  };
}

function ctxWith(actions: ReturnType<typeof agentAction>[], specs: ReturnType<typeof spec>[]): BrainCtx {
  return {
    domain: "test-domain", goal: "", emit: () => {},
    specs,
    ontology: { actions, events: [], objects: [], rules: [], source: "snapshot" } as unknown,
    registry: null, createdSkills: [], research: [],
    budget: { maxTokens: 1, maxTurns: 1 }, spent: { tokens: 0, turns: 0 },
    currentPlan: null, attemptHistory: {}, lastSandboxRunIds: [], lastSandboxVersionLabel: null,
    lastSandbox: null, humanDirectives: [],
    lastValidation: null, priorReflections: [], rulesByAction: {}, suggestedToolsByAction: {},
  } as unknown as BrainCtx;
}

// A clean 2-agent chain: a --A_DONE--> b (b's B_DONE is terminal).
const ACTIONS = [
  agentAction("a", ["ENTRY"], ["A_DONE"]),
  agentAction("b", ["A_DONE"], ["B_DONE"]),
];

describe("finish — acceptance gate (fully-AI)", () => {
  it("REFUSES (ok:false) when an actor=Agent action has no spec, naming the gap", async () => {
    const ctx = ctxWith(ACTIONS, [spec({ actionName: "a", trigger: ["ENTRY"], emit: ["A_DONE"] })]); // b uncovered
    const res = await finish.execute(
      { summary: "完成", reflection: { kind: "success", summary: "s", lesson: "l" } },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("b");
  });

  it("REFUSES when a spec's prompt is a hardcoded fallback template (not authored)", async () => {
    const ctx = ctxWith(ACTIONS, [
      spec({ actionName: "a", trigger: ["ENTRY"], emit: ["A_DONE"], promptSource: "fallback" }),
      spec({ actionName: "b", trigger: ["A_DONE"], emit: ["B_DONE"] }),
    ]);
    const res = await finish.execute(
      { summary: "完成", reflection: { kind: "success", summary: "s", lesson: "l" } },
      ctx,
    );
    expect(res.ok).toBe(false);
  });

  it("REFUSES when an agent has no LLM-written code (no render fallback), naming it", async () => {
    const ctx = ctxWith(ACTIONS, [
      spec({ actionName: "a", trigger: ["ENTRY"], emit: ["A_DONE"] }),
      spec({ actionName: "b", trigger: ["A_DONE"], emit: ["B_DONE"], noCode: true }), // not codegen'd
    ]);
    const res = await finish.execute(
      { summary: "完成", reflection: { kind: "success", summary: "s", lesson: "l" } },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("bAgent");
  });

  it("REFUSES when the sandbox only PARTIALLY ran (behavioral gate), even with full coverage + AI code", async () => {
    const specs = [
      spec({ actionName: "a", trigger: ["ENTRY"], emit: ["A_DONE"] }),
      spec({ actionName: "b", trigger: ["A_DONE"], emit: ["B_DONE"] }),
    ];
    const ctx = ctxWith(ACTIONS, specs);
    // sandbox ran only 1 of 2 agents → partial chain → must NOT finish
    ctx.lastSandbox = { ...greenSandbox(specs), agentsRan: 1, fullChainRan: false, partial: true };
    const res = await finish.execute({ summary: "完成", reflection: { kind: "success", summary: "s", lesson: "l" } }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("真的跑起来");
  });

  it("REFUSES when sandbox evidence is STALE (specs changed since the green run)", async () => {
    const specs = [
      spec({ actionName: "a", trigger: ["ENTRY"], emit: ["A_DONE"] }),
      spec({ actionName: "b", trigger: ["A_DONE"], emit: ["B_DONE"] }),
    ];
    const ctx = ctxWith(ACTIONS, specs);
    ctx.lastSandbox = { ...greenSandbox(specs), specsFingerprint: "stale-fingerprint-from-before-a-refine" };
    const res = await finish.execute({ summary: "完成", reflection: { kind: "success", summary: "s", lesson: "l" } }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("证据过期");
  });

  it("REFUSES when an agent ran DEGRADED (gateway-down fallback, not a real decision)", async () => {
    const specs = [
      spec({ actionName: "a", trigger: ["ENTRY"], emit: ["A_DONE"] }),
      spec({ actionName: "b", trigger: ["A_DONE"], emit: ["B_DONE"] }),
    ];
    const ctx = ctxWith(ACTIONS, specs);
    // every agent ran + terminal reached, BUT one decision was a degraded fallback
    ctx.lastSandbox = { ...greenSandbox(specs), degradedAgents: ["bAgent"] };
    const res = await finish.execute({ summary: "完成", reflection: { kind: "success", summary: "s", lesson: "l" } }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("degraded");
  });

  it("SUCCEEDS (ok:true) only with full coverage + AI code + a GREEN end-to-end sandbox run", async () => {
    const specs = [
      spec({ actionName: "a", trigger: ["ENTRY"], emit: ["A_DONE"] }),
      spec({ actionName: "b", trigger: ["A_DONE"], emit: ["B_DONE"] }),
    ];
    const ctx = ctxWith(ACTIONS, specs);
    ctx.lastSandbox = greenSandbox(specs); // every deployed agent ran, full chain reached terminal
    const res = await finish.execute(
      { summary: "完成", reflection: { kind: "success", summary: "s", lesson: "l" } },
      ctx,
    );
    expect(res.ok).toBe(true);
  });
});
