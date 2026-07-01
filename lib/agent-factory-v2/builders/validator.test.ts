import { describe, it, expect } from "vitest";
import { validateSpecs } from "./validator";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

/** Minimal GeneratedAgentSpec factory for tests. */
function makeSpec(opts: { key: string; slug: string } & Omit<Partial<GeneratedAgentSpec>, "key" | "slug">): GeneratedAgentSpec {
  const { key, slug, ...rest } = opts;
  return {
    key,
    actionName: key,
    slug,
    short: `${key}Agent`,
    domainId: "test",
    nameZh: key,
    kind: "llm",
    trigger: [],
    emit: [],
    tools: ["some.tool"],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "系统提示",
    userPrompt: "用户提示",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 90,
    promptSource: "ontology",
    ...rest,
  };
}

describe("validateSpecs", () => {
  it("a clean 2-spec chain → ok true", () => {
    // Agent A triggers on external event, emits CANDIDATE_PARSED
    // Agent B triggers on CANDIDATE_PARSED, emits CANDIDATE_MATCHED_DONE (terminal)
    const specA = makeSpec({
      key: "ParseResume",
      slug: "test-parse-resume",
      trigger: ["job.resume.submitted"],
      emit: ["CANDIDATE_PARSED"],
      tools: ["robohire.parseResume"],
    });
    const specB = makeSpec({
      key: "MatchResume",
      slug: "test-match-resume",
      trigger: ["CANDIDATE_PARSED"],
      emit: ["CANDIDATE_MATCHED_DONE"],
      tools: ["robohire.matchResume"],
    });

    const result = validateSpecs([specA, specB]);

    expect(result.ok).toBe(true);
    expect(result.danglingEmits).toHaveLength(0);
    expect(result.emptyToolAgents).toHaveLength(0);
    expect(result.slugCollisions).toHaveLength(0);
    // job.resume.submitted is consumed but not produced (external entry point)
    expect(result.orphanTriggers).toContain("job.resume.submitted");
  });

  it("a spec with empty tools → emptyToolAgents flags it", () => {
    const specA = makeSpec({
      key: "ParseResume",
      slug: "test-parse-resume",
      trigger: ["job.resume.submitted"],
      emit: ["CANDIDATE_PARSED"],
      tools: [], // empty!
    });
    const specB = makeSpec({
      key: "MatchResume",
      slug: "test-match-resume",
      trigger: ["CANDIDATE_PARSED"],
      emit: ["CANDIDATE_MATCHED_DONE"],
      tools: ["robohire.matchResume"],
    });

    const result = validateSpecs([specA, specB]);

    expect(result.ok).toBe(false);
    expect(result.emptyToolAgents).toContain("ParseResumeAgent");
  });

  it("slug collision → ok false and slugCollisions populated", () => {
    const specA = makeSpec({
      key: "AgentA",
      slug: "test-shared-slug",
      trigger: ["event.a"],
      emit: ["EVENT_A_DONE"],
    });
    const specB = makeSpec({
      key: "AgentB",
      slug: "test-shared-slug", // duplicate!
      trigger: ["EVENT_A_DONE"],
      emit: ["EVENT_B_DONE"],
    });

    const result = validateSpecs([specA, specB]);

    expect(result.ok).toBe(false);
    expect(result.slugCollisions).toContain("test-shared-slug");
  });

  it("dangling non-terminal emit → ok false", () => {
    // Agent emits an event that has no consumer and does not look terminal
    const spec = makeSpec({
      key: "OddAgent",
      slug: "test-odd-agent",
      trigger: ["entry.event"],
      emit: ["SOME_INTERMEDIATE_EVENT_WITH_NO_CONSUMER"],
    });

    const result = validateSpecs([spec]);

    expect(result.ok).toBe(false);
    expect(result.danglingEmits).toContain("SOME_INTERMEDIATE_EVENT_WITH_NO_CONSUMER");
  });

  it("terminal-looking dangling emit is NOT flagged as dangling", () => {
    const spec = makeSpec({
      key: "FinalAgent",
      slug: "test-final-agent",
      trigger: ["entry.event"],
      emit: ["CANDIDATE_RULE_CHECK_FAIL"],
    });

    const result = validateSpecs([spec]);

    // CANDIDATE_RULE_CHECK_FAIL contains "FAIL" → terminal, not a dangling emit
    expect(result.danglingEmits).not.toContain("CANDIDATE_RULE_CHECK_FAIL");
    // ok depends only on danglingEmits, emptyToolAgents, slugCollisions
    // This spec has tools=["some.tool"] from default so not empty
    expect(result.ok).toBe(true);
  });

  it("empty specs → ok true", () => {
    const result = validateSpecs([]);
    expect(result.ok).toBe(true);
    expect(result.danglingEmits).toHaveLength(0);
    expect(result.orphanTriggers).toHaveLength(0);
    expect(result.emptyToolAgents).toHaveLength(0);
    expect(result.slugCollisions).toHaveLength(0);
  });
});

