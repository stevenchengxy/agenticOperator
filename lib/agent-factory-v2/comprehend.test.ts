import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/llm/gateway");
import { comprehendDomain } from "./comprehend";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import type { BuilderCtx, BuildEvent } from "./types";

async function hermeticCtx(): Promise<{ ctx: BuilderCtx; events: BuildEvent[] }> {
  const ontology = await fetchRunnableOntology("recruit-gen-v1");
  const events: BuildEvent[] = [];
  const ctx: BuilderCtx = {
    runId: "r3",
    domain: "recruit-gen-v1",
    ontology,
    emit: (e: BuildEvent) => events.push(e),
    budget: { maxTokens: 1e6, maxLlmCalls: 99 },
    spent: { tokens: 0, calls: 0 },
  };
  return { ctx, events };
}

describe("comprehendDomain (hermetic, LLM mocked)", () => {
  it("runs 4 facet analysts in parallel then integrates; emits facet.analyzed ×4 + understanding.ready", async () => {
    const { ctx, events } = await hermeticCtx();
    const persisted: unknown[] = [];
    const persist = async (row: unknown) => { persisted.push(row); };

    const result = await comprehendDomain(ctx, persist);

    // 4 facet.analyzed events emitted
    const facetAnalyzed = events.filter((e) => e.t === "facet.analyzed");
    expect(facetAnalyzed).toHaveLength(4);

    // 1 understanding.ready event emitted
    const readyEvents = events.filter((e) => e.t === "understanding.ready");
    expect(readyEvents).toHaveLength(1);

    // result has 4 facets + non-empty synthesis
    expect(result.facets).toHaveLength(4);
    expect(result.synthesis.length).toBeGreaterThan(0);

    // persist called 5× (4 analyses + 1 integration)
    expect(persisted.length).toBe(5);
  });
});
