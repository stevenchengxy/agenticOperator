import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/llm/gateway");
import { writePrompt } from "./prompt-writer";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import { resolveRegistry } from "@/lib/tools/resolve-registry";
import type { BuilderCtx, TargetAgentBrief } from "../types";

async function hermeticCtx(): Promise<BuilderCtx> {
  const ontology = await fetchRunnableOntology("recruit-gen-v1");
  const registry = resolveRegistry("recruit-gen-v1", ontology);
  return {
    runId: "promptwriter-test",
    domain: "recruit-gen-v1",
    ontology,
    registry,
    emit: () => {},
    budget: { maxTokens: 1e6, maxLlmCalls: 99 },
    spent: { tokens: 0, calls: 0 },
  };
}

const PARSE_BRIEF: TargetAgentBrief = {
  name: "parseResume",
  trigger: ["recruitment/RESUME_RECEIVED"],
  emit: ["recruitment/RESUME_PARSED", "recruitment/RESUME_PARSE_FAILED"],
  objects: ["Resume", "Candidate"],
  ruleRefs: [],
  rationale: "Parse incoming resume and extract candidate data",
};

// Tools that parseResume uses (from snapshot)
const PARSE_TOOLS = ["robohire.parseResume"];

describe("writePrompt (hermetic, LLM mocked)", () => {
  it("returns a non-empty LLM-authored system prompt", async () => {
    const ctx = await hermeticCtx();
    const persisted: unknown[] = [];
    const persist = async (row: unknown) => { persisted.push(row); };

    const result = await writePrompt(ctx, PARSE_BRIEF, PARSE_TOOLS, persist);

    // System prompt must be non-empty (real mocked LLM text)
    expect(result.system.trim().length).toBeGreaterThan(0);

    // User prompt must be non-empty (runtime template)
    expect(result.user.trim().length).toBeGreaterThan(0);

    // The prompt is now LLM-authored, not the deterministic ontology template.
    expect(result.source).toBe("llm");

    // LLM call persisted (real mocked call → never degraded)
    expect(persisted.length).toBe(1);
    const row = persisted[0] as { degraded: boolean; builder: string; target: string };
    expect(row.degraded).toBe(false);
    expect(row.builder).toBe("promptwriter");
    expect(row.target).toBe("parseResume");
  });

  it("produces an LLM-authored prompt for an unknown brief name too", async () => {
    const ctx = await hermeticCtx();
    const persist = async () => {};
    const unknownBrief: TargetAgentBrief = {
      name: "UnknownAction",
      trigger: ["some/event"],
      emit: ["some/result"],
      objects: [],
      ruleRefs: [],
      rationale: "some unknown action",
    };
    const tools: string[] = [];

    const result = await writePrompt(ctx, unknownBrief, tools, persist);

    // Should still produce a non-empty system prompt from the (mocked) LLM.
    expect(result.system.trim().length).toBeGreaterThan(0);
    expect(result.source).toBe("llm");
  });
});
