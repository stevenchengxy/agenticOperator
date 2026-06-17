import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/llm/gateway");
import { runBuild } from "./conductor";
import type { BuildStore } from "./conductor";
import type { BuildEvent } from "./types";
import type { LlmCallRow } from "./ledger";

/** In-memory BuildStore — no DB, hermetic. */
function makeMemoryStore(): BuildStore & {
  events: Array<{ runId: string; seq: number; e: BuildEvent }>;
  llmCalls: LlmCallRow[];
  runs: Array<{ id: string; domain: string; status: string; tokensUsed: number }>;
} {
  let idCounter = 0;
  const runs: Array<{ id: string; domain: string; status: string; tokensUsed: number }> = [];
  const events: Array<{ runId: string; seq: number; e: BuildEvent }> = [];
  const llmCalls: LlmCallRow[] = [];

  return {
    runs,
    events,
    llmCalls,
    async createRun(domain: string) {
      const id = `run-${++idCounter}`;
      runs.push({ id, domain, status: "running", tokensUsed: 0 });
      return id;
    },
    async appendEvent(runId: string, seq: number, e: BuildEvent) {
      events.push({ runId, seq, e });
    },
    async appendLlmCall(row: LlmCallRow) {
      llmCalls.push(row);
    },
    async finishRun(runId: string, status: string, tokensUsed: number) {
      const run = runs.find((r) => r.id === runId);
      if (run) { run.status = status; run.tokensUsed = tokensUsed; }
    },
  };
}

