/**
 * generate.test.ts — Task B1 hermetic tests
 *
 * `generateAgents` runs against the MOCKED LLM gateway (see __mocks__/gateway.ts).
 * Every builder makes a real (mocked) LLM call — no fallback, no network / DB.
 */

import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/llm/gateway");
import { generateAgents } from "./generate";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import { resolveRegistry } from "@/lib/tools/resolve-registry";
import { plan } from "./builders/planner";
import type { BuilderCtx, BuildPlan, BuildEvent } from "./types";
import type { LlmCallRow } from "./ledger";

async function hermeticCtx(): Promise<BuilderCtx> {
  const ontology = await fetchRunnableOntology("recruit-gen-v1");
  const registry = resolveRegistry("recruit-gen-v1", ontology);
  return {
    runId: "generate-test",
    domain: "recruit-gen-v1",
    ontology,
    registry,
    emit: () => {},
    budget: { maxTokens: 1_000_000, maxLlmCalls: 200 },
    spent: { tokens: 0, calls: 0 },
  };
}

/** Build a realistic plan using the (mocked) Planner (same path as conductor). */
async function buildMockPlan(ctx: BuilderCtx): Promise<BuildPlan> {
  return plan(ctx, {
    domain: ctx.domain,
    source: "snapshot",
    facets: [],
    synthesis: "Recruitment domain.",
    counts: {
      actions: ctx.ontology.actions.length,
      events: ctx.ontology.events.length,
      rules: (ctx.ontology.rules ?? []).length,
      objects: ctx.ontology.objects.length,
    },
  }, async () => {});
}

describe("generateAgents (hermetic, LLM mocked)", () => {
  it("returns one GeneratedAgentSpec per planned brief", async () => {
    const ctx = await hermeticCtx();
    const buildPlan = await buildMockPlan(ctx);
    // Mocked planner returns a 3-agent chain.
    expect(buildPlan.agents.length).toBeGreaterThanOrEqual(1);

    const persisted: LlmCallRow[] = [];
    const persist = async (row: LlmCallRow) => { persisted.push(row); };

    const specs = await generateAgents(ctx, buildPlan, persist);

    // Must return one spec per brief
    expect(specs.length).toBe(buildPlan.agents.length);

    // Each spec has required fields
    for (const spec of specs) {
      expect(spec.key).toBeTruthy();
      expect(spec.actionName).toBeTruthy();
      expect(spec.slug).toBeTruthy();
      expect(spec.short).toBeTruthy();
      expect(spec.domainId).toBe("recruit-gen-v1");
      expect(spec.systemPrompt.trim().length).toBeGreaterThan(0);
      expect(spec.userPrompt.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(spec.tools)).toBe(true);
      expect(Array.isArray(spec.steps)).toBe(true);
      expect(spec.steps.length).toBeGreaterThan(0);
      expect(typeof spec.retries).toBe("number");
    }

    // Tool-bound: at least some specs have tools
    const toolBound = specs.filter((s) => s.tools.length > 0);
    expect(toolBound.length).toBeGreaterThan(0);

    // Every LLM call persisted and NOT degraded (real mocked calls)
    expect(persisted.length).toBeGreaterThan(0);
    for (const row of persisted) {
      expect(row.degraded).toBe(false);
    }
  });

  it("emits agent.start and agent.assembled for each brief", async () => {
    const ctx = await hermeticCtx();
    const buildPlan = await buildMockPlan(ctx);

    const emitted: BuildEvent[] = [];
    ctx.emit = (e) => emitted.push(e);

    await generateAgents(ctx, buildPlan, async () => {});

    const starts = emitted.filter((e) => e.t === "agent.start");
    const assembled = emitted.filter((e) => e.t === "agent.assembled");

    expect(starts.length).toBe(buildPlan.agents.length);
    expect(assembled.length).toBe(buildPlan.agents.length);

    // Every start has a name; every assembled has tools array + promptSource
    for (const e of starts) {
      expect((e as { t: "agent.start"; name: string }).name).toBeTruthy();
    }
    for (const e of assembled) {
      const ev = e as { t: "agent.assembled"; name: string; tools: string[]; promptSource: string };
      expect(ev.name).toBeTruthy();
      expect(Array.isArray(ev.tools)).toBe(true);
      expect(ev.promptSource).toBeTruthy();
    }
  });

  it("specs have correct slug format: <domain>-<kebab-action>", async () => {
    const ctx = await hermeticCtx();
    const buildPlan = await buildMockPlan(ctx);

    const specs = await generateAgents(ctx, buildPlan, async () => {});

    for (const spec of specs) {
      expect(spec.slug).toMatch(/^recruit-gen-v1-[a-z0-9-]+$/);
      expect(spec.short).toMatch(/Agent$/);
    }
  });

  it("runs in parallel: all briefs complete; emitted events include all agent names", async () => {
    const ctx = await hermeticCtx();
    const buildPlan = await buildMockPlan(ctx);

    const emitted: BuildEvent[] = [];
    ctx.emit = (e) => emitted.push(e);

    const specs = await generateAgents(ctx, buildPlan, async () => {});

    const agentNames = new Set(specs.map((s) => s.actionName));
    const startedNames = new Set(
      emitted
        .filter((e) => e.t === "agent.start")
        .map((e) => (e as { t: "agent.start"; name: string }).name),
    );

    // All brief names should appear in both specs and started events
    for (const brief of buildPlan.agents) {
      expect(agentNames.has(brief.name)).toBe(true);
      expect(startedNames.has(brief.name)).toBe(true);
    }
  });
});
