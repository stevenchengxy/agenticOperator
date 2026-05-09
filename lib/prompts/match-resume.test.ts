import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isRuleApplicable,
  filterRules,
  formatRulesByStep,
  substituteTemplate,
  fetchRules,
  generateMatchResumeRuleCheckPrompt,
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

describe("formatRulesByStep", () => {
  it("renders Markdown matching rule_structure.md §二 byte-for-byte", () => {
    const steps: MatchResumeStep[] = [
      {
        id: "10::validateRedlineAndBlacklist",
        name: "validateRedlineAndBlacklist",
        order: "1",
        description: "the description",
        condition: "the condition",
        rules: [
          baseRule({
            id: "10-25",
            businessLogicRuleName: "rule one",
            submissionCriteria: "sc one",
            standardizedLogicRule: "logic one",
          }),
          baseRule({
            id: "10-26",
            businessLogicRuleName: "rule two",
            submissionCriteria: "sc two",
            standardizedLogicRule: "logic two",
          }),
        ],
      },
    ];
    const expected = [
      "### Step 1: validateRedlineAndBlacklist",
      "- step_id: 10::validateRedlineAndBlacklist",
      "- enter_condition: the condition",
      "- description: the description",
      "",
      "#### Rule 10-25: rule one",
      "- submissionCriteria: sc one",
      "- logic: logic one",
      "",
      "#### Rule 10-26: rule two",
      "- submissionCriteria: sc two",
      "- logic: logic two",
    ].join("\n");
    expect(formatRulesByStep(steps)).toBe(expected);
  });

  it("orders steps by numeric `order` ascending", () => {
    const steps: MatchResumeStep[] = [
      {
        id: "s2", name: "S2", order: "2",
        description: "d2", condition: "c2",
        rules: [baseRule({ id: "10-2" })],
      },
      {
        id: "s1", name: "S1", order: "1",
        description: "d1", condition: "c1",
        rules: [baseRule({ id: "10-1" })],
      },
    ];
    const out = formatRulesByStep(steps);
    expect(out.indexOf("Step 1:")).toBeLessThan(out.indexOf("Step 2:"));
  });

  it("orders rules within a step by id ascending", () => {
    const steps: MatchResumeStep[] = [
      {
        id: "s1", name: "S1", order: "1",
        description: "d", condition: "c",
        rules: [
          baseRule({ id: "10-2", businessLogicRuleName: "two" }),
          baseRule({ id: "10-1", businessLogicRuleName: "one" }),
        ],
      },
    ];
    const out = formatRulesByStep(steps);
    expect(out.indexOf("Rule 10-1:")).toBeLessThan(out.indexOf("Rule 10-2:"));
  });

  it("preserves verbatim newlines and quotes inside submissionCriteria/logic", () => {
    const steps: MatchResumeStep[] = [
      {
        id: "s1", name: "S1", order: "1",
        description: "d", condition: "c",
        rules: [
          baseRule({
            id: "10-1",
            businessLogicRuleName: "n",
            submissionCriteria: 'line "1"\nline 2',
            standardizedLogicRule: "step a\nstep b",
          }),
        ],
      },
    ];
    const out = formatRulesByStep(steps);
    expect(out).toContain('- submissionCriteria: line "1"\nline 2');
    expect(out).toContain("- logic: step a\nstep b");
  });

  it("separates consecutive step blocks with exactly one blank line", () => {
    const steps: MatchResumeStep[] = [
      {
        id: "10::s1",
        name: "S1",
        order: "1",
        description: "d1",
        condition: "c1",
        rules: [
          baseRule({
            id: "10-1",
            businessLogicRuleName: "first",
            submissionCriteria: "sc1",
            standardizedLogicRule: "logic1",
          }),
        ],
      },
      {
        id: "10::s2",
        name: "S2",
        order: "2",
        description: "d2",
        condition: "c2",
        rules: [
          baseRule({
            id: "10-2",
            businessLogicRuleName: "second",
            submissionCriteria: "sc2",
            standardizedLogicRule: "logic2",
          }),
        ],
      },
    ];
    const expected = [
      "### Step 1: S1",
      "- step_id: 10::s1",
      "- enter_condition: c1",
      "- description: d1",
      "",
      "#### Rule 10-1: first",
      "- submissionCriteria: sc1",
      "- logic: logic1",
      "",
      "### Step 2: S2",
      "- step_id: 10::s2",
      "- enter_condition: c2",
      "- description: d2",
      "",
      "#### Rule 10-2: second",
      "- submissionCriteria: sc2",
      "- logic: logic2",
    ].join("\n");
    expect(formatRulesByStep(steps)).toBe(expected);
  });
});