describe("runBuild (hermetic, LLM mocked)", () => {
  it("emits events in order: build.start first, build.done last; persists ≥5 llm calls; returns understanding with 4 facets; status done", async () => {
    const store = makeMemoryStore();
    const onEventCalls: BuildEvent[] = [];
    const onEvent = (e: BuildEvent) => onEventCalls.push(e);

    const result = await runBuild({
      domain: "recruit-gen-v1",
      store,
      onEvent,
      budget: { maxTokens: 1_000_000, maxLlmCalls: 200 },
    });

    // Returns runId + understanding
    expect(result.runId).toBeTruthy();
    expect(result.understanding).toBeDefined();
    expect(result.understanding.facets).toHaveLength(4);
    expect(result.understanding.synthesis.length).toBeGreaterThan(0);

    // Events are emitted to onEvent
    expect(onEventCalls.length).toBeGreaterThan(0);
    expect(onEventCalls[0].t).toBe("build.start");
    expect(onEventCalls[onEventCalls.length - 1].t).toBe("build.done");

    // Events are persisted to store
    const storedEvents = store.events;
    expect(storedEvents.length).toBeGreaterThan(0);
    expect(storedEvents[0].e.t).toBe("build.start");
    expect(storedEvents[storedEvents.length - 1].e.t).toBe("build.done");
    // Seq should be monotonically increasing
    const seqs = storedEvents.map((ev) => ev.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    // ≥5 LLM calls persisted (4 facet analyses + 1 integration at minimum)
    expect(store.llmCalls.length).toBeGreaterThanOrEqual(5);

    // All llm calls are real (mocked) → never degraded
    for (const call of store.llmCalls) {
      expect(call.degraded).toBe(false);
    }

    // Run status is "done"
    const run = store.runs.find((r) => r.id === result.runId);
    expect(run).toBeDefined();
    expect(run?.status).toBe("done");

    // understanding.ready event should be present
    const readyEvent = onEventCalls.find((e) => e.t === "understanding.ready");
    expect(readyEvent).toBeDefined();
  });

  it("returns GeneratedAgentSpec for recruit-gen-v1 (plan + generate stages complete)", async () => {
    const store = makeMemoryStore();
    const onEventCalls: BuildEvent[] = [];
    const onEvent = (e: BuildEvent) => onEventCalls.push(e);

    const result = await runBuild({
      domain: "recruit-gen-v1",
      store,
      onEvent,
      budget: { maxTokens: 1_000_000, maxLlmCalls: 200 },
    });

    // Plan should have at least one agent brief (mocked planner returns a 3-agent chain)
    expect(result.plan).toBeDefined();
    expect(result.plan.agents.length).toBeGreaterThanOrEqual(1);

    // Specs: one per brief
    expect(result.specs).toBeDefined();
    expect(result.specs.length).toBeGreaterThanOrEqual(1);

    // Each spec has the required fields
    for (const spec of result.specs) {
      expect(spec.key).toBeTruthy();
      expect(spec.slug).toMatch(/^recruit-gen-v1-/);
      expect(spec.systemPrompt.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(spec.tools)).toBe(true);
    }

    // plan.ready event should have been emitted
    const planReadyEvent = onEventCalls.find((e) => e.t === "plan.ready");
    expect(planReadyEvent).toBeDefined();

    // agent.assembled events should be present — at least one per final spec.
    // (A re-plan round can produce more assembled events than final specs.)
    const assembledEvents = onEventCalls.filter((e) => e.t === "agent.assembled");
    expect(assembledEvents.length).toBeGreaterThanOrEqual(result.specs.length);
  });

  it("returns smoke result in RunBuildResult and emits smoke.result event", async () => {
    const store = makeMemoryStore();
    const onEventCalls: BuildEvent[] = [];
    const onEvent = (e: BuildEvent) => onEventCalls.push(e);

    const result = await runBuild({
      domain: "recruit-gen-v1",
      store,
      onEvent,
      budget: { maxTokens: 1_000_000, maxLlmCalls: 200 },
    });

    // result must include smoke and repairs
    expect(result.smoke).toBeDefined();
    expect(typeof result.smoke.passed).toBe("boolean");
    expect(Array.isArray(result.smoke.ranAgents)).toBe(true);
    expect(Array.isArray(result.smoke.reachedTerminals)).toBe(true);
    expect(Array.isArray(result.smoke.dangling)).toBe(true);
    expect(Array.isArray(result.smoke.unreached)).toBe(true);
    expect(Array.isArray(result.smoke.errors)).toBe(true);
    expect(typeof result.repairs).toBe("number");

    // smoke.result event must have been emitted
    const smokeResultEvent = onEventCalls.find((e) => e.t === "smoke.result") as
      | { t: "smoke.result"; passed: boolean; ran: number; repairs: number }
      | undefined;
    expect(smokeResultEvent).toBeDefined();
    expect(typeof smokeResultEvent!.passed).toBe("boolean");
    expect(typeof smokeResultEvent!.ran).toBe("number");
    expect(typeof smokeResultEvent!.repairs).toBe("number");

    // smoke.result must appear before build.done
    const smokeIdx = onEventCalls.findIndex((e) => e.t === "smoke.result");
    const doneIdx = onEventCalls.findIndex((e) => e.t === "build.done");
    expect(smokeIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(smokeIdx);
  });

  it("returns skills array and validation in RunBuildResult; emits skill.built and validation events", async () => {
    const store = makeMemoryStore();
    const onEventCalls: BuildEvent[] = [];
    const onEvent = (e: BuildEvent) => onEventCalls.push(e);

    const result = await runBuild({
      domain: "recruit-gen-v1",
      store,
      onEvent,
      budget: { maxTokens: 1_000_000, maxLlmCalls: 200 },
    });

    // result.skills must be an array
    expect(result.skills).toBeDefined();
    expect(Array.isArray(result.skills)).toBe(true);

    // Each skill has the required SkillSpec fields
    for (const skill of result.skills) {
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.purpose).toBe("string");
      expect(typeof skill.promptFragment).toBe("string");
      expect(Array.isArray(skill.tools)).toBe(true);
      expect(typeof skill.decisionRule).toBe("string");
    }

    // result.validation must be present with ok + issues
    expect(result.validation).toBeDefined();
    expect(typeof result.validation.ok).toBe("boolean");
    expect(Array.isArray(result.validation.issues)).toBe(true);
    expect(Array.isArray(result.validation.danglingEmits)).toBe(true);
    expect(Array.isArray(result.validation.orphanTriggers)).toBe(true);
    expect(Array.isArray(result.validation.emptyToolAgents)).toBe(true);
    expect(Array.isArray(result.validation.slugCollisions)).toBe(true);

    // validation event must have been emitted
    const validationEvent = onEventCalls.find((e) => e.t === "validation") as
      | { t: "validation"; ok: boolean; issues: string[] }
      | undefined;
    expect(validationEvent).toBeDefined();
    expect(typeof validationEvent!.ok).toBe("boolean");
    expect(Array.isArray(validationEvent!.issues)).toBe(true);

    // validation event must appear before smoke.result
    const validationIdx = onEventCalls.findIndex((e) => e.t === "validation");
    const smokeIdx = onEventCalls.findIndex((e) => e.t === "smoke.result");
    expect(validationIdx).toBeGreaterThan(-1);
    expect(smokeIdx).toBeGreaterThan(validationIdx);

    // skill.built events: one per plan skill (plan.skills may be empty for degraded plan)
    const skillBuiltEvents = onEventCalls.filter((e) => e.t === "skill.built") as
      Array<{ t: "skill.built"; name: string; tools: string[] }>;
    expect(skillBuiltEvents.length).toBe(result.skills.length);
  });

  it("emits a log event at build start that reveals ontology source (snapshot vs Neo4j)", async () => {
    const store = makeMemoryStore();
    const onEventCalls: BuildEvent[] = [];
    const onEvent = (e: BuildEvent) => onEventCalls.push(e);

    await runBuild({
      domain: "recruit-gen-v1",
      store,
      onEvent,
      budget: { maxTokens: 1_000_000, maxLlmCalls: 200 },
    });

    // The source-log event should be present early in the sequence
    const logEvents = onEventCalls.filter((e) => e.t === "log") as Array<{ t: "log"; line: string }>;
    expect(logEvents.length).toBeGreaterThan(0);

    // The first log event should contain either "snapshot" or "Neo4j"
    const sourceLog = logEvents[0];
    expect(
      sourceLog.line.includes("snapshot") || sourceLog.line.includes("Neo4j"),
    ).toBe(true);
  });
});
