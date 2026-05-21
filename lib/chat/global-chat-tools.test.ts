import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: {
    workflowRun: { findMany: vi.fn() },
    workflowStep: { findMany: vi.fn() },
    agentEpisode: { findMany: vi.fn() },
    eventInstance: { findMany: vi.fn() },
    ruleCheckAudit: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/allmeta-client", () => ({
  searchEntitiesNeo4j: vi.fn(),
  resolveEntityNames: vi.fn(),
}));

global.fetch = vi.fn();

import { TOOLS, TOOL_SCHEMAS, findTool } from "./global-chat-tools";
import { prisma } from "@/server/db";

const byName = (name: string) => TOOLS.find((t) => t.name === name)!;

beforeEach(() => vi.resetAllMocks());

// ── Registry sanity ───────────────────────────────────────────────────────────

describe("TOOLS registry", () => {
  it("exports exactly 7 tools", () => {
    expect(TOOLS).toHaveLength(7);
  });

  it("TOOL_SCHEMAS mirrors TOOLS length and has OpenAI tool shape", () => {
    expect(TOOL_SCHEMAS).toHaveLength(7);
    for (const s of TOOL_SCHEMAS) {
      expect(s.type).toBe("function");
      expect(typeof s.function.name).toBe("string");
      expect(typeof s.function.description).toBe("string");
    }
  });

  it("findTool returns the right tool by name", () => {
    expect(findTool("searchRuns")?.name).toBe("searchRuns");
    expect(findTool("nope")).toBeUndefined();
  });
});

// ── 1. searchRuns ─────────────────────────────────────────────────────────────

describe("searchRuns tool", () => {
  it("returns runs filtered by status", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([
      {
        id: "R-1",
        triggerEvent: "RESUME_UPLOADED",
        status: "failed",
        startedAt: new Date("2026-05-20T10:00:00Z"),
        completedAt: new Date("2026-05-20T10:01:00Z"),
      },
    ]);
    (prisma.workflowStep.findMany as any).mockResolvedValue([]);
    const { result, sources } = await byName("searchRuns").execute({
      status: "failed",
      limit: 10,
    });
    expect((result as any).runs).toHaveLength(1);
    expect((result as any).runs[0].id).toBe("R-1");
    expect((result as any).runs[0].status).toBe("failed");
    expect(sources?.[0]?.url).toMatch(/\/monitor/);
  });

  it("clamps limit to max 50", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([]);
    await byName("searchRuns").execute({ limit: 999 });
    expect((prisma.workflowRun.findMany as any).mock.calls[0][0].take).toBe(50);
  });

  it("applies triggerEvent filter when eventName is provided", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([]);
    await byName("searchRuns").execute({ eventName: "RESUME_UPLOADED" });
    const where = (prisma.workflowRun.findMany as any).mock.calls[0][0].where;
    expect(where.triggerEvent).toBe("RESUME_UPLOADED");
  });

  it("applies since filter when provided", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([]);
    await byName("searchRuns").execute({ since: "-24h" });
    const where = (prisma.workflowRun.findMany as any).mock.calls[0][0].where;
    expect(where.startedAt?.gte).toBeInstanceOf(Date);
  });

  it("filters by AgentEpisode.agentName via JOIN when agent is provided", async () => {
    (prisma.agentEpisode.findMany as any).mockResolvedValue([{ runId: "R-1" }]);
    (prisma.workflowRun.findMany as any).mockResolvedValue([
      {
        id: "R-1",
        triggerEvent: "REQUIREMENT_CLARIFIED",
        status: "completed",
        startedAt: new Date("2026-05-20T09:00:00Z"),
        completedAt: new Date("2026-05-20T09:02:00Z"),
      },
    ]);
    const { result } = await byName("searchRuns").execute({ agent: "JDGenerator" });
    // agentEpisode.findMany must be called with agentName filter
    const epCall = (prisma.agentEpisode.findMany as any).mock.calls[0][0];
    expect(epCall.where).toMatchObject({ agentName: "JDGenerator" });
    // workflowRun.findMany must be called with id: { in: ['R-1'] }
    const runCall = (prisma.workflowRun.findMany as any).mock.calls[0][0];
    expect(runCall.where).toMatchObject({ id: { in: ["R-1"] } });
    expect((result as any).runs).toHaveLength(1);
    expect((result as any).runs[0].id).toBe("R-1");
  });

  it("returns empty without querying workflowRun when agent has no matching episodes", async () => {
    (prisma.agentEpisode.findMany as any).mockResolvedValue([]);
    const { result } = await byName("searchRuns").execute({ agent: "NoSuchAgent" });
    expect((result as any).runs).toHaveLength(0);
    expect((result as any).total).toBe(0);
    // workflowRun.findMany should NOT be called
    expect(prisma.workflowRun.findMany).not.toHaveBeenCalled();
  });

  it("fetches first failed step error when status=failed and surfaces it on run", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([
      {
        id: "R-2",
        triggerEvent: "RESUME_PROCESSED",
        status: "failed",
        startedAt: new Date("2026-05-20T11:00:00Z"),
        completedAt: new Date("2026-05-20T11:00:30Z"),
      },
    ]);
    (prisma.workflowStep.findMany as any).mockResolvedValue([
      {
        runId: "R-2",
        error: "LLM rate limit exceeded",
        startedAt: new Date("2026-05-20T11:00:10Z"),
      },
    ]);
    const { result } = await byName("searchRuns").execute({ status: "failed" });
    // workflowStep.findMany should be called with correct filter
    const stepCall = (prisma.workflowStep.findMany as any).mock.calls[0][0];
    expect(stepCall.where).toMatchObject({ runId: { in: ["R-2"] }, status: "failed" });
    expect((result as any).runs[0].error).toBe("LLM rate limit exceeded");
  });
});

