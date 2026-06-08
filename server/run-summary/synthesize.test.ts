// Tests for the shared run-summary synthesizer.
//
// We mock @/server/db and @/server/llm/gateway so the tests are hermetic:
// no Postgres / no network. The in-memory `runAiSummaryStore` simulates the
// (run_id, last_activity_at) unique constraint to exercise the eager+lazy
// race path.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────
// Hoisted state used by the @/server/db mock factory. Declared before
// vi.mock so the factory closure sees it (vi.mock is hoisted but only the
// factory body — the references resolve at call time).

type AnyRow = Record<string, unknown>;

const state: {
  runs: Map<string, AnyRow>;
  activities: AnyRow[];
  summaries: AnyRow[];
} = {
  runs: new Map(),
  activities: [],
  summaries: [],
};

function findSummaryByKey(runId: string | null, lastActivityAt: Date | null) {
  return state.summaries.find(
    (r) =>
      r.run_id === runId &&
      (r.last_activity_at instanceof Date && lastActivityAt instanceof Date
        ? (r.last_activity_at as Date).getTime() ===
          (lastActivityAt as Date).getTime()
        : r.last_activity_at === lastActivityAt),
  );
}

vi.mock("@/server/db", () => ({
  prisma: {
    workflowRun: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return state.runs.get(where.id) ?? null;
      }),
    },
    agentActivity: {
      findMany: vi.fn(
        async ({ where }: { where: { runId: string } }) => {
          const rows = state.activities.filter((a) => a.runId === where.runId);
          // mimic orderBy createdAt desc + take 200
          rows.sort(
            (a, b) =>
              (b.createdAt as Date).getTime() -
              (a.createdAt as Date).getTime(),
          );
          return rows.slice(0, 200);
        },
      ),
    },
    runAiSummary: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            run_id_last_activity_at: {
              run_id: string | null;
              last_activity_at: Date | null;
            };
          };
        }) => {
          const k = where.run_id_last_activity_at;
          return findSummaryByKey(k.run_id, k.last_activity_at) ?? null;
        },
      ),
      create: vi.fn(async ({ data }: { data: AnyRow }) => {
        // Enforce unique (run_id, last_activity_at) like Postgres would.
        const existing = findSummaryByKey(
          data.run_id as string | null,
          data.last_activity_at as Date | null,
        );
        if (existing) {
          const err = new Error("Unique constraint violation");
          (err as unknown as { code: string }).code = "P2002";
          throw err;
        }
        const row = {
          id: `cuid-${state.summaries.length + 1}`,
          generated_at: new Date(),
          ...data,
        };
        state.summaries.push(row);
        return row;
      }),
    },
  },
}));

// LLM gateway mock — we control isGatewayConfigured per test and chatComplete
// return value.
type ChatCompleteResult = {
  text: string;
  modelUsed: string;
  durationMs: number;
  toolUseIterations: number;
  usage?: { promptTokens: number; completionTokens: number };
};

const gatewayMock = vi.hoisted(() => ({
  isGatewayConfigured: vi.fn(() => true),
  chatComplete: vi.fn(
    async (): Promise<ChatCompleteResult> => ({
      text: "DEFAULT_LLM_TEXT",
      modelUsed: "gpt-test-1",
      durationMs: 123,
      toolUseIterations: 0,
    }),
  ),
  GatewayUnavailableError: class GatewayUnavailableError extends Error {
    constructor() {
      super("gateway unavailable");
      this.name = "GatewayUnavailableError";
    }
  },
}));

vi.mock("@/server/llm/gateway", () => gatewayMock);

// Stable AGENT_MAP — synthesize uses resolveAgentMeta() for the breakdown step
// (returns undefined so nodeId passes through unchanged, as before).
vi.mock("@/lib/agent-mapping", () => ({
  AGENT_MAP: [],
  byShort: () => null,
  resolveAgentMeta: () => undefined,
}));

import { synthesizeRunSummary } from "./synthesize";

// ── Fixtures ──────────────────────────────────────────────────────────────

const RUN_ID = "run-xyz";
const LAST_ACTIVITY = new Date("2026-05-31T12:00:00Z");

function seedRun(opts: {
  steps?: Array<AnyRow>;
  activities?: Array<AnyRow>;
} = {}) {
  state.runs.set(RUN_ID, {
    id: RUN_ID,
    triggerEvent: "TEST_EVENT",
    triggerData: "{}",
    status: "completed",
    startedAt: new Date("2026-05-31T11:00:00Z"),
    completedAt: new Date("2026-05-31T12:00:00Z"),
    lastActivityAt: LAST_ACTIVITY,
    suspendedReason: null,
    steps: opts.steps ?? [],
  });
  state.activities = (opts.activities ?? []).map((a) => ({
    runId: RUN_ID,
    ...a,
  }));
}

