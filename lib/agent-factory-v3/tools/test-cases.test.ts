import { describe, it, expect } from "vitest";
import { proposeTestCases } from "./test-cases";
import type { BrainCtx, BrainEvent } from "../brain/types";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

// Minimal spec set: one entry agent (trigger has no producer) → entry event A.
const specs = [
  { slug: "d-a", short: "AAgent", actionName: "A", trigger: ["EVT_IN"], emit: ["EVT_OUT"], tools: [], objects: [], inputSchema: [] },
  { slug: "d-b", short: "BAgent", actionName: "B", trigger: ["EVT_OUT"], emit: ["EVT_DONE"], tools: [], objects: [], inputSchema: [] },
] as unknown as GeneratedAgentSpec[];

function makeCtx(emit: (e: BrainEvent) => void): BrainCtx {
  return { domain: "test-domain", specs, ontology: null, emit } as unknown as BrainCtx;
}

describe("proposeTestCases — the sandbox approval gate", () => {
  it("authors cases (golden fallback when the gateway is off), parks for approval, and emits the proposal", async () => {
    const events: BrainEvent[] = [];
    const ctx = makeCtx((e) => events.push(e));

    const res = await proposeTestCases(ctx);

    // returns ok + tells the brain to wait
    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/确认|执行|重新生成/);

    // parks the conductor + stores the cases on ctx for sandbox_run to fire
    expect(ctx.awaitingApproval).toBe(true);
    expect((ctx.testCases ?? []).length).toBeGreaterThan(0);
    // the golden fallback grounds each case on a real entry event (EVT_IN here)
    expect(ctx.testCases?.[0].entryEvent).toBe("EVT_IN");

    // surfaces as a 子大脑 in the activity log + emits the proposal card event
    expect(events.some((e) => e.t === "subagent.start")).toBe(true);
    expect(events.some((e) => e.t === "subagent.done")).toBe(true);
    const tc = events.find((e) => e.t === "test.cases");
    expect(tc).toBeTruthy();
    expect(tc && tc.t === "test.cases" && tc.awaitingApproval).toBe(true);
  });
});
