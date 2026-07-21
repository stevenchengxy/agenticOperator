// Verifies the 3-step "feed the brain the real ontology + tool contracts" change:
//   ① tool library carries deep external-platform I/O contracts (RoboHire returns),
//   ② read_ontology surfaces action.description / inputs / outputs / submission_criteria
//      + each tool's full parameters/returns (not just a one-line signature),
//   ③ the deterministic floor seeds the prompt from the action's description.
// All deterministic: read_ontology short-circuits on a pre-set ctx.ontology/registry.

import { describe, it, expect } from "vitest";
import { P1_TOOLS } from "./index";
import { RECRUITMENT_TOOLS } from "@/lib/tools/recruitment-tools";
import { ToolRegistry } from "@/lib/tools/registry";
import type { BrainCtx } from "../brain/types";
import type { DomainOntology, OntologyAction } from "@/lib/ontology-generator/ontology-source";

const read_ontology = P1_TOOLS.find((t) => t.name === "read_ontology")!;

describe("① tool library — external-platform I/O contracts are deep", () => {
  const byName = Object.fromEntries(RECRUITMENT_TOOLS.map((t) => [t.name, t]));

  it("robohire.parseResume.returns exposes the real parsed fields (not data:object)", () => {
    const ret = byName["robohire.parseResume"].returns as { properties: { data: { properties: Record<string, unknown> } } };
    const dataProps = ret.properties.data.properties;
    for (const f of ["skills", "workHistory", "gender", "endDate", "education"]) {
      expect(Object.keys(dataProps)).toContain(f);
    }
  });

  it("robohire.generateJd.returns exposes hardRequirements/niceToHave prose", () => {
    const ret = byName["robohire.generateJd"].returns as { properties: Record<string, unknown> };
    expect(Object.keys(ret.properties)).toContain("hardRequirements");
    expect(Object.keys(ret.properties)).toContain("niceToHave");
  });
});

// ── a minimal ontology with the RICH action fields the live data carries ──
const ACTION: OntologyAction = {
  id: "a1", name: "processResume",
  description: "Resume Parser Agent。经 RoboHire parseResumeDirect 抽取；性别从 rawText 补抽；毕业时间取 endDate。",
  category: "简历处理", actor: ["Agent"],
  trigger: ["CANDIDATE_DEDUP_PASSED"], triggered_event: ["RESUME_PROCESSED", "RESUME_PARSE_ERROR"],
  target_objects: ["Resume", "Candidate"], tool_use: [], system_prompt: "", user_prompt: "",
  inputs: [{ name: "resume_file_path", type: "String", description: "简历路径", source_object: "Resume.file_path", required: true }],
  outputs: [{ name: "resume_id", type: "String", description: "结构化简历编号" }],
  submission_criteria: "1. CANDIDATE_DEDUP_PASSED 已送达\n2. 简历可下载",
};
const ONT: DomainOntology = {
  source: "test", objects: [{ id: "Resume", name: "Resume", primary_key: "resume_id", properties: [{ name: "file_path", type: "String" }] } as never],
  actions: [ACTION], events: [], rules: [], workflow: [],
} as unknown as DomainOntology;

function ctx(): BrainCtx {
  return {
    domain: "Agents-generation", goal: "", emit: () => {}, specs: [],
    ontology: ONT, registry: new ToolRegistry().registerAll(RECRUITMENT_TOOLS),
    createdSkills: [], research: [], budget: { maxTokens: null, maxTurns: 1 }, spent: { tokens: 0, turns: 0 },
    currentPlan: null, attemptHistory: {}, lastSandboxRunIds: [], lastSandboxVersionLabel: null, lastSandbox: null,
    humanDirectives: [], lastValidation: null, priorReflections: [], rulesByAction: {}, suggestedToolsByAction: {},
    pendingSandboxDomain: null,
  } as unknown as BrainCtx;
}

describe("② read_ontology surfaces the rich action fields + full tool contracts", () => {
  it("each agent action carries description / inputs / outputs / submission_criteria", async () => {
    const r = await read_ontology.execute({}, ctx());
    const out = r.output as { agentActions: Array<Record<string, unknown>> };
    const a = out.agentActions.find((x) => x.name === "processResume")!;
    expect(a.description).toContain("parseResumeDirect");
    expect(a.inputs).toBeTruthy();
    expect((a.inputs as unknown[]).length).toBeGreaterThan(0);
    expect(a.outputs).toBeTruthy();
    expect(a.submission_criteria).toContain("CANDIDATE_DEDUP_PASSED");
    expect(a.has_prompt).toBe(true); // description counts as prompt guidance now
  });

  it("the tool catalog carries full parameters + returns (not just a signature)", async () => {
    const r = await read_ontology.execute({}, ctx());
    const out = r.output as { availableTools: Array<Record<string, unknown>> };
    const parse = out.availableTools.find((t) => t.name === "robohire.parseResume")!;
    expect(parse.parameters).toBeTruthy();
    expect(parse.returns).toBeTruthy();
    const ret = parse.returns as { properties: { data: { properties: Record<string, unknown> } } };
    expect(Object.keys(ret.properties.data.properties)).toContain("skills");
  });
});
