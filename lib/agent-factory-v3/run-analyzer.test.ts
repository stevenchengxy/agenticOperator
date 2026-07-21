import { describe, it, expect } from "vitest";
import { runDigest } from "./run-analyzer";
import type { BrainEvent } from "./brain/types";

// #6 — whole-run analyzer digest (pure; the LLM critic's input).
describe("runDigest (#6 — run analyzer)", () => {
  const events: BrainEvent[] = [
    { t: "think", delta: "想一下" },
    { t: "tool.call", id: "1", name: "read_ontology", reasoning: "先读本体", input: {} },
    { t: "tool.result", id: "1", name: "read_ontology", ok: true, summary: "已读取" },
    { t: "tool.call", id: "2", name: "design_agent", reasoning: "设计第一个", input: {} },
    { t: "tool.result", id: "2", name: "design_agent", ok: false, summary: "未知动作 fooBar" },
    { t: "refine", actionName: "createJD", attemptNumber: 1, critique: "缺少前置校验" },
    { t: "sandbox", ran: 2, reachedTerminal: true, agents: [], events: [], deployed: 3, fullChainRan: true },
    { t: "done", tokensUsed: 1000, turns: 5, status: "finished" },
  ];

  it("counts thinking / tool calls / failures / refines in the header", () => {
    const d = runDigest(events);
    expect(d).toContain("1 段思考");
    expect(d).toContain("2 次工具调用(1 失败)");
    expect(d).toContain("1 次精修");
  });

  it("surfaces tool failures, the sandbox outcome, and the terminal status", () => {
    const d = runDigest(events);
    expect(d).toContain("✗ 失败: 未知动作 fooBar");
    expect(d).toContain("端到端通");
    expect(d).toContain("结束: finished");
  });

  it("is bounded in size so a huge run can't blow the critic's context", () => {
    const many: BrainEvent[] = Array.from({ length: 5000 }, (_, i) => ({ t: "tool.call", id: String(i), name: "x".repeat(50), reasoning: "y".repeat(50), input: {} }) as BrainEvent);
    expect(runDigest(many).length).toBeLessThanOrEqual(14000);
  });
});
