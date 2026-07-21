// P4 — bounded self-correction. refine_agent enforces a per-agent retry budget:
// after REFINE_BUDGET attempts it refuses to keep grinding (the FlipFlop /
// over-iteration anti-pattern), telling the brain to revert or accept instead.

import { describe, it, expect } from "vitest";
import { P1_TOOLS } from "./index";
import type { BrainCtx } from "../brain/types";
import { ToolRegistry } from "@/lib/tools/registry";

const refine = P1_TOOLS.find((t) => t.name === "refine_agent")!;

const action = (name: string) => ({
  name, actor: ["Agent"], trigger: ["IN"], triggered_event: ["OUT_DONE"],
  target_objects: [], tool_use: [], system_prompt: "", user_prompt: "",
});

function makeCtx(): BrainCtx {
  return {
    domain: "test-domain",
    goal: "",
    emit: () => {},
    specs: [{
      key: "parseResume", actionName: "parseResume", slug: "test-parse", short: "X",
      domainId: "test-domain", nameZh: "parseResume", kind: "llm",
      systemPrompt: "原 prompt", tools: ["t"], unresolvedTools: [],
      emit: ["OUT_DONE"], trigger: ["IN"], objects: [], steps: [], ruleRefs: [],
      retries: 1, hitl: false, confidence: 0.9, promptSource: "llm", toolFlow: "parallel",
    }],
    ontology: { actions: [action("parseResume")], events: [], objects: [], rules: [], source: "snapshot" },
    registry: new ToolRegistry(),
    createdSkills: [],
    research: [],
    budget: { maxTokens: 1, maxTurns: 1 },
    spent: { tokens: 0, turns: 0 },
    currentPlan: null,
    attemptHistory: {},
    lastSandboxRunIds: [],
    lastSandboxVersionLabel: null,
    lastValidation: null,
    priorReflections: [],
    rulesByAction: {},
    suggestedToolsByAction: {},
  } as unknown as BrainCtx;
}

describe("refine_agent — P4 per-agent retry budget", () => {
  it("refuses a refine once the budget is exhausted, without recording a new attempt", async () => {
    const ctx = makeCtx();
    const call = () =>
      refine.execute(
        { action: "parseResume", critique: "需要改", system_prompt: "修订后的 prompt 内容", changes_summary: "改了点东西" },
        ctx,
      );
    await call(); // attempt 1
    await call(); // attempt 2
    await call(); // attempt 3
    expect(ctx.attemptHistory["parseResume"].length).toBe(3);

    const fourth = await call(); // budget exhausted
    expect(fourth.ok).toBe(false);
    expect(fourth.summary).toMatch(/上限|预算|revert|回滚|接受/);
    expect(ctx.attemptHistory["parseResume"].length).toBe(3); // 4th did NOT add an attempt
  });
});
