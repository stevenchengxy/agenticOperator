import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/llm/gateway");
import { fix } from "./fixer";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import { resolveRegistry } from "@/lib/tools/resolve-registry";
import type { BuilderCtx } from "../types";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

async function hermeticCtx(): Promise<BuilderCtx> {
  const ontology = await fetchRunnableOntology("recruit-gen-v1");
  const registry = resolveRegistry("recruit-gen-v1", ontology);
  return {
    runId: "fixer-test",
    domain: "recruit-gen-v1",
    ontology,
    registry,
    emit: () => {},
    budget: { maxTokens: 1e6, maxLlmCalls: 99 },
    spent: { tokens: 0, calls: 0 },
  };
}

function makeSpec(overrides: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "parseResume",
    actionName: "parseResume",
    slug: "recruit-gen-v1-parse-resume",
    short: "ParseResumeAgent",
    domainId: "recruit-gen-v1",
    nameZh: "解析简历",
    kind: "llm",
    trigger: ["recruitment/RESUME_RECEIVED"],
    emit: ["recruitment/RESUME_PARSED", "recruitment/RESUME_PARSE_FAILED"],
    tools: ["robohire.parseResume"],
    unresolvedTools: [],
    objects: ["Resume", "Candidate"],
    systemPrompt: "你是解析简历的 agent",
    userPrompt: "请解析简历",
    steps: [{ name: "parse", description: "parse resume", tool: "robohire.parseResume" }],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 75,
    promptSource: "fallback",
    ...overrides,
  };
}

describe("fix (hermetic, LLM mocked)", () => {
  it("returns changed:false and original spec when the LLM proposes no structural patch", async () => {
    const ctx = await hermeticCtx();
    const spec = makeSpec();
    const persisted: unknown[] = [];
    const persist = async (row: unknown) => { persisted.push(row); };

    const result = await fix(ctx, spec, { kind: "dangling", detail: "mid/INTERMEDIATE has no consumer" }, persist);

    // Mocked fixer returns only a reason (no trigger/emit/tools) → no-op, changed:false
    expect(result.changed).toBe(false);
    expect(result.spec).toEqual(spec);

    // LLM call was persisted (real mocked call → never degraded)
    expect(persisted.length).toBe(1);
    const row = persisted[0] as { degraded: boolean; builder: string; target: string };
    expect(row.degraded).toBe(false);
    expect(row.builder).toBe("fixer");
    expect(row.target).toBe("ParseResumeAgent");
  });

  it("does not throw on the (mocked) LLM path", async () => {
    const ctx = await hermeticCtx();
    const spec = makeSpec();
    const persist = async () => {};

    // Must not throw
    await expect(
      fix(ctx, spec, { kind: "unreached", detail: "agent never triggered" }, persist),
    ).resolves.toBeDefined();
  });

  it("emits repair.start and repair.done events", async () => {
    const ctx = await hermeticCtx();
    const events: unknown[] = [];
    ctx.emit = (e) => events.push(e);
    const spec = makeSpec();
    const persist = async () => {};

    await fix(ctx, spec, { kind: "tool-error", detail: "robohire.parseResume threw" }, persist);

    const starts = events.filter((e) => (e as { t: string }).t === "repair.start");
    const dones = events.filter((e) => (e as { t: string }).t === "repair.done");

    expect(starts).toHaveLength(1);
    expect(dones).toHaveLength(1);

    const start = starts[0] as { t: string; agent: string; kind: string };
    expect(start.agent).toBe("ParseResumeAgent");
    expect(start.kind).toBe("tool-error");

    const done = dones[0] as { t: string; agent: string; changed: boolean };
    expect(done.agent).toBe("ParseResumeAgent");
    expect(typeof done.changed).toBe("boolean");
  });

  it("returns changed:false when ctx.registry is undefined (degrade immediately)", async () => {
    const ctx = await hermeticCtx();
    ctx.registry = undefined;
    const spec = makeSpec();
    const persist = async () => {};

    const result = await fix(ctx, spec, { kind: "dangling", detail: "test" }, persist);
    expect(result.changed).toBe(false);
    expect(result.spec).toEqual(spec);
  });

  it("handles all failure kinds without throwing", async () => {
    const ctx = await hermeticCtx();
    const spec = makeSpec();
    const persist = async () => {};
    const kinds: Array<"dangling" | "unreached" | "tool-error"> = ["dangling", "unreached", "tool-error"];

    for (const kind of kinds) {
      await expect(
        fix(ctx, spec, { kind, detail: `test ${kind}` }, persist),
      ).resolves.toMatchObject({ changed: expect.any(Boolean) });
    }
  });
});
