// Selection Harness — the build-vs-reuse router. Event signature is the contract:
// an agent that consumes the required trigger can slot into the chain (reuse);
// nothing matching → generate. Deterministic, no DB.

import { describe, it, expect } from "vitest";
import { scoreAgent, selectFromAgents } from "./selection";
import { PRESET_AGENTS } from "./registry";
import type { RegistryAgent, SelectionRequest } from "./types";

const matchResume = PRESET_AGENTS.find((a) => a.id === "match-resume-agent")!;

describe("scoreAgent — event-signature matching", () => {
  it("exact: consumes the trigger AND produces all wanted emits", () => {
    const s = scoreAgent(matchResume, { triggerEvents: ["MATCH_RULE_CHECK_PASSED"], emitEvents: ["MATCH_FAILED"] });
    expect(s.signatureMatch).toBe("exact");
    expect(s.score).toBeGreaterThan(0.6);
  });
  it("trigger: consumes the trigger, emit not constrained", () => {
    const s = scoreAgent(matchResume, { triggerEvents: ["MATCH_RULE_CHECK_PASSED"] });
    expect(s.signatureMatch).toBe("trigger");
    expect(s.score).toBeGreaterThan(0.5);
  });
  it("none: doesn't consume the required trigger", () => {
    const s = scoreAgent(matchResume, { triggerEvents: ["SOMETHING_ELSE"] });
    expect(s.signatureMatch).toBe("none");
    expect(s.score).toBe(0);
  });
  it("a sandbox-proven recruitment match scores above an unproven one", () => {
    const unproven: RegistryAgent = { ...matchResume, id: "gen-x", source: "generated", sandboxProven: false };
    const a = scoreAgent(matchResume, { triggerEvents: ["MATCH_RULE_CHECK_PASSED"], domain: "招聘-v1" });
    const b = scoreAgent(unproven, { triggerEvents: ["MATCH_RULE_CHECK_PASSED"], domain: "招聘-v1" });
    expect(a.score).toBeGreaterThan(b.score);
  });
});

describe("selectFromAgents — reuse vs generate", () => {
  it("REUSES a preset when the trigger matches", () => {
    const req: SelectionRequest = { triggerEvents: ["MATCH_RULE_CHECK_PASSED"], domain: "招聘-v1" };
    const r = selectFromAgents(PRESET_AGENTS, req);
    expect(r.decision).toBe("reuse");
    expect(r.best?.id).toBe("match-resume-agent");
    expect(r.reason).toContain("复用");
  });

  it("recruitment domain ALIASES match (recruit-gen-v1 ≈ 招聘-v1)", () => {
    const r = selectFromAgents(PRESET_AGENTS, { triggerEvents: ["RESUME_DOWNLOADED"], domain: "recruit-gen-v1" });
    expect(r.decision).toBe("reuse");
    expect(r.best?.id).toBe("resume-parser-agent");
  });

  it("GENERATES when no agent consumes the required trigger", () => {
    const r = selectFromAgents(PRESET_AGENTS, { triggerEvents: ["EXPENSE_SUBMITTED"], domain: "feikong" });
    expect(r.decision).toBe("generate");
    expect(r.best).toBeNull();
    expect(r.reason).toContain("生成");
  });

  it("picks the BEST match when several could slot in (ranked by score)", () => {
    // both rule-check and candidate-ownership consume RESUME_PROCESSED; the one that
    // also produces the wanted emit wins.
    const r = selectFromAgents(PRESET_AGENTS, { triggerEvents: ["RESUME_PROCESSED"], emitEvents: ["MATCH_RULE_CHECK_PASSED"], domain: "招聘-v1" });
    expect(r.decision).toBe("reuse");
    expect(r.best?.id).toBe("rule-check-agent");
  });
});
