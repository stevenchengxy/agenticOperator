// The gold standard = the 招聘-v1 agents as the answer key; the factory's output is
// graded against it. Pairing is derived by signature; scoring is pure.

import { describe, it, expect } from "vitest";
import {
  buildGoldStandard, scoreAgainstStandard, compareToStandard, realAgentsWithTools,
  type GoldStandardAgent,
} from "./gold-standard";
import type { RegistryAgent } from "./types";

// the recruitment ontology's agent-actions (what Agents-generation must regenerate)
const RECRUIT_ACTIONS = [
  { action: "processResume", triggerEvents: ["RESUME_DOWNLOADED"], emitEvents: ["RESUME_PROCESSED"] },
  { action: "ruleCheckForMatchResume", triggerEvents: ["RESUME_PROCESSED"], emitEvents: ["MATCH_RULE_CHECK_PASSED", "MATCH_RULE_CHECK_FAILED"] },
  { action: "matchResume", triggerEvents: ["MATCH_RULE_CHECK_PASSED"], emitEvents: ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_PASSED_NO_INTERVIEW", "MATCH_FAILED"] },
];

describe("buildGoldStandard — pair ontology actions to real agents by signature", () => {
  const std = buildGoldStandard(RECRUIT_ACTIONS);

  it("pairs each recruitment action to its real production agent", () => {
    const byAction = Object.fromEntries(std.map((s) => [s.action, s]));
    expect(byAction["processResume"]?.inngestId).toBe("resume-parser-agent");
    expect(byAction["ruleCheckForMatchResume"]?.inngestId).toBe("rule-check-agent");
    expect(byAction["matchResume"]?.inngestId).toBe("match-resume-agent");
  });

  it("carries the real decision-branch outcomes (emit) from AGENT_MAP", () => {
    const match = std.find((s) => s.action === "matchResume")!;
    expect(match.emit).toContain("MATCH_PASSED_NEED_INTERVIEW");
    expect(match.emit).toContain("MATCH_FAILED");
    expect(match.pairConfidence).toBeGreaterThan(0.5);
  });
});

describe("realAgentsWithTools — reverse-engineer tools from real source", () => {
  it("scans namespaced tool calls out of the actual agent .ts", () => {
    const reals = realAgentsWithTools();
    const match = reals.find((r) => r.id === "match-resume-agent");
    expect(match).toBeTruthy();
    // match-resume-agent calls robohire + partnerpg in its real source
    expect(match!.tools.some((t) => t.startsWith("robohire."))).toBe(true);
  });
});

describe("scoreAgainstStandard — grade a generated agent vs the standard", () => {
  const std: GoldStandardAgent = {
    action: "matchResume", short: "Matcher", inngestId: "match-resume-agent",
    trigger: ["MATCH_RULE_CHECK_PASSED"], emit: ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_PASSED_NO_INTERVIEW", "MATCH_FAILED"],
    tools: ["robohire.matchResume", "partnerpg.getRequirement"], pairConfidence: 0.8, sourceRef: "x",
  };
  const mk = (over: Partial<RegistryAgent>): RegistryAgent => ({
    id: "g", name: "gen", source: "generated", domain: "d", capability: "", triggerEvents: [], emitEvents: [], tools: [], codeRef: "v", status: "draft", sandboxProven: false, ...over,
  });

  it("a faithful regeneration scores high", () => {
    const s = scoreAgainstStandard(mk({
      triggerEvents: ["MATCH_RULE_CHECK_PASSED"],
      emitEvents: ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_PASSED_NO_INTERVIEW", "MATCH_FAILED"],
      tools: ["robohire.matchResume", "partnerpg.getRequirement"],
    }), std);
    expect(s.signatureMatch).toBe(1);
    expect(s.branchCoverage).toBe(1);
    expect(s.toolCoverage).toBe(1);
    expect(s.total).toBeGreaterThan(0.95);
  });

  it("missing a decision branch lowers branchCoverage + is flagged", () => {
    const s = scoreAgainstStandard(mk({
      triggerEvents: ["MATCH_RULE_CHECK_PASSED"],
      emitEvents: ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED"], // missing NO_INTERVIEW
      tools: ["robohire.matchResume", "partnerpg.getRequirement"],
    }), std);
    expect(s.branchCoverage).toBeCloseTo(2 / 3, 1);
    expect(s.notes.some((n) => n.includes("MATCH_PASSED_NO_INTERVIEW"))).toBe(true);
    expect(s.total).toBeLessThan(0.95);
  });

  it("tool dimension is excluded (null) when the standard has no scanned tools", () => {
    const s = scoreAgainstStandard(mk({ triggerEvents: ["MATCH_RULE_CHECK_PASSED"], emitEvents: std.emit }), { ...std, tools: [] });
    expect(s.toolCoverage).toBeNull();
  });
});

describe("compareToStandard — whole-set grade + uncovered actions", () => {
  const std = buildGoldStandard(RECRUIT_ACTIONS);
  it("scores matched generated agents + reports uncovered standards", () => {
    const generated: RegistryAgent[] = [
      { id: "g1", name: "regen-match", source: "generated", domain: "d", capability: "", triggerEvents: ["MATCH_RULE_CHECK_PASSED"], emitEvents: ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_PASSED_NO_INTERVIEW", "MATCH_FAILED"], tools: ["robohire.matchResume"], codeRef: "v", status: "draft", sandboxProven: false },
    ];
    const cmp = compareToStandard(generated, std, "Agents-generation");
    // matchResume got covered; processResume + ruleCheck did not
    expect(cmp.scores.some((s) => s.action === "matchResume")).toBe(true);
    expect(cmp.uncovered).toContain("processResume");
    expect(cmp.meanTotal).toBeGreaterThan(0);
  });
});
