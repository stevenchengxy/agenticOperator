// Auto-compaction — the loop folds the verbose early history into a state
// summary once it gets large, so a long run stays in-context WITHOUT being
// turn-capped short. Must (a) only fire when big, (b) keep system+goal + recent
// turns verbatim, (c) NEVER split a tool-call/tool-result pair (API-valid).

import { describe, it, expect } from "vitest";
import { maybeCompact, buildStateSummary } from "./conductor";
import type { ChatMsg } from "./stream-gateway";
import type { BrainCtx } from "./types";

function ctx(): BrainCtx {
  return {
    domain: "d", goal: "g", emit: () => {}, specs: [
      { short: "AAgent", trigger: ["IN"], emit: ["MID"], tools: ["t1", "t2"], unresolvedTools: [] },
      { short: "BAgent", trigger: ["MID"], emit: ["OUT"], tools: ["t3"], unresolvedTools: ["missingTool"] },
    ],
    ontology: null, registry: null, createdSkills: [], research: [],
    budget: { maxTokens: null, maxTurns: 200 }, spent: { tokens: 0, turns: 0 },
    currentPlan: { version: 2, agents: [{}, {}], summary: "x", notes: [] },
    attemptHistory: { AAgent: [{}, {}] }, lastSandboxRunIds: ["r1", "r2"],
    lastSandboxVersionLabel: null,
    lastValidation: { ok: false, agentIssueMap: { "b-agent": [] } },
    priorReflections: [], rulesByAction: {}, suggestedToolsByAction: {},
  } as unknown as BrainCtx;
}

/** Build [system, user, then N (assistant+tool_calls, tool result) turn-blocks]. */
function bigHistory(turns: number, padTo: number): ChatMsg[] {
  const m: ChatMsg[] = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "GOAL" },
  ];
  const pad = "x".repeat(padTo);
  for (let i = 0; i < turns; i++) {
    m.push({ role: "assistant", content: `think ${i} ${pad}`, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_ontology", arguments: "{}" } }] } as ChatMsg);
    m.push({ role: "tool", tool_call_id: `c${i}`, content: `result ${i} ${pad}` } as ChatMsg);
  }
  return m;
}

describe("buildStateSummary", () => {
  it("captures the structured state from ctx (specs, plan, validation, sandbox)", () => {
    const s = buildStateSummary(ctx());
    expect(s).toContain("已自动压缩");
    expect(s).toContain("AAgent");                 // a spec
    expect(s).toContain("缺 missingTool");          // an unresolved tool surfaces
    expect(s).toContain("v2");                      // plan version
    expect(s).toContain("有问题");                  // failed validation
    expect(s).toContain("跑过 2 个 run");            // sandbox state
  });
});

describe("maybeCompact", () => {
  it("does NOT compact a small history", async () => {
    const m = bigHistory(3, 100); // tiny
    expect(await maybeCompact(m, ctx())).toBe(false);
    expect(m.length).toBe(2 + 3 * 2);
  });

  it("compacts a large history → system + goal + summary + recent 6 turns", async () => {
    const m = bigHistory(30, 3000); // ~30 turns × ~6k chars = well over 120k
    const before = m.length;
    const ok = await maybeCompact(m, ctx()); // LLM tier falls back to "" with no gateway → tier-1 only
    expect(ok).toBe(true);
    expect(m.length).toBeLessThan(before);
    // head preserved
    expect(m[0]).toEqual({ role: "system", content: "SYSTEM PROMPT" });
    expect(m[1]).toEqual({ role: "user", content: "GOAL" });
    // summary injected at index 2
    expect(m[2].role).toBe("system");
    expect(typeof m[2].content === "string" && m[2].content.includes("已自动压缩")).toBe(true);
    // the first message AFTER the summary must be an assistant-with-tool_calls
    // (never a dangling tool result) — pairing stays API-valid
    expect(m[3].role).toBe("assistant");
    expect(Array.isArray(m[3].tool_calls) && m[3].tool_calls!.length > 0).toBe(true);
    // recent KEEP_TURNS=6 turns kept → 6 (assistant+tool) pairs = 12 msgs after the summary
    expect(m.length).toBe(3 + 6 * 2);
    // the very last turn is preserved verbatim
    expect(m[m.length - 2].content).toContain("think 29");
  });
});