beforeEach(() => {
  state.runs.clear();
  state.activities = [];
  state.summaries = [];
  gatewayMock.isGatewayConfigured.mockReturnValue(true);
  gatewayMock.chatComplete.mockResolvedValue({
    text: "DEFAULT_LLM_TEXT",
    modelUsed: "gpt-test-1",
    durationMs: 123,
    toolUseIterations: 0,
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("synthesizeRunSummary", () => {
  it("writes a static-fallback row when run has 0 steps + 0 activity", async () => {
    seedRun({ steps: [], activities: [] });

    const row = await synthesizeRunSummary({
      runId: RUN_ID,
      triggerPath: "lazy-on-view",
    });

    expect(row.source).toBe("static-fallback");
    expect(row.run_id).toBe(RUN_ID);
    expect(gatewayMock.chatComplete).not.toHaveBeenCalled();
    expect(state.summaries).toHaveLength(1);
  });

  it("writes a fallback row when isGatewayConfigured() is false", async () => {
    seedRun({
      steps: [
        {
          nodeId: "Alpha",
          status: "completed",
          durationMs: 100,
          error: null,
        },
      ],
      activities: [
        {
          agentName: "Alpha",
          narrative: "did the thing",
          createdAt: new Date("2026-05-31T11:30:00Z"),
        },
      ],
    });
    gatewayMock.isGatewayConfigured.mockReturnValue(false);

    const row = await synthesizeRunSummary({
      runId: RUN_ID,
      triggerPath: "lazy-on-view",
    });

    expect(row.source).toBe("fallback");
    expect(gatewayMock.chatComplete).not.toHaveBeenCalled();
    expect(row.summary_text).toContain("##");
  });

  it("eager + lazy race: only one row exists, second call returns existing", async () => {
    seedRun({
      steps: [
        {
          nodeId: "Alpha",
          status: "completed",
          durationMs: 100,
          error: null,
        },
      ],
      activities: [
        {
          agentName: "Alpha",
          narrative: "did the thing",
          createdAt: new Date("2026-05-31T11:30:00Z"),
        },
      ],
    });
    // Make the LLM responses distinct so we can tell which row "won".
    gatewayMock.chatComplete
      .mockResolvedValueOnce({
        text: "EAGER_TEXT",
        modelUsed: "gpt-test-1",
        durationMs: 100,
        toolUseIterations: 0,
      })
      .mockResolvedValueOnce({
        text: "LAZY_TEXT",
        modelUsed: "gpt-test-1",
        durationMs: 100,
        toolUseIterations: 0,
      });

    const [rowA, rowB] = await Promise.all([
      synthesizeRunSummary({
        runId: RUN_ID,
        triggerPath: "eager-on-fail",
        terminalStatus: "failed",
      }),
      synthesizeRunSummary({ runId: RUN_ID, triggerPath: "lazy-on-view" }),
    ]);

    // Exactly one row in the DB.
    expect(state.summaries).toHaveLength(1);
    // Both callers got the same row id (one created, the other read-back).
    expect(rowA.id).toBe(rowB.id);
  });

  it("persists chatComplete text as summary_text with source='llm'", async () => {
    seedRun({
      steps: [
        {
          nodeId: "Alpha",
          status: "completed",
          durationMs: 250,
          error: null,
        },
      ],
      activities: [
        {
          agentName: "Alpha",
          narrative: "wrote the JD",
          createdAt: new Date("2026-05-31T11:30:00Z"),
        },
      ],
    });
    gatewayMock.chatComplete.mockResolvedValueOnce({
      text: "MOCK_LLM_OUTPUT_42",
      modelUsed: "gpt-test-1",
      durationMs: 777,
      toolUseIterations: 0,
      usage: { promptTokens: 11, completionTokens: 22 },
    });

    const row = await synthesizeRunSummary({
      runId: RUN_ID,
      triggerPath: "lazy-on-view",
    });

    expect(row.source).toBe("llm");
    expect(row.summary_text).toBe("MOCK_LLM_OUTPUT_42");
    expect(row.llm_model).toBe("gpt-test-1");
    expect(row.llm_duration_ms).toBe(777);
  });

  it("infra-failure step → prompt frames it as infra, not a candidate rejection", async () => {
    seedRun({
      steps: [
        {
          nodeId: "rule-check",
          status: "failed",
          durationMs: 50,
          error:
            "[Rule Check Agent] rule-check infra failure (jr=JR1, reason=llm-call-error) — retrying; candidate NOT rejected",
        },
      ],
      activities: [
        {
          agentName: "rule-check",
          narrative: "evaluating rules",
          createdAt: new Date("2026-05-31T11:30:00Z"),
        },
      ],
    });

    const row = await synthesizeRunSummary({
      runId: RUN_ID,
      triggerPath: "lazy-on-view",
    });

    // The prompt the LLM saw must carry the infra framing + guardrail.
    expect(row.user_prompt).toContain("基础设施故障");
    expect(row.user_prompt).toContain("候选人未被拒绝");
    // And it is counted as a (terminal) failure for the run stats.
    expect(row.steps_failed).toBe(1);
  });
});
