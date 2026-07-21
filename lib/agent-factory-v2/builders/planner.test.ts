import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/llm/gateway");
import { plan } from "./planner";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import type { BuilderCtx, DomainUnderstanding } from "../types";

async function hermeticCtx(): Promise<BuilderCtx> {
  const ontology = await fetchRunnableOntology("recruit-gen-v1");
  return {
    runId: "planner-test",
    domain: "recruit-gen-v1",
    ontology,
    emit: () => {},
    budget: { maxTokens: 1e6, maxLlmCalls: 99 },
    spent: { tokens: 0, calls: 0 },
  };
}

function fakeUnderstanding(ctx: BuilderCtx): DomainUnderstanding {
  return {
    domain: ctx.domain,
    source: "snapshot",
    facets: [],
    synthesis: "Recruitment domain with resume parsing, matching, and invite pipeline.",
    counts: {
      actions: ctx.ontology.actions.length,
      events: ctx.ontology.events.length,
      rules: (ctx.ontology.rules ?? []).length,
      objects: ctx.ontology.objects.length,
    },
  };
}

describe("plan (hermetic, LLM mocked)", () => {
  it("returns agent briefs decomposed by the (mocked) planner LLM", async () => {
    const ctx = await hermeticCtx();
    const persisted: unknown[] = [];
    const persist = async (row: unknown) => { persisted.push(row); };
    const understanding = fakeUnderstanding(ctx);

    const result = await plan(ctx, understanding, persist);

    // The mocked planner returns a closeable 3-agent chain.
    expect(result.agents.length).toBeGreaterThanOrEqual(1);

    // Each brief has required fields
    for (const brief of result.agents) {
      expect(brief.name).toBeTruthy();
      expect(Array.isArray(brief.trigger)).toBe(true);
      expect(Array.isArray(brief.emit)).toBe(true);
      expect(Array.isArray(brief.objects)).toBe(true);
      expect(Array.isArray(brief.ruleRefs)).toBe(true);
      expect(typeof brief.rationale).toBe("string");
    }

    // skills can be empty (no shared skills in fallback)
    expect(Array.isArray(result.skills)).toBe(true);

    // LLM call persisted (real mocked call → never degraded)
    expect(persisted.length).toBe(1);
    const row = persisted[0] as { degraded: boolean; builder: string };
    expect(row.degraded).toBe(false);
    expect(row.builder).toBe("planner");
  });

  it("emits plan.ready event", async () => {
    const ctx = await hermeticCtx();
    const events: unknown[] = [];
    ctx.emit = (e) => events.push(e);
    const persist = async () => {};
    const understanding = fakeUnderstanding(ctx);

    const result = await plan(ctx, understanding, persist);

    const planReady = events.find((e) => (e as { t: string }).t === "plan.ready");
    expect(planReady).toBeTruthy();
    expect((planReady as { agents: number }).agents).toBe(result.agents.length);
  });
});
