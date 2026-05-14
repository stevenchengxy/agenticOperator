import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/server/db", () => ({
  prisma: {
    humanTask: {
      create: vi.fn().mockResolvedValue({ id: "task1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    workflowRun: {
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    agentActivity: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("@/server/em", () => ({
  em: {
    publish: vi
      .fn()
      .mockResolvedValue({ accepted: true, eventId: "e1", schemaVersionUsed: "1.0" }),
  },
}));

vi.mock("@/server/inngest/client", () => ({
  inngest: {
    // Inngest v4 signature: createFunction(options, handler)
    // where options = { id, name, triggers: [...] }
    createFunction: vi.fn(
      (
        cfg: { id: string; name: string; triggers: { event: string }[] },
        handler: unknown,
      ) => ({ id: cfg.id, triggers: cfg.triggers, handler }),
    ),
  },
}));

import { createStubAgent } from "./stub-factory";
import type { AgentMeta } from "@/lib/agent-mapping";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMeta(overrides: Partial<AgentMeta> = {}): AgentMeta {
  return {
    short: "TestAgent",
    wsId: "x",
    stage: "system",
    kind: "auto",
    ownerTeam: "team",
    version: "v1",
    triggersEvents: ["TEST_EVENT"],
    emitsEvents: ["NEXT_EVENT"],
    terminal: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("createStubAgent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for agents with no triggers", () => {
    const result = createStubAgent(
      makeMeta({ triggersEvents: [], emitsEvents: [] }),
    );
    expect(result).toBeNull();
  });

  it("creates a function for an agent with triggers", () => {
    const result = createStubAgent(makeMeta());
    expect(result).not.toBeNull();
    // id is lowercased agent.short
    expect((result as { id: string }).id).toBe("agent.testagent");
  });

  it("uses the agent short name lowercased in the function id", () => {
    const result = createStubAgent(makeMeta({ short: "ReqAnalyzer" }));
    expect((result as { id: string }).id).toBe("agent.reqanalyzer");
  });

  it("registers all triggersEvents as Inngest triggers", () => {
    const result = createStubAgent(
      makeMeta({ triggersEvents: ["EVT_A", "EVT_B"] }),
    );
    const fn = result as { triggers: { event: string }[] };
    expect(fn.triggers).toHaveLength(2);
    expect(fn.triggers[0].event).toBe("EVT_A");
    expect(fn.triggers[1].event).toBe("EVT_B");
  });

  it("returns null for Chatbot-like agents with no triggers", () => {
    const result = createStubAgent(
      makeMeta({ short: "Chatbot", triggersEvents: [], terminal: true }),
    );
    expect(result).toBeNull();
  });

  it("returns a handler function in the created function", () => {
    const result = createStubAgent(makeMeta());
    expect(typeof (result as { handler: unknown }).handler).toBe("function");
  });
});