// ── 2. getRunDetail ───────────────────────────────────────────────────────────

describe("getRunDetail tool", () => {
  it("fetches run + steps + episodes", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([
      {
        id: "R-1",
        triggerEvent: "RESUME_UPLOADED",
        status: "completed",
        startedAt: new Date("2026-05-20T10:00:00Z"),
        completedAt: new Date("2026-05-20T10:01:00Z"),
      },
    ]);
    (prisma.workflowStep.findMany as any).mockResolvedValue([
      {
        id: "S-1",
        runId: "R-1",
        nodeId: "n1",
        stepName: "parse-resume",
        status: "completed",
        durationMs: 120,
        error: null,
      },
    ]);
    (prisma.agentEpisode.findMany as any).mockResolvedValue([
      {
        id: "E-1",
        agentName: "ResumeParser",
        runId: "R-1",
        modelUsed: "gemini-3-flash",
        tokenUsage: JSON.stringify({ prompt: 10, completion: 5, total: 15 }),
        durationMs: 100,
      },
    ]);
    const { result } = await byName("getRunDetail").execute({ runId: "R-1" });
    expect((result as any).run.id).toBe("R-1");
    expect((result as any).steps).toHaveLength(1);
    expect((result as any).steps[0].stepName).toBe("parse-resume");
    expect((result as any).episodes).toHaveLength(1);
    expect((result as any).episodes[0].modelUsed).toBe("gemini-3-flash");
    expect((result as any).episodes[0].tokenUsage).toEqual({ prompt: 10, completion: 5, total: 15 });
  });

  it("getRunDetail handles malformed tokenUsage gracefully", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([{ id: "R-x", triggerEvent: "X", status: "completed", startedAt: new Date() }]);
    (prisma.workflowStep.findMany as any).mockResolvedValue([]);
    (prisma.agentEpisode.findMany as any).mockResolvedValue([{ stepIdx: 0, modelUsed: "x", tokenUsage: "{malformed", durationMs: 1 }]);
    const { result } = await byName("getRunDetail").execute({ runId: "R-x" });
    expect((result as any).episodes[0].tokenUsage).toBeNull();
  });

  it("returns null run when not found", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([]);
    (prisma.workflowStep.findMany as any).mockResolvedValue([]);
    (prisma.agentEpisode.findMany as any).mockResolvedValue([]);
    const { result } = await byName("getRunDetail").execute({ runId: "nope" });
    expect((result as any).run).toBeNull();
  });

  it("returns empty result when runId is missing", async () => {
    const { result } = await byName("getRunDetail").execute({});
    expect((result as any).run).toBeNull();
    expect((result as any).steps).toHaveLength(0);
  });
});

// ── 3. searchEvents ───────────────────────────────────────────────────────────

describe("searchEvents tool", () => {
  it("supports trailing wildcard name (MATCH_*)", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([
      {
        id: "E-1",
        name: "MATCH_RULE_CHECK_PASSED",
        source: "rule-check-agent",
        status: "accepted",
        ts: new Date("2026-05-20T00:00:00Z"),
        payloadSummary: '{"upload_id":"u1"}',
      },
    ]);
    const { result } = await byName("searchEvents").execute({
      name: "MATCH_*",
      limit: 5,
    });
    const where = (prisma.eventInstance.findMany as any).mock.calls[0][0].where;
    expect(where.name).toMatchObject({ startsWith: "MATCH_" });
    expect((result as any).events).toHaveLength(1);
    expect((result as any).events[0].name).toBe("MATCH_RULE_CHECK_PASSED");
  });

  it("uses exact match when no wildcard", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
    await byName("searchEvents").execute({ name: "RESUME_UPLOADED" });
    const where = (prisma.eventInstance.findMany as any).mock.calls[0][0].where;
    expect(where.name).toBe("RESUME_UPLOADED");
  });

  it("clamps limit to max 100", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
    await byName("searchEvents").execute({ limit: 9999 });
    expect((prisma.eventInstance.findMany as any).mock.calls[0][0].take).toBe(100);
  });
});

