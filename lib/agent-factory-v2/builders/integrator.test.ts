import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/llm/gateway");
import { integrate } from "./integrator";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import type { BuilderCtx, FacetInsight } from "../types";

async function hermeticCtx(): Promise<BuilderCtx> {
  const ontology = await fetchRunnableOntology("recruit-gen-v1");
  return {
    runId: "r2",
    domain: "recruit-gen-v1",
    ontology,
    emit: () => {},
    budget: { maxTokens: 1e6, maxLlmCalls: 99 },
    spent: { tokens: 0, calls: 0 },
  };
}

function makeFakeInsights(): FacetInsight[] {
  return [
    { facet: "actions", summary: "Actions summary", highlights: ["Parse resume", "Match candidate"], degraded: false },
    { facet: "events", summary: "Events summary", highlights: ["resume.parsed", "candidate.matched"], degraded: false },
    { facet: "rules", summary: "Rules summary", highlights: ["Age >= 18", "Degree required"], degraded: false },
    { facet: "objects", summary: "Objects summary", highlights: ["Candidate", "JobRequisition"], degraded: false },
  ];
}

describe("integrate (hermetic, LLM mocked)", () => {
  it("returns a DomainUnderstanding with non-empty synthesis and correct counts", async () => {
    const ctx = await hermeticCtx();
    const persisted: unknown[] = [];
    const persist = async (row: unknown) => { persisted.push(row); };
    const insights = makeFakeInsights();

    const result = await integrate(ctx, insights, persist);

    expect(result.domain).toBe("recruit-gen-v1");
    expect(result.source).toBe("snapshot");
    expect(result.facets).toHaveLength(4);
    expect(result.synthesis.length).toBeGreaterThan(0);
    // counts come from ctx.ontology lengths
    expect(result.counts.actions).toBeGreaterThan(0);
    expect(result.counts.events).toBeGreaterThanOrEqual(0);
    expect(result.counts.rules).toBeGreaterThanOrEqual(0);
    expect(result.counts.objects).toBeGreaterThan(0);
    // 1 LLM call persisted (real mocked call → never degraded)
    expect(persisted.length).toBe(1);
    const row = persisted[0] as { degraded: boolean; builder: string; purpose: string };
    expect(row.degraded).toBe(false);
    expect(row.builder).toBe("integrator");
    expect(row.purpose).toBe("整合本体理解");
  });

  it("synthesis is the LLM-authored cross-facet text", async () => {
    const ctx = await hermeticCtx();
    const persist = async () => {};
    const insights = makeFakeInsights();
    const result = await integrate(ctx, insights, persist);
    // The integrator now returns the real (mocked) LLM synthesis — non-empty prose.
    expect(result.synthesis.trim().length).toBeGreaterThan(0);
  });
});
