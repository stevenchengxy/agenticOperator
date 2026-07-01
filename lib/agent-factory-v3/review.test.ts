// P3 — independent review. The DETERMINISTIC half (branch coverage, tool
// grounding, degraded flag) is pure code — free + reliable — so the LLM judge is
// reserved strictly for the semantic "are mandatory rules encoded" check. These
// pin the deterministic findings.

import { describe, it, expect } from "vitest";
import { reviewSpecsDeterministic } from "./review";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

function spec(p: Partial<GeneratedAgentSpec> & { actionName: string }): GeneratedAgentSpec {
  return {
    key: p.actionName,
    actionName: p.actionName,
    slug: p.slug ?? p.actionName,
    short: p.actionName,
    domainId: "d",
    nameZh: p.actionName,
    kind: "llm",
    trigger: p.trigger ?? [],
    emit: p.emit ?? [],
    tools: p.tools ?? ["some.tool"],
    unresolvedTools: p.unresolvedTools ?? [],
    objects: [],
    systemPrompt: p.systemPrompt ?? "系统提示",
    userPrompt: "x",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 0.9,
    promptSource: "llm",
    toolFlow: "parallel",
    degraded: p.degraded,
  } as GeneratedAgentSpec;
}

describe("reviewSpecsDeterministic (P3)", () => {
  it("flags a multi-emit agent whose prompt omits a branch event", () => {
    const s = spec({
      actionName: "matchResume",
      emit: ["MATCH_PASSED", "MATCH_FAILED"],
      systemPrompt: "命中则发出 MATCH_PASSED", // MATCH_FAILED never mentioned
    });
    const f = reviewSpecsDeterministic([s]);
    expect(f.some((x) => x.kind === "branch-uncovered" && x.detail.includes("MATCH_FAILED"))).toBe(true);
  });

  it("does NOT flag a multi-emit agent whose prompt covers every branch", () => {
    const s = spec({
      actionName: "matchResume",
      emit: ["MATCH_PASSED", "MATCH_FAILED"],
      systemPrompt: "命中发出 MATCH_PASSED，不符发出 MATCH_FAILED",
    });
    expect(reviewSpecsDeterministic([s]).some((x) => x.kind === "branch-uncovered")).toBe(false);
  });

  it("flags an agent with an ungrounded (unresolved) tool", () => {
    const s = spec({ actionName: "x", emit: ["E_DONE"], unresolvedTools: ["checkBlacklist"] });
    const f = reviewSpecsDeterministic([s]);
    expect(f.some((x) => x.kind === "ungrounded-tool" && x.detail.includes("checkBlacklist"))).toBe(true);
  });

  it("flags a degraded shell agent", () => {
    const s = spec({ actionName: "x", emit: ["E_DONE"], degraded: true });
    expect(reviewSpecsDeterministic([s]).some((x) => x.kind === "degraded")).toBe(true);
  });

  it("a clean single-emit, grounded, non-degraded agent yields no findings", () => {
    const s = spec({ actionName: "x", emit: ["E_DONE"], tools: ["real.tool"], unresolvedTools: [] });
    expect(reviewSpecsDeterministic([s])).toEqual([]);
  });
});