// ── 4. searchAudits ───────────────────────────────────────────────────────────

describe("searchAudits tool", () => {
  it("filters by decision", async () => {
    const { resolveEntityNames } = await import("@/lib/allmeta-client");
    (resolveEntityNames as any).mockResolvedValue(new Map());
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      {
        audit_id: "A-1",
        decision: "FAIL",
        client_name: "字节跳动",
        job_requisition_id: "JR-001",
        candidate_id: "C-001",
        rules_evaluated: 5,
        failure_reasons: '["R-005","R-006"]',
        created_at: new Date("2026-05-20T08:00:00Z"),
      },
    ]);
    const { result } = await byName("searchAudits").execute({ decision: "FAIL" });
    expect((result as any).audits).toHaveLength(1);
    expect((result as any).audits[0].audit_id).toBe("A-1");
    expect((result as any).audits[0].decision).toBe("FAIL");
  });

  it("applies client filter to where clause", async () => {
    const { resolveEntityNames } = await import("@/lib/allmeta-client");
    (resolveEntityNames as any).mockResolvedValue(new Map());
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([]);
    await byName("searchAudits").execute({ client: "字节跳动" });
    const where = (prisma.ruleCheckAudit.findMany as any).mock.calls[0][0].where;
    expect(where.client_name).toBe("字节跳动");
  });

  it("applies candidateId filter to where clause", async () => {
    const { resolveEntityNames } = await import("@/lib/allmeta-client");
    (resolveEntityNames as any).mockResolvedValue(new Map());
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([]);
    await byName("searchAudits").execute({ candidateId: "C-abc" });
    const where = (prisma.ruleCheckAudit.findMany as any).mock.calls[0][0].where;
    expect(where.candidate_id).toBe("C-abc");
  });

  it("adds source URL to audits", async () => {
    const { resolveEntityNames } = await import("@/lib/allmeta-client");
    (resolveEntityNames as any).mockResolvedValue(new Map());
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      {
        audit_id: "A-2",
        decision: "PASS",
        client_name: "Test",
        job_requisition_id: "JR-002",
        candidate_id: "C-002",
        rules_evaluated: 3,
        failure_reasons: "[]",
        created_at: new Date(),
      },
    ]);
    const { sources } = await byName("searchAudits").execute({});
    expect(sources?.[0]?.url).toMatch(/rule-check/);
  });

  it("enriches candidate_name from Neo4j when resolver returns a name", async () => {
    const { resolveEntityNames } = await import("@/lib/allmeta-client");
    (resolveEntityNames as any).mockResolvedValue(new Map([["C-007", "张伟"]]));
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      {
        audit_id: "A-3",
        decision: "FAIL",
        client_name: "TechCorp",
        job_requisition_id: "JR-007",
        candidate_id: "C-007",
        rules_evaluated: 3,
        failure_reasons: '["R-001"]',
        created_at: new Date("2026-05-21T00:00:00Z"),
      },
    ]);
    const { result } = await byName("searchAudits").execute({ decision: "FAIL" });
    expect((result as any).audits[0].candidate_name).toBe("张伟");
    expect((result as any).audits[0].candidate_id).toBe("C-007");
  });

  it("sets candidate_name to null and still returns results when resolver throws", async () => {
    const { resolveEntityNames } = await import("@/lib/allmeta-client");
    (resolveEntityNames as any).mockRejectedValue(new Error("Neo4j unreachable"));
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      {
        audit_id: "A-4",
        decision: "PASS",
        client_name: "AnotherCorp",
        job_requisition_id: "JR-008",
        candidate_id: "C-008",
        rules_evaluated: 2,
        failure_reasons: "[]",
        created_at: new Date("2026-05-21T01:00:00Z"),
      },
    ]);
    const { result } = await byName("searchAudits").execute({ decision: "PASS" });
    expect((result as any).audits).toHaveLength(1);
    expect((result as any).audits[0].candidate_name).toBeNull();
    expect((result as any).audits[0].audit_id).toBe("A-4");
  });
});

