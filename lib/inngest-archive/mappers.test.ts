import { describe, it, expect } from "vitest";
import {
  toDate,
  safeJson,
  isTerminalStatus,
  eventToRow,
  runToCreate,
  runToUpdate,
  historyToStepRows,
  runTraceFields,
  type RunHistory,
} from "./mappers";

describe("toDate", () => {
  it("parses ISO strings", () => {
    expect(toDate("2026-05-28T08:13:12.428+00:00")?.toISOString()).toBe(
      "2026-05-28T08:13:12.428Z",
    );
  });
  it("parses epoch-ms numbers", () => {
    const ms = 1769587992428;
    expect(toDate(ms)?.getTime()).toBe(ms);
  });
  it("returns null for null/empty/invalid", () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("")).toBeNull();
    expect(toDate("not-a-date")).toBeNull();
  });
});

describe("safeJson", () => {
  it("stringifies objects", () => {
    expect(safeJson({ a: 1 })).toBe('{"a":1}');
  });
  it("passes strings through unchanged", () => {
    expect(safeJson('{"already":"json"}')).toBe('{"already":"json"}');
  });
  it("maps null/undefined to null", () => {
    expect(safeJson(null)).toBeNull();
    expect(safeJson(undefined)).toBeNull();
  });
});

describe("isTerminalStatus", () => {
  it("true for terminal states", () => {
    expect(isTerminalStatus("Completed")).toBe(true);
    expect(isTerminalStatus("Failed")).toBe(true);
    expect(isTerminalStatus("Cancelled")).toBe(true);
  });
  it("false for running / unknown", () => {
    expect(isTerminalStatus("Running")).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
    expect(isTerminalStatus(null)).toBe(false);
  });
});

describe("eventToRow", () => {
  it("maps fields and stringifies data", () => {
    const row = eventToRow({
      id: "evt_1",
      internal_id: "int_1",
      name: "RESUME_DOWNLOADED",
      data: { upload_id: "u1" },
      ts: 1769587992428,
      received_at: "2026-05-28T08:13:12.428Z",
    });
    expect(row).toMatchObject({
      id: "evt_1",
      internalId: "int_1",
      name: "RESUME_DOWNLOADED",
      data: '{"upload_id":"u1"}',
    });
    expect(row.ts?.getTime()).toBe(1769587992428);
    expect(row.receivedAt).toBeInstanceOf(Date);
  });
});

describe("runToCreate / runToUpdate", () => {
  const run = {
    id: "01RUN",
    status: "Completed",
    startedAt: "2026-05-28T08:00:00.000Z",
    finishedAt: "2026-05-28T08:00:02.500Z",
    function: { name: "Resume Parser", slug: "agentic-operator-main-resume-parser-agent" },
    eventName: "RESUME_DOWNLOADED",
    eventId: "evt_9",
  };
  it("runToCreate maps function + computes duration + trigger ids", () => {
    const c = runToCreate(run);
    expect(c).toMatchObject({
      runId: "01RUN",
      functionSlug: "agentic-operator-main-resume-parser-agent",
      functionName: "Resume Parser",
      status: "Completed",
      eventName: "RESUME_DOWNLOADED",
      triggerEventIds: '["evt_9"]',
      durationMs: 2500,
    });
  });
  it("runToUpdate only carries mutable fields", () => {
    const u = runToUpdate(run);
    expect(Object.keys(u).sort()).toEqual(["durationMs", "endedAt", "eventName", "status"]);
    expect(u.durationMs).toBe(2500);
  });
  it("null finishedAt → null endedAt/duration", () => {
    const c = runToCreate({ ...run, finishedAt: undefined, status: "Running" });
    expect(c.endedAt).toBeNull();
    expect(c.durationMs).toBeNull();
  });
});

describe("historyToStepRows", () => {
  const history: RunHistory = {
    id: "01RUN",
    status: "Completed",
    startedAt: "2026-05-28T08:00:00.000Z",
    finishedAt: "2026-05-28T08:00:02.500Z",
    function: { name: "Resume Parser", slug: "slug" },
    steps: [
      {
        name: "fetch-binary",
        status: "Completed",
        durationMs: 120,
        startedAt: "2026-05-28T08:00:00.100Z",
        endedAt: "2026-05-28T08:00:00.220Z",
        stepOp: "Run",
        stepID: "step_a",
        attempts: 1,
        output: { ok: true },
        input: { upload_id: "u1" },
        error: null,
      },
    ],
  };
  it("produces index-based ids and serialises io", () => {
    const rows = historyToStepRows("01RUN", history);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "01RUN#0",
      runId: "01RUN",
      spanId: "step_a",
      name: "fetch-binary",
      stepOp: "Run",
      output: '{"ok":true}',
      input: '{"upload_id":"u1"}',
      error: null,
    });
  });
  it("falls back to step name for spanId when stepID missing", () => {
    const rows = historyToStepRows("01RUN", {
      ...history,
      steps: [{ ...history.steps[0], stepID: null }],
    });
    expect(rows[0].spanId).toBe("fetch-binary");
  });
});

describe("runTraceFields", () => {
  it("derives flowId from event payload + marks traceFetched", () => {
    const f = runTraceFields("01RUN", {
      id: "01RUN",
      status: "Completed",
      startedAt: "2026-05-28T08:00:00.000Z",
      finishedAt: "2026-05-28T08:00:02.500Z",
      function: { name: "n", slug: "s" },
      output: { done: 1 },
      event: {
        id: "evt_9",
        name: "RESUME_DOWNLOADED",
        payload: JSON.stringify({ upload_id: "u123" }),
        createdAt: "2026-05-28T08:00:00.000Z",
      },
      steps: [],
    });
    expect(f.traceFetched).toBe(true);
    expect(f.flowId).toBe("upload:u123");
    expect(f.output).toBe('{"done":1}');
    expect(f.eventName).toBe("RESUME_DOWNLOADED");
  });
  it("falls back to evt:<id> when no payload ids", () => {
    const f = runTraceFields("01RUN", {
      id: "01RUN",
      status: "Failed",
      startedAt: "2026-05-28T08:00:00.000Z",
      function: { name: "n", slug: "s" },
      steps: [],
    });
    expect(f.flowId).toBe("evt:01RUN");
    expect(f.eventPayload).toBeNull();
  });
});
