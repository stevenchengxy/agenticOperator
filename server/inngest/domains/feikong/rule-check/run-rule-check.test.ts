import { describe, it, expect } from "vitest";
import { loadSnapshotOntology } from "@/lib/ontology-generator/ontology-source";
import { COST_CONTROL_DOMAIN_ID } from "@/lib/domain-ids";
import type { Rule } from "@/lib/rule-check/types";
import { feikongRulesToEngine } from "./evaluators";
import { runExpenseRuleCheck } from "./run-rule-check";
import { buildFeikongScenario } from "../sim-data";

// Parse the in-repo 费控 snapshot rules once (offline — no Allmeta needed).
const rules = feikongRulesToEngine(loadSnapshotOntology(COST_CONTROL_DOMAIN_ID).rules as unknown as Rule[]);

describe("费控 rule-check (validateExpenseRules)", () => {
  it("selects all four groups (INV/STD/CMP/BUD) and verifies the hard baseline", () => {
    const r = runExpenseRuleCheck(rules, buildFeikongScenario("happy"));
    expect(r.selected.length).toBeGreaterThanOrEqual(24); // INV8 + STD6 + CMP6 + BUD4
    expect(r.verification.ok).toBe(true); // hard/risk baseline all grabbed
    expect(r.verification.missing).toEqual([]);
  });

  it("happy → no deduction, no risk, VALIDATED", () => {
    const r = runExpenseRuleCheck(rules, buildFeikongScenario("happy"));
    expect(r.decision).toBe("VALIDATED");
    expect(r.deductionTotal).toBe(0);
    expect(r.risk).toBeNull();
    expect(r.redlineFlag).toBe(false);
  });

  it("deduction → STD-01 核减 160, payable 1353, still VALIDATED (no risk)", () => {
    const r = runExpenseRuleCheck(rules, buildFeikongScenario("deduction"));
    expect(r.deductionTotal).toBe(160);
    expect(r.payableAfterDeduction).toBe(1353);
    expect(r.risk).toBeNull();
    expect(r.decision).toBe("VALIDATED");
    const std01 = r.evals.find((e) => e.code === "RULE-STD-01");
    expect(std01?.result).toBe("CLAMPED");
  });

  it("risk-split → CMP-01 拆分 T4/L3 → VIOLATED", () => {
    const r = runExpenseRuleCheck(rules, buildFeikongScenario("risk-split"));
    expect(r.decision).toBe("VIOLATED");
    expect(r.redlineFlag).toBe(true);
    expect(r.risk?.hitRule).toBe("RULE-CMP-01");
    expect(r.risk?.riskType).toBe("T4");
    expect(r.risk?.riskLevel).toBe("L3");
  });

  it("risk-private → CMP-06 私人消费 T7/L4 → VIOLATED", () => {
    const r = runExpenseRuleCheck(rules, buildFeikongScenario("risk-private"));
    expect(r.decision).toBe("VIOLATED");
    expect(r.risk?.hitRule).toBe("RULE-CMP-06");
    expect(r.risk?.riskType).toBe("T7");
    expect(r.risk?.riskLevel).toBe("L4");
  });
});

describe("费控 agent derivation", () => {
  it("derives 14 agents (10 llm + 4 simulated-human) with feikong- slugs", async () => {
    const { deriveAgents } = await import("@/lib/ontology-generator/analyze");
    const specs = deriveAgents(loadSnapshotOntology(COST_CONTROL_DOMAIN_ID));
    expect(specs.length).toBe(14);
    expect(specs.filter((s) => s.kind === "llm").length).toBe(10);
    expect(specs.filter((s) => s.kind === "simulated-human").length).toBe(4);
    expect(specs.every((s) => s.slug.startsWith("feikong-"))).toBe(true);
  });
});