// ── 5. searchEntities ─────────────────────────────────────────────────────────

describe("searchEntities tool", () => {
  it("delegates to searchEntitiesNeo4j and maps result", async () => {
    const { searchEntitiesNeo4j } = await import("@/lib/allmeta-client");
    (searchEntitiesNeo4j as any).mockResolvedValue([
      { id: "C-1", displayName: "Alice Zhao" },
    ]);
    const { result } = await byName("searchEntities").execute({
      type: "candidate",
      q: "Alice",
    });
    expect((result as any).entities).toHaveLength(1);
    expect((result as any).entities[0].displayName).toBe("Alice Zhao");
    expect((result as any).entities[0].type).toBe("candidate");
  });

  it("returns empty when neo4j throws", async () => {
    const { searchEntitiesNeo4j } = await import("@/lib/allmeta-client");
    (searchEntitiesNeo4j as any).mockRejectedValue(new Error("neo4j down"));
    const { result } = await byName("searchEntities").execute({
      type: "jd",
      q: "engineer",
    });
    // searchEntitiesNeo4j already swallows errors internally, but tool
    // also has a .catch fallback
    expect((result as any).entities).toBeDefined();
  });

  it("clamps limit to max 30", async () => {
    const { searchEntitiesNeo4j } = await import("@/lib/allmeta-client");
    (searchEntitiesNeo4j as any).mockResolvedValue([]);
    await byName("searchEntities").execute({ type: "candidate", q: "test", limit: 999 });
    const call = (searchEntitiesNeo4j as any).mock.calls[0][0];
    expect(call.limit).toBe(30);
  });
});

// ── 6. searchDLQ ─────────────────────────────────────────────────────────────

describe("searchDLQ tool", () => {
  it("fetches from /api/inngest-admin/dlq and returns items", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        dlq: [
          {
            id: "D-1",
            function: { slug: "agentic-operator-main-resume-parser-agent" },
            status: "Failed",
            startedAt: new Date().toISOString(),
          },
        ],
      }),
    });
    const { result } = await byName("searchDLQ").execute({});
    expect((result as any).items).toHaveLength(1);
    expect((result as any).items[0].id).toBe("D-1");
  });

  it("returns empty array when fetch fails", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, json: async () => ({}) });
    const { result } = await byName("searchDLQ").execute({});
    expect((result as any).items).toHaveLength(0);
  });

  it("returns error result on fetch network failure", async () => {
    (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
    const { result } = await byName("searchDLQ").execute({});
    expect((result as any).items).toEqual([]);
    expect((result as any).error).toContain("unreachable");
  });

  it("clamps limit to max 50", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        dlq: Array.from({ length: 100 }, (_, i) => ({ id: `D-${i}`, status: "Failed", function: { slug: "x" } })),
      }),
    });
    const { result } = await byName("searchDLQ").execute({ limit: 999 });
    expect((result as any).items.length).toBeLessThanOrEqual(50);
  });
});

// ── 7. getEventChain ─────────────────────────────────────────────────────────

describe("getEventChain tool", () => {
  it("returns chronological chain using ts field", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([
      {
        id: "E-2",
        name: "RESUME_PROCESSED",
        ts: new Date("2026-05-20T00:00:00Z"),
        payloadSummary: '{"upload_id":"u-abc"}',
        status: "accepted",
        source: "resume-parser",
      },
      {
        id: "E-3",
        name: "MATCH_RULE_CHECK_PASSED",
        ts: new Date("2026-05-20T00:00:30Z"),
        payloadSummary: '{"upload_id":"u-abc"}',
        status: "accepted",
        source: "rule-check-agent",
      },
    ]);
    const { result } = await byName("getEventChain").execute({
      anchor: { type: "uploadId", value: "u-abc" },
    });
    expect((result as any).chain).toHaveLength(2);
    // chain is sorted ascending by ts
    expect(
      (result as any).chain[0].timestamp < (result as any).chain[1].timestamp,
    ).toBe(true);
  });

  it("returns empty chain when anchor is missing", async () => {
    const { result } = await byName("getEventChain").execute({});
    expect((result as any).chain).toHaveLength(0);
  });

  it("uses id equality for eventId anchor", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([
      {
        id: "E-99",
        name: "SOME_EVENT",
        ts: new Date(),
        payloadSummary: null,
        status: "accepted",
        source: "test",
      },
    ]);
    const { result } = await byName("getEventChain").execute({
      anchor: { type: "eventId", value: "E-99" },
    });
    expect((result as any).chain).toHaveLength(1);
    expect((result as any).chain[0].refId).toBe("E-99");
  });
});
