import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/llm/gateway");
import { selectTools } from "./toolsmith";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import { resolveRegistry } from "@/lib/tools/resolve-registry";
import type { BuilderCtx, TargetAgentBrief } from "../types";

async function hermeticCtx(): Promise<BuilderCtx> {
  const ontology = await fetchRunnableOntology("recruit-gen-v1");
  const registry = resolveRegistry("recruit-gen-v1", ontology);
  return {
    runId: "toolsmith-test",
    domain: "recruit-gen-v1",
    ontology,
    registry,
    emit: () => {},
    budget: { maxTokens: 1e6, maxLlmCalls: 99 },
    spent: { tokens: 0, calls: 0 },
  };
}

// Pick a recruit action that has tool_use in the snapshot (parseResume uses robohire.parseResume)
const PARSE_BRIEF: TargetAgentBrief = {
  name: "parseResume",
  trigger: ["recruitment/RESUME_RECEIVED"],
  emit: ["recruitment/RESUME_PARSED", "recruitment/RESUME_PARSE_FAILED"],
  objects: ["Resume", "Candidate"],
  ruleRefs: [],
  rationale: "Parse incoming resume and extract candidate data",
};

describe("selectTools (hermetic, LLM mocked)", () => {
  it("returns non-empty tools + retries number for a tool_use action (parseResume)", async () => {
    const ctx = await hermeticCtx();
    const persisted: unknown[] = [];
    const persist = async (row: unknown) => { persisted.push(row); };

    const result = await selectTools(ctx, PARSE_BRIEF, persist);

    // Should have at least one tool from the registry
    expect(result.tools.length).toBeGreaterThan(0);
    expect(typeof result.retries).toBe("number");
    expect(result.retries).toBeGreaterThanOrEqual(0);

    // All tool names should be in the registry
    for (const tool of result.tools) {
      expect(ctx.registry!.has(tool)).toBe(true);
    }

    // LLM call persisted (real mocked call → never degraded)
    expect(persisted.length).toBe(1);
    const row = persisted[0] as { degraded: boolean; builder: string; target: string };
    expect(row.degraded).toBe(false);
    expect(row.builder).toBe("toolsmith");
    expect(row.target).toBe("parseResume");
  });

  it("selects tools from the catalog regardless of action name", async () => {
    const ctx = await hermeticCtx();
    const persist = async () => {};
    const unknownBrief: TargetAgentBrief = {
      name: "NonExistentAction",
      trigger: [],
      emit: [],
      objects: [],
      ruleRefs: [],
      rationale: "unknown",
    };

    // The mocked ToolSmith parses real tool names out of the prompt catalog, so it
    // returns registry-valid tools even for an action with no ontology match.
    const result = await selectTools(ctx, unknownBrief, persist);
    expect(Array.isArray(result.tools)).toBe(true);
    expect(typeof result.retries).toBe("number");
    for (const tool of result.tools) {
      expect(ctx.registry!.has(tool)).toBe(true);
    }
  });
});
