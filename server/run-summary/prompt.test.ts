// Tests for buildUserPrompt — the fix that stops the run summary from framing a
// transient infrastructure failure (or a retry-recovery) as a candidate
// rejection. These are pure-function tests (no DB / no LLM).

import { describe, it, expect } from "vitest";
import { buildUserPrompt, type AgentBreakdownRow } from "./prompt";

const RUN = {
  id: "run-1",
  triggerEvent: "RESUME_PROCESSED",
  status: "failed",
  startedAt: new Date("2026-06-05T10:00:00Z"),
  completedAt: new Date("2026-06-05T10:01:00Z"),
  suspendedReason: null,
  triggerData: "{}",
};

function row(partial: Partial<AgentBreakdownRow>): AgentBreakdownRow {
  return {
    agentName: "rule-check",
    steps: 1,
    failed: 0,
    infraFailed: 0,
    businessFailed: 0,
    recovered: 0,
    totalDurationMs: 100,
    lastNarrative: null,
    ...partial,
  };
}

const INFRA_ERR = JSON.stringify({
  message:
    "[Rule Check Agent] rule-check infra failure (jr=JR1, reason=llm-call-error) — retrying; candidate NOT rejected",
});

describe("buildUserPrompt — failure framing", () => {
  it("infra-only run: emits the 'not rejected' directive and no business-failure section", () => {
    const steps = [
      { nodeId: "rule-check", status: "failed", error: INFRA_ERR, durationMs: 50, attempts: 2 },
    ];
    const breakdown = [row({ failed: 1, infraFailed: 1 })];

    const out = buildUserPrompt(RUN, breakdown, steps, []);

    expect(out).toContain("失败性质");
    expect(out).toContain("基础设施故障");
    expect(out).toContain("候选人未被拒绝");
    // The infra section is present...
    expect(out).toContain("非候选人结论");
    // ...and the business-failure section is NOT.
    expect(out).not.toContain("业务失败（真实候选人结论）");
  });

  it("retry-recovery: a completed step with attempts>1 reads as recovered, not failed", () => {
    const steps = [
      { nodeId: "rule-check", status: "completed", error: null, durationMs: 80, attempts: 2 },
    ];
    const breakdown = [row({ recovered: 1 })];

    const out = buildUserPrompt({ ...RUN, status: "completed" }, breakdown, steps, []);

    expect(out).toContain("重试后成功");
    expect(out).not.toContain("基础设施故障（系统侧临时故障");
    expect(out).not.toContain("业务失败（真实候选人结论）");
  });

  it("business failure: emits the candidate-result section", () => {
    const steps = [
      { nodeId: "rule-check", status: "failed", error: "候选人学历不符合岗位硬性要求", durationMs: 60, attempts: 1 },
    ];
    const breakdown = [row({ failed: 1, businessFailed: 1 })];

    const out = buildUserPrompt(RUN, breakdown, steps, []);

    expect(out).toContain("业务失败（真实候选人结论）");
    expect(out).toContain("候选人学历不符合岗位硬性要求");
  });
});