// P2 — ontology-grounded checks. Active only when the caller passes the
// ontology context, so validateSpecs(specs) with no opts is unchanged.
describe("validateSpecs — coverage check (P2)", () => {
  it("flags an actor=Agent ontology action that has no spec", () => {
    const specs = [
      makeSpec({ key: "parseResume", slug: "test-parse", emit: ["E_DONE"] }),
    ];
    const agentActions = [
      { name: "parseResume", actor: ["Agent"] },
      { name: "ruleCheck", actor: ["Agent"] }, // uncovered
    ];
    const result = validateSpecs(specs, { agentActions });
    expect(result.ok).toBe(false);
    expect(
      result.structuredIssues.some((i) => i.kind === "uncovered-agent-action" && i.agentAction === "ruleCheck"),
    ).toBe(true);
  });

  it("does NOT flag coverage when agentActions is omitted (back-compat)", () => {
    const result = validateSpecs([makeSpec({ key: "x", slug: "test-x", emit: ["E_DONE"] })]);
    expect(result.structuredIssues.some((i) => i.kind === "uncovered-agent-action")).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("passes coverage when every Agent action has a spec (human actions not required)", () => {
    const specs = [
      makeSpec({ key: "parseResume", slug: "test-parse", emit: ["E_DONE"] }),
      makeSpec({ key: "ruleCheck", slug: "test-rc", emit: ["E_DONE2"] }),
    ];
    const agentActions = [
      { name: "parseResume", actor: ["Agent"] },
      { name: "ruleCheck", actor: ["Agent"] },
      { name: "humanGate", actor: ["Human"] },
    ];
    const result = validateSpecs(specs, { agentActions });
    expect(result.structuredIssues.some((i) => i.kind === "uncovered-agent-action")).toBe(false);
  });
});

describe("validateSpecs — fallback prompt is a hard failure (fully-AI)", () => {
  it("fails a spec whose prompt is a hardcoded fallback template (the LLM authored nothing)", () => {
    const s = makeSpec({ key: "x", slug: "test-x", emit: ["E_DONE"], promptSource: "fallback" });
    const result = validateSpecs([s]);
    expect(result.ok).toBe(false);
    expect(result.structuredIssues.some((i) => i.kind === "fallback-prompt" && i.agentAction === "x")).toBe(true);
  });

  it("an LLM-authored prompt passes", () => {
    const s = makeSpec({ key: "x", slug: "test-x", emit: ["E_DONE"], promptSource: "llm" });
    expect(validateSpecs([s]).structuredIssues.some((i) => i.kind === "fallback-prompt")).toBe(false);
  });
});

describe("validateSpecs — ungrounded event check (P2)", () => {
  it("flags a spec event that no ontology action declares", () => {
    const specs = [
      makeSpec({ key: "x", slug: "test-x", trigger: ["KNOWN_IN"], emit: ["HALLUCINATED_EVT"] }),
    ];
    const result = validateSpecs(specs, { knownEvents: ["KNOWN_IN", "REAL_OUT"] });
    expect(
      result.structuredIssues.some((i) => i.kind === "ungrounded-event" && i.event === "HALLUCINATED_EVT"),
    ).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("does NOT flag events when knownEvents is omitted (back-compat)", () => {
    const result = validateSpecs([makeSpec({ key: "x", slug: "test-x", trigger: ["A"], emit: ["B_DONE"] })]);
    expect(result.structuredIssues.some((i) => i.kind === "ungrounded-event")).toBe(false);
  });
});