describe("substituteTemplate", () => {
  it("replaces all four placeholders, including multiple occurrences", () => {
    const tmpl =
      "JD={{JOB_DESCRIPTION}} RES={{RESUME}} RBS={{RULES_BY_STEP}} " +
      "D1={{CURRENT_DATE}} D2={{CURRENT_DATE}}";
    const out = substituteTemplate(tmpl, {
      JOB_DESCRIPTION: "jd",
      RESUME: "re",
      RULES_BY_STEP: "rbs",
      CURRENT_DATE: "2026-05-09",
    });
    expect(out).toBe("JD=jd RES=re RBS=rbs D1=2026-05-09 D2=2026-05-09");
  });

  it("does not replace placeholders that aren't in the values map", () => {
    const tmpl = "{{JOB_DESCRIPTION}} {{UNKNOWN}}";
    const out = substituteTemplate(tmpl, {
      JOB_DESCRIPTION: "jd",
      RESUME: "re",
      RULES_BY_STEP: "rbs",
      CURRENT_DATE: "2026-05-09",
    });
    expect(out).toBe("jd {{UNKNOWN}}");
  });
});

describe("fetchRules", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed response on 200", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ action_steps: [] }),
    });
    const out = await fetchRules();
    expect(out.action_steps).toEqual([]);
  });

  it("calls the configured ontology URL", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ action_steps: [] }),
    });
    await fetchRules();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3500/api/v1/ontology/actions/matchResume/rules",
    );
  });

  it("throws with status code and URL in message on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "boom",
    });
    const err = await fetchRules().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/500/);
    expect((err as Error).message).toMatch(/localhost:3500/);
  });

  it("throws when response is missing action_steps", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ wrong: "shape" }),
    });
    await expect(fetchRules()).rejects.toThrow(/action_steps/);
  });
});

describe("generateMatchResumeRuleCheckPrompt (end-to-end)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("produces a fully substituted prompt for 腾讯", async () => {
    const fixtureModule = await import(
      "./__fixtures__/match-resume-rules.json"
    );
    const fixture = fixtureModule.default;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => fixture,
    });

    const out = await generateMatchResumeRuleCheckPrompt(
      "腾讯",
      "互动娱乐事业群",
      { title: "Senior Engineer" },
      { name: "Alice" },
    );

    // Step header rendered
    expect(out).toMatch(/### Step 1: validateRedlineAndBlacklist/);
    // 腾讯+通用 rule kept under the equivalence rule
    expect(out).toContain("Rule 10-38");
    // Human-executor rule dropped
    expect(out).not.toContain("Rule 10-19");
    // CURRENT_DATE substituted with today's UTC date
    const today = new Date().toISOString().slice(0, 10);
    expect(out).toContain(today);
    // No unreplaced placeholders remain
    expect(out).not.toContain("{{JOB_DESCRIPTION}}");
    expect(out).not.toContain("{{RESUME}}");
    expect(out).not.toContain("{{RULES_BY_STEP}}");
    expect(out).not.toContain("{{CURRENT_DATE}}");
    // Object inputs serialized as pretty JSON
    expect(out).toContain('"title": "Senior Engineer"');
    expect(out).toContain('"name": "Alice"');
  });

  it("passes string inputs through unchanged", async () => {
    const fixtureModule = await import(
      "./__fixtures__/match-resume-rules.json"
    );
    const fixture = fixtureModule.default;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => fixture,
    });

    const out = await generateMatchResumeRuleCheckPrompt(
      "腾讯",
      "互动娱乐事业群",
      "raw JD text",
      "raw resume text",
    );
    expect(out).toContain("raw JD text");
    expect(out).toContain("raw resume text");
  });

  it("throws when no rules survive filtering", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ action_steps: [] }),
    });
    await expect(
      generateMatchResumeRuleCheckPrompt("nope", "nope", "jd", "resume"),
    ).rejects.toThrow(/No applicable rules/);
  });
});
