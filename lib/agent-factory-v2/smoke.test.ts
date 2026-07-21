import { describe, it, expect } from "vitest";
import { simulateChain } from "./smoke";
import { ToolRegistry } from "@/lib/tools/registry";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

/** Build a minimal GeneratedAgentSpec for testing. */
function makeSpec(
  short: string,
  trigger: string[],
  emit: string[],
  toolNames: string[] = [],
): GeneratedAgentSpec {
  return {
    key: short,
    actionName: short,
    slug: `test-${short.toLowerCase()}`,
    short,
    domainId: "test",
    nameZh: short,
    kind: "llm",
    trigger,
    emit,
    tools: toolNames,
    unresolvedTools: [],
    objects: [],
    systemPrompt: "test prompt",
    userPrompt: "test user",
    steps: toolNames.map((t) => ({ name: t, description: t, tool: t })),
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 90,
    promptSource: "fallback",
  };
}

/** Build a minimal ToolRegistry with optional dry-run execute. */
function makeRegistry(
  tools: Array<{ name: string; throws?: boolean }> = [],
): ToolRegistry {
  const reg = new ToolRegistry();
  for (const { name, throws } of tools) {
    reg.register({
      name,
      title: name,
      description: name,
      domain: "*",
      sideEffect: "read",
      parameters: {},
      returns: {},
      execute: throws
        ? async () => { throw new Error(`${name} failed`); }
        : async () => ({ ok: true }),
    });
  }
  return reg;
}

describe("simulateChain (hermetic, no LLM)", () => {
  it("runs a simple 2-agent chain, reports ranAgents and terminals", async () => {
    // Agent A: triggered by external/ENTRY, emits internal/NEXT
    // Agent B: triggered by internal/NEXT, emits domain/DONE
    const specs = [
      makeSpec("AgentA", ["external/ENTRY"], ["internal/NEXT"]),
      makeSpec("AgentB", ["internal/NEXT"], ["domain/DONE"]),
    ];
    const registry = makeRegistry();
    const result = await simulateChain(specs, registry, { dryRun: true });

    expect(result.ranAgents).toContain("AgentA");
    expect(result.ranAgents).toContain("AgentB");
    expect(result.errors).toHaveLength(0);
    expect(result.unreached).toHaveLength(0);
    // domain/DONE has no consumer → terminal
    expect(result.reachedTerminals).toContain("domain/DONE");
    // result shape is correct
    expect(typeof result.passed).toBe("boolean");
  });

  it("reports unreached agents (no entry path)", async () => {
    // Agent A: triggered by external/ENTRY, emits domain/DONE
    // Agent B: triggered by internal/ONLY_FROM_B_ITSELF — nobody emits this
    //   BUT it's also emitted by AgentB (self-loop scenario), so it IS in allEmittedEvents
    //   → not an entry event → AgentB is unreached
    const specs = [
      makeSpec("AgentA", ["external/ENTRY"], ["domain/DONE"]),
      makeSpec("AgentB", ["internal/ONLY_FROM_B_ITSELF"], ["domain/DONE_B", "internal/ONLY_FROM_B_ITSELF"]),
    ];
    const registry = makeRegistry();
    const result = await simulateChain(specs, registry, { dryRun: true });

    expect(result.ranAgents).toContain("AgentA");
    expect(result.unreached).toContain("AgentB");
    // passed = false because unreached > 0
    expect(result.passed).toBe(false);
  });

  it("captures tool errors in errors[] but does not throw", async () => {
    const specs = [
      makeSpec("AgentA", ["external/ENTRY"], ["domain/DONE"], ["failing.tool"]),
    ];
    const registry = makeRegistry([{ name: "failing.tool", throws: true }]);
    const result = await simulateChain(specs, registry, { dryRun: true });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].agent).toBe("AgentA");
    expect(result.errors[0].error).toContain("failing.tool failed");
    expect(result.passed).toBe(false);
  });

  it("returns passed=false when no terminals are reached (empty spec list)", async () => {
    const registry = makeRegistry();
    const result = await simulateChain([], registry, { dryRun: true });

    expect(result.ranAgents).toHaveLength(0);
    expect(result.reachedTerminals).toHaveLength(0);
    expect(result.passed).toBe(false);
  });

  it("calls execute on step tools during simulation", async () => {
    const called: string[] = [];
    const reg = new ToolRegistry();
    reg.register({
      name: "my.tool",
      title: "my tool",
      description: "a test tool",
      domain: "*",
      sideEffect: "read",
      parameters: {},
      returns: {},
      execute: async (_args, ctx) => {
        called.push(ctx?.traceId ?? "no-trace");
        return { ok: true };
      },
    });

    const specs = [
      makeSpec("AgentA", ["ext/ENTRY"], ["domain/DONE"], ["my.tool"]),
    ];
    const result = await simulateChain(specs, reg, { dryRun: true });

    expect(called).toHaveLength(1);
    expect(called[0]).toBe("smoke");
    expect(result.errors).toHaveLength(0);
  });

  it("handles dangling events (emitted mid-chain with no consumer, not a terminal name)", async () => {
    // mid/INTERMEDIATE doesn't match TERMINAL_RE → dangling
    const specs = [
      makeSpec("AgentA", ["ext/ENTRY"], ["mid/INTERMEDIATE"]),
    ];
    const registry = makeRegistry();
    const result = await simulateChain(specs, registry, { dryRun: true });

    // mid/INTERMEDIATE has no consumer
    expect(result.reachedTerminals).toContain("mid/INTERMEDIATE");
    // It doesn't match TERMINAL_RE → dangling
    expect(result.dangling).toContain("mid/INTERMEDIATE");
  });

  it("accepts DONE/FAILED events as legit terminals (not dangling)", async () => {
    const specs = [
      makeSpec("AgentA", ["ext/ENTRY"], ["domain/DONE", "domain/FAILED"]),
    ];
    const registry = makeRegistry();
    const result = await simulateChain(specs, registry, { dryRun: true });

    expect(result.reachedTerminals).toContain("domain/DONE");
    expect(result.reachedTerminals).toContain("domain/FAILED");
    // Both match TERMINAL_RE → not dangling
    expect(result.dangling).toHaveLength(0);
  });
});
