import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/llm/gateway");
import { analyzeFacet } from "./facet-analyst";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import type { BuilderCtx } from "../types";

async function hermeticCtx(): Promise<BuilderCtx> {
  const ontology = await fetchRunnableOntology("recruit-gen-v1");
  return { runId: "r", domain: "recruit-gen-v1", ontology, emit: () => {}, budget: { maxTokens: 1e6, maxLlmCalls: 99 }, spent: { tokens: 0, calls: 0 } };
}

describe("analyzeFacet (hermetic, LLM mocked)", () => {
  it("produces a non-empty insight per facet from the real (mocked) LLM path", async () => {
    const ctx = await hermeticCtx();
    const persisted: unknown[] = [];
    const persist = async (row: unknown) => { persisted.push(row); };
    for (const facet of ["actions", "events", "rules", "objects"] as const) {
      const ins = await analyzeFacet(ctx, facet, persist);
      expect(ins.facet).toBe(facet);
      expect(ins.summary.length).toBeGreaterThan(0);
      expect(ins.degraded).toBe(false); // real (mocked) LLM call, never degraded
    }
    expect(persisted.length).toBe(4); // every analysis recorded
    for (const row of persisted as Array<{ degraded: boolean }>) {
      expect(row.degraded).toBe(false);
    }
  });
});
