// Fully-AI: there is NO tool floor. The brain picks an agent's tools from the
// real library (read_ontology surfaces per-action suggested_tools as VISIBLE
// candidates; design_agent's schema enum constrains picks to real names). If the
// brain under-picks, that surfaces — as an unresolved tool or a 0-tool agent the
// validator fails — it is NEVER silently auto-filled with tools it didn't choose.

import { describe, it, expect } from "vitest";
import { ToolRegistry, suggestToolsForAction, type ToolDescriptor } from "@/lib/tools/registry";
import { buildSpecFromAction } from "./index";
import type { OntologyAction } from "@/lib/ontology-generator/ontology-source";

const NAMES = [
  "minio.getResume", "robohire.parseResume", "robohire.matchResume", "robohire.generateJd",
  "robohire.inviteCandidate", "partnerpg.getRequirement", "partnerpg.getParsedResume",
  "partnerpg.saveCandidate", "partnerpg.saveMatchResults", "partnerpg.saveRuleCheckFail",
  "partnerpg.syncJd", "partnerpg.markInterview", "candidateLock.runLockCheck",
];
function reg(): ToolRegistry {
  const r = new ToolRegistry();
  for (const name of NAMES) {
    r.register({ name, title: name, description: name, domain: "recruit-gen-v1", sideEffect: "read",
      parameters: { type: "object" }, returns: { type: "object" } } as ToolDescriptor);
  }
  return r;
}
function action(name: string, targets: string[]): OntologyAction {
  return {
    id: name, name, actor: ["Agent"], trigger: ["IN"], triggered_event: ["OUT"],
    target_objects: targets, tool_use: [], system_prompt: "", user_prompt: "",
    outputs: [], side_effects: {},
  } as unknown as OntologyAction;
}

describe("no tool floor — the brain's picks are respected, under-picking surfaces", () => {
  const r = reg();
  const a = action("processResume", ["Resume", "Candidate"]);
  const suggestedTools = suggestToolsForAction(a, r, 5);

  it("a non-resolving tool name → spec has 0 tools + the name surfaced as unresolved (NOT auto-filled)", () => {
    const spec = buildSpecFromAction(a, "recruit-gen-v1", r, {
      authored: { systemPrompt: "x", tools: ["checkBlacklistStatus"] }, // no such tool, no fuzzy match
      suggestedTools, // suggestions are available but must NOT be auto-equipped
    });
    expect(spec.tools).toEqual([]); // no floor — validator will fail this as a 0-tool agent
    expect(spec.unresolvedTools).toContain("checkBlacklistStatus");
  });

  it("1 deliberate real tool + many suggestions → stays exactly 1 (no auto-complete)", () => {
    const spec = buildSpecFromAction(a, "recruit-gen-v1", r, {
      authored: { systemPrompt: "x", tools: ["partnerpg.getParsedResume"] },
      suggestedTools,
    });
    expect(spec.tools).toEqual(["partnerpg.getParsedResume"]);
  });

  it("well-tooled (≥2 deliberate picks) → exactly the brain's picks", () => {
    const spec = buildSpecFromAction(a, "recruit-gen-v1", r, {
      authored: { systemPrompt: "x", tools: ["minio.getResume", "robohire.parseResume"] },
      suggestedTools,
    });
    expect(spec.tools.sort()).toEqual(["minio.getResume", "robohire.parseResume"].sort());
  });
});
