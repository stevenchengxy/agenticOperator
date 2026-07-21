// specToAgentCode — render a generated agent SPEC into a readable Inngest agent
// .ts file that mirrors the hand-written agents (server/inngest/agents/*.ts), so
// the user can see + own + edit each generated agent's code, not just its spec.

import { describe, it, expect } from "vitest";
import { specToAgentCode } from "./codegen";
import { buildRecruitmentRegistry } from "@/lib/tools/recruitment-tools";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

const reg = buildRecruitmentRegistry();

function spec(over: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "matchResume", actionName: "matchResume",
    slug: "agents-generation-match-resume", short: "MatchResumeAgent",
    domainId: "Agents-generation", nameZh: "岗位匹配",
    kind: "llm", trigger: ["MATCH_RULE_CHECK_PASSED"],
    emit: ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED"],
    tools: ["robohire.matchResume", "partnerpg.saveMatchResults"],
    unresolvedTools: [], objects: ["Resume", "Candidate"],
    systemPrompt: "你是岗位匹配专家。对比简历与 JD，给出匹配分。",
    retries: 2, promptSource: "llm", confidence: 0.9, toolFlow: "parallel",
    ...over,
  } as unknown as GeneratedAgentSpec;
}

describe("specToAgentCode", () => {
  it("emits an Inngest createFunction with the spec's id, name, retries, trigger", () => {
    const code = specToAgentCode(spec(), reg);
    expect(code).toContain("inngest.createFunction");
    expect(code).toContain("agents-generation-match-resume");
    expect(code).toContain("retries: 2");
    expect(code).toContain("MATCH_RULE_CHECK_PASSED"); // trigger
  });

  it("imports the REAL client export for each bound tool (native-looking)", () => {
    const code = specToAgentCode(spec(), reg);
    expect(code).toContain("matchResumeDirect");                 // robohire.matchResume
    expect(code).toContain("@/lib/robohire-client");
    expect(code).toContain("saveMatchResultsToPartnerPg");       // partnerpg.saveMatchResults
    expect(code).toContain("@/lib/partner-pg/match-results");
  });

  it("groups multiple exports from the same module into one import", () => {
    const code = specToAgentCode(spec({ tools: ["robohire.matchResume", "robohire.parseResume"] }), reg);
    const robohireImports = code.split("\n").filter((l) => l.includes("@/lib/robohire-client"));
    expect(robohireImports.length).toBe(1);
    expect(robohireImports[0]).toContain("matchResumeDirect");
    expect(robohireImports[0]).toContain("parseResumeDirect");
  });

  it("embeds the authored system prompt verbatim", () => {
    const code = specToAgentCode(spec(), reg);
    expect(code).toContain("SYSTEM_PROMPT");
    expect(code).toContain("你是岗位匹配专家");
  });

  it("emits a sendEvent for each emit event", () => {
    const code = specToAgentCode(spec(), reg);
    expect(code).toContain("MATCH_PASSED_NEED_INTERVIEW");
    expect(code).toContain("MATCH_FAILED");
    expect(code).toContain("sendEvent");
  });

  it("renders a rule-check agent that fetches rules dynamically", () => {
    const code = specToAgentCode(spec({
      actionName: "ruleCheckForMatchResume", short: "RuleCheckForMatchResumeAgent",
      slug: "agents-generation-rule-check", emit: ["MATCH_RULE_CHECK_PASSED", "MATCH_RULE_CHECK_FAILED"],
      tools: ["ontology.fetchActionRules", "partnerpg.getParsedResume", "partnerpg.saveRuleCheckFail"],
    }), reg);
    expect(code).toContain("fetchOntologyActionRules"); // dynamic rule fetch
    expect(code).toContain("@/lib/ontology-rules");
  });

  it("escapes backticks in the prompt so the template literal is valid", () => {
    const code = specToAgentCode(spec({ systemPrompt: "use `code` here" }), reg);
    expect(code).not.toMatch(/SYSTEM_PROMPT = `[^`]*`code`/); // raw backtick would break
    expect(code).toContain("\\`code\\`");
  });

  it("produces valid-ish TS (balanced braces, exports a const)", () => {
    const code = specToAgentCode(spec(), reg);
    expect(code).toMatch(/export const \w+Agent =/);
    expect((code.match(/\{/g) || []).length).toBe((code.match(/\}/g) || []).length);
  });
});
