import { describe, it, expect } from "vitest";
import {
  isRuleApplicable,
  filterRules,
  type MatchResumeRule,
  type MatchResumeStep,
} from "./match-resume";

const baseRule = (overrides: Partial<MatchResumeRule> = {}): MatchResumeRule => ({
  id: "10-1",
  businessLogicRuleName: "test",
  submissionCriteria: "sc",
  standardizedLogicRule: "logic",
  executor: "Agent",
  applicableClient: "通用",
  applicableDepartment: "N/A",
  ...overrides,
});

describe("isRuleApplicable", () => {
  it("keeps 通用 client rules regardless of department", () => {
    expect(
      isRuleApplicable(baseRule({ applicableClient: "通用" }), "腾讯", "互娱"),
    ).toBe(true);
  });

  it("keeps matching client + N/A department", () => {
    expect(
      isRuleApplicable(
        baseRule({ applicableClient: "腾讯", applicableDepartment: "N/A" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(true);
  });

  it("keeps matching client + 通用 department (treated as N/A)", () => {
    expect(
      isRuleApplicable(
        baseRule({ applicableClient: "腾讯", applicableDepartment: "通用" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(true);
  });

  it("keeps matching client + matching department", () => {
    expect(
      isRuleApplicable(
        baseRule({ applicableClient: "腾讯", applicableDepartment: "互娱" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(true);
  });

  it("drops matching client + different department", () => {
    expect(
      isRuleApplicable(
        baseRule({ applicableClient: "腾讯", applicableDepartment: "微信" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(false);
  });

  it("drops different client", () => {
    expect(
      isRuleApplicable(
        baseRule({ applicableClient: "字节", applicableDepartment: "N/A" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(false);
  });

  it("drops Human-executor rules even if client/department match", () => {
    expect(
      isRuleApplicable(
        baseRule({ executor: "Human", applicableClient: "通用" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(false);
  });
});

describe("filterRules", () => {
  it("filters per-step and drops steps with zero surviving rules", () => {
    const steps: MatchResumeStep[] = [
      {
        id: "10::s1",
        name: "S1",
        order: "1",
        description: "d",
        condition: "c",
        rules: [
          baseRule({ id: "10-1", applicableClient: "通用" }),
          baseRule({ id: "10-2", applicableClient: "字节", applicableDepartment: "N/A" }),
        ],
      },
      {
        id: "10::s2",
        name: "S2",
        order: "2",
        description: "d",
        condition: "c",
        rules: [
          baseRule({ id: "10-3", applicableClient: "字节", applicableDepartment: "N/A" }),
        ],
      },
    ];
    const out = filterRules(steps, "腾讯", "互娱");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("10::s1");
    expect(out[0].rules.map((r) => r.id)).toEqual(["10-1"]);
  });
});
