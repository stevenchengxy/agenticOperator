// AI-authored I/O schemas + AI-written code.
//   · specToAgentCode renders the brain's input/output schema into typed TS
//     interfaces (grounded in the ontology DataObjects).
//   · validateAgentCode gates LLM-written code on real syntax (valid → ok;
//     broken → concrete errors the brain can fix).

import { describe, it, expect } from "vitest";
import { specToAgentCode, validateAgentCode } from "./codegen";
import { ToolRegistry, type ToolDescriptor } from "@/lib/tools/registry";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    name: "robohire.parseResume", title: "解析简历", description: "解析",
    domain: "recruit-gen-v1", sideEffect: "read", parameters: { type: "object" }, returns: { type: "object" },
    impl: { module: "@/lib/tools/robohire", export: "parseResume" },
  } as ToolDescriptor);
  return r;
}

function spec(): GeneratedAgentSpec {
  return {
    key: "processResume", actionName: "processResume", slug: "agents-generation-process-resume",
    short: "ProcessResumeAgent", domainId: "Agents-generation", nameZh: "简历解析", kind: "llm",
    trigger: ["CANDIDATE_DEDUP_PASSED"], emit: ["RESUME_PROCESSED", "RESUME_INFO_MISSING"],
    tools: ["robohire.parseResume"], unresolvedTools: [], objects: ["Resume", "Candidate"],
    systemPrompt: "你是简历解析 agent。", userPrompt: "处理", steps: [], ruleRefs: [],
    retries: 1, hitl: false, confidence: 0.9, promptSource: "llm",
    inputSchema: [
      { field: "candidate_id", type: "String", description: "候选人编号", source: "Candidate.candidate_id" },
      { field: "resume_id", type: "String", description: "简历编号" },
    ],
    outputSchema: [{ field: "parsed", type: "Object", description: "结构化简历" }],
  } as GeneratedAgentSpec;
}

describe("specToAgentCode — typed I/O from AI schemas", () => {
  const code = specToAgentCode(spec(), reg());
  it("renders a typed Input interface from inputSchema (grounded in DataObject)", () => {
    expect(code).toContain("interface ProcessResumeAgentInput");
    expect(code).toContain("candidate_id: string;");
    expect(code).toContain("源: Candidate.candidate_id");
  });
  it("renders a typed Output interface from outputSchema", () => {
    expect(code).toContain("interface ProcessResumeAgentOutput");
    expect(code).toContain("parsed: Record<string, unknown>;");
  });
  it("types event.data as the input interface", () => {
    expect(code).toContain("const input = event.data as ProcessResumeAgentInput;");
  });
  it("the render itself is syntactically valid TS", async () => {
    const v = await validateAgentCode(code);
    expect(v.ok).toBe(true);
  }, 15_000);
});

describe("validateAgentCode — gates AI-written code on real syntax", () => {
  it("accepts a well-formed agent file", async () => {
    const good = `import { inngest } from '@/server/inngest/client';
export const a = inngest.createFunction({ id: 'x', name: 'x', triggers: [{ event: 'E' }] }, async ({ event, step }) => {
  const input = event.data;
  return { ok: true };
});`;
    const v = await validateAgentCode(good);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });
  it("rejects code with a syntax error + returns the error", async () => {
    const bad = `export const a = inngest.createFunction({ id: 'x' , async ({ event ) => {{{ `; // broken
    const v = await validateAgentCode(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });
});
