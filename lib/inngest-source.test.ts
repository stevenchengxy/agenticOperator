import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock both the live client and the archive reader so we can drive the
// resolver's merge logic deterministically. The live module also supplies the
// re-exported helpers/mutations that inngest-source binds at module load, so
// they must exist on the mock.
vi.mock("./inngest-admin-client", () => ({
  listRecentRuns: vi.fn(),
  listRunsWithEvents: vi.fn(),
  getRunHistory: vi.fn(),
  getRunStepOutputs: vi.fn(),
  listFunctions: vi.fn(),
  listEvents: vi.fn(),
  getEventRuns: vi.fn(),
  replayEvent: vi.fn(),
  sendEvent: vi.fn(),
  deriveFlowId: vi.fn(),
  flowLabel: vi.fn(),
  groupRunsByFlow: vi.fn(),
}));
vi.mock("./inngest-archive/reader", () => ({
  listRecentRuns: vi.fn(),
  listRunsWithEvents: vi.fn(),
  getRunHistory: vi.fn(),
  getRunStepOutputs: vi.fn(),
  listEvents: vi.fn(),
  getEventById: vi.fn(),
  getTriggerEventFromRuns: vi.fn(),
  listRunsByTriggerEvent: vi.fn(),
  // Default impl (survives clearAllMocks): nothing tombstoned, so the
  // pre-existing merge tests exercise the normal path untouched.
  listTombstonedRunIds: vi.fn(async () => []),
}));

import * as live from "./inngest-admin-client";
import * as archive from "./inngest-archive/reader";
import {
  listRecentRuns,
  listRunsWithEvents,
  getRunHistory,
  listEvents,
  replayEvent,
  getEventRuns,
} from "./inngest-source";

type Recent = Awaited<ReturnType<typeof live.listRecentRuns>>[number];
function run(id: string, status: string, startedAt: string): Recent {
  return {
    id,
    status,
    startedAt,
    function: { name: id, slug: `agentic-operator-能源调度-v1-${id}` },
  };
}

type WithEvents = Awaited<ReturnType<typeof live.listRunsWithEvents>>[number];
function rwe(runId: string, status: string, startedAt: string): WithEvents {
  return {
    runId,
    status,
    startedAt,
    finishedAt: undefined,
    durationMs: null,
    eventName: "e",
    eventId: "ev",
    eventPayload: null,
    flowId: "f",
    label: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MONITOR_READ_SOURCE = "auto";
});

describe("inngest-source listRecentRuns (auto = merge live + archive)", () => {
  it("surfaces a live in-progress run that is not yet archived", async () => {
    vi.mocked(archive.listRecentRuns).mockResolvedValue([
      run("a", "Completed", "2026-06-03T05:00:00Z"),
    ]);
    vi.mocked(live.listRecentRuns).mockResolvedValue([
      run("b", "Running", "2026-06-03T05:00:30Z"), // fresh, archive hasn't polled it
      run("a", "Completed", "2026-06-03T05:00:00Z"),
    ]);
    const rows = await listRecentRuns({ limit: 50 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("b");
    expect(ids).toContain("a");
  });

  it("lets the live status win over a stale archived Running row", async () => {
    vi.mocked(archive.listRecentRuns).mockResolvedValue([
      run("a", "Running", "2026-06-03T05:00:00Z"),
    ]);
    vi.mocked(live.listRecentRuns).mockResolvedValue([
      run("a", "Completed", "2026-06-03T05:00:00Z"),
    ]);
    const rows = await listRecentRuns({ limit: 50 });
    expect(rows.find((r) => r.id === "a")?.status).toBe("Completed");
  });

  it("keeps an archive-only run that aged out of the live window", async () => {
    vi.mocked(archive.listRecentRuns).mockResolvedValue([
      run("old", "Completed", "2026-06-03T04:00:00Z"),
    ]);
    vi.mocked(live.listRecentRuns).mockResolvedValue([
      run("new", "Running", "2026-06-03T05:00:00Z"),
    ]);
    const rows = await listRecentRuns({ limit: 50 });
    expect(rows.map((r) => r.id).sort()).toEqual(["new", "old"]);
  });

  it("sorts merged rows by startedAt desc and respects the limit", async () => {
    vi.mocked(archive.listRecentRuns).mockResolvedValue([
      run("old", "Completed", "2026-06-03T05:00:00Z"),
    ]);
    vi.mocked(live.listRecentRuns).mockResolvedValue([
      run("new", "Running", "2026-06-03T05:00:30Z"),
    ]);
    const rows = await listRecentRuns({ limit: 1 });
    expect(rows.map((r) => r.id)).toEqual(["new"]);
  });

  it("falls back to archive when live is unreachable (durability)", async () => {
    vi.mocked(archive.listRecentRuns).mockResolvedValue([
      run("a", "Completed", "2026-06-03T05:00:00Z"),
    ]);
    vi.mocked(live.listRecentRuns).mockRejectedValue(new Error("ECONNREFUSED"));
    const rows = await listRecentRuns({ limit: 50 });
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("falls back to live when the archive throws", async () => {
    vi.mocked(archive.listRecentRuns).mockRejectedValue(new Error("pg down"));
    vi.mocked(live.listRecentRuns).mockResolvedValue([
      run("b", "Running", "2026-06-03T05:00:30Z"),
    ]);
    const rows = await listRecentRuns({ limit: 50 });
    expect(rows.map((r) => r.id)).toEqual(["b"]);
  });

  it("postgres mode returns archive only, never calls live", async () => {
    process.env.MONITOR_READ_SOURCE = "postgres";
    vi.mocked(archive.listRecentRuns).mockResolvedValue([
      run("a", "Completed", "2026-06-03T05:00:00Z"),
    ]);
    const rows = await listRecentRuns({ limit: 50 });
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(live.listRecentRuns).not.toHaveBeenCalled();
  });

  it("live mode returns live only, never calls archive", async () => {
    process.env.MONITOR_READ_SOURCE = "live";
    vi.mocked(live.listRecentRuns).mockResolvedValue([
      run("a", "Running", "2026-06-03T05:00:00Z"),
    ]);
    const rows = await listRecentRuns({ limit: 50 });
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(archive.listRecentRuns).not.toHaveBeenCalled();
  });
});

type History = NonNullable<Awaited<ReturnType<typeof live.getRunHistory>>>;
function history(id: string, status: string, steps: History["steps"]): History {
  return {
    id,
    status,
    startedAt: "2026-06-03T05:00:00Z",
    finishedAt: undefined,
    output: null,
    function: { name: id, slug: `agentic-operator-能源调度-v1-${id}` },
    event: undefined,
    steps,
  };
}

describe("inngest-source getRunHistory (auto)", () => {
  it("returns the archived trace for a terminal run (no live call)", async () => {
    vi.mocked(archive.getRunHistory).mockResolvedValue(
      history("a", "Completed", [{ name: "s1" } as History["steps"][number]]),
    );
    const h = await getRunHistory("a");
    expect(h?.steps).toHaveLength(1);
    expect(live.getRunHistory).not.toHaveBeenCalled();
  });

  it("goes live for an archived-but-Running run (archive trace is empty until terminal)", async () => {
    // Archive has the run as Running with no steps yet (trace only captured at
    // terminal); live has the in-progress steps.
    vi.mocked(archive.getRunHistory).mockResolvedValue(history("a", "Running", []));
    vi.mocked(live.getRunHistory).mockResolvedValue(
      history("a", "Running", [{ name: "live-step" } as History["steps"][number]]),
    );
    const h = await getRunHistory("a");
    expect(h?.steps.map((s) => s.name)).toEqual(["live-step"]);
    expect(live.getRunHistory).toHaveBeenCalledWith("a");
  });

  it("falls back to live when the run is not archived", async () => {
    vi.mocked(archive.getRunHistory).mockResolvedValue(null);
    vi.mocked(live.getRunHistory).mockResolvedValue(history("a", "Completed", []));
    const h = await getRunHistory("a");
    expect(h?.id).toBe("a");
    expect(live.getRunHistory).toHaveBeenCalled();
  });
});

describe("inngest-source listRunsWithEvents (auto = merge live + archive)", () => {
  it("surfaces a live in-progress run that is not yet archived", async () => {
    vi.mocked(archive.listRunsWithEvents).mockResolvedValue([
      rwe("a", "Completed", "2026-06-03T05:00:00Z"),
    ]);
    vi.mocked(live.listRunsWithEvents).mockResolvedValue([
      rwe("b", "Running", "2026-06-03T05:00:30Z"),
      rwe("a", "Completed", "2026-06-03T05:00:00Z"),
    ]);
    const rows = await listRunsWithEvents("slug", { limit: 50 });
    expect(rows.map((r) => r.runId).sort()).toEqual(["a", "b"]);
  });

  it("falls back to archive when live is unreachable", async () => {
    vi.mocked(archive.listRunsWithEvents).mockResolvedValue([
      rwe("a", "Completed", "2026-06-03T05:00:00Z"),
    ]);
    vi.mocked(live.listRunsWithEvents).mockRejectedValue(new Error("ECONNREFUSED"));
    const rows = await listRunsWithEvents("slug", { limit: 50 });
    expect(rows.map((r) => r.runId)).toEqual(["a"]);
  });
});

type Evt = Awaited<ReturnType<typeof live.listEvents>>[number];
function evt(
  id: string,
  receivedAt: string,
  data: unknown = {},
): Evt {
  return { id, name: "EVENT", data, received_at: receivedAt };
}

describe("inngest-source listEvents (auto = merge live + archive)", () => {
  it("surfaces archived events when the live event store is empty (durability)", async () => {
    // The Inngest dev server's /v1/events buffer is lossy/ephemeral — after a
    // quiet period it returns []. The durable archive still has the history, so
    // the events page + overview stream must not go blank.
    vi.mocked(live.listEvents).mockResolvedValue([]);
    vi.mocked(archive.listEvents).mockResolvedValue([
      evt("a", "2026-06-15T08:00:00Z"),
    ]);
    const rows = await listEvents(200);
    expect(rows.map((e) => e.id)).toEqual(["a"]);
  });

  it("lets the live event win over an archived duplicate with the same id", async () => {
    vi.mocked(archive.listEvents).mockResolvedValue([
      evt("a", "2026-06-15T08:00:00Z", { from: "archive" }),
    ]);
    vi.mocked(live.listEvents).mockResolvedValue([
      evt("a", "2026-06-15T08:00:00Z", { from: "live" }),
    ]);
    const rows = await listEvents(200);
    expect(rows).toHaveLength(1);
    expect((rows[0].data as { from: string }).from).toBe("live");
  });

  it("keeps an archived event that aged out of the live window", async () => {
    vi.mocked(archive.listEvents).mockResolvedValue([
      evt("old", "2026-06-15T07:00:00Z"),
    ]);
    vi.mocked(live.listEvents).mockResolvedValue([
      evt("new", "2026-06-15T08:00:00Z"),
    ]);
    const rows = await listEvents(200);
    expect(rows.map((e) => e.id).sort()).toEqual(["new", "old"]);
  });

  it("sorts the merged union by received_at desc and respects the limit", async () => {
    vi.mocked(archive.listEvents).mockResolvedValue([
      evt("old", "2026-06-15T07:00:00Z"),
    ]);
    vi.mocked(live.listEvents).mockResolvedValue([
      evt("new", "2026-06-15T08:00:00Z"),
    ]);
    const rows = await listEvents(1);
    expect(rows.map((e) => e.id)).toEqual(["new"]);
  });

  it("falls back to live when the archive throws", async () => {
    vi.mocked(archive.listEvents).mockRejectedValue(new Error("pg down"));
    vi.mocked(live.listEvents).mockResolvedValue([evt("b", "2026-06-15T08:00:00Z")]);
    const rows = await listEvents(200);
    expect(rows.map((e) => e.id)).toEqual(["b"]);
  });

  it("postgres mode returns archive only, never calls live", async () => {
    process.env.MONITOR_READ_SOURCE = "postgres";
    vi.mocked(archive.listEvents).mockResolvedValue([evt("a", "2026-06-15T08:00:00Z")]);
    const rows = await listEvents(200);
    expect(rows.map((e) => e.id)).toEqual(["a"]);
    expect(live.listEvents).not.toHaveBeenCalled();
  });

  it("live mode returns live only, never calls archive", async () => {
    process.env.MONITOR_READ_SOURCE = "live";
    vi.mocked(live.listEvents).mockResolvedValue([evt("a", "2026-06-15T08:00:00Z")]);
    const rows = await listEvents(200);
    expect(rows.map((e) => e.id)).toEqual(["a"]);
    expect(archive.listEvents).not.toHaveBeenCalled();
  });

  it("passes an optional name filter through to both sources", async () => {
    vi.mocked(live.listEvents).mockResolvedValue([]);
    vi.mocked(archive.listEvents).mockResolvedValue([]);
    await listEvents(200, "RESUME_PROCESSED");
    expect(live.listEvents).toHaveBeenCalledWith(200, "RESUME_PROCESSED");
    expect(archive.listEvents).toHaveBeenCalledWith(200, "RESUME_PROCESSED");
  });
});

describe("inngest-source replayEvent (auto = live first, archive fallback)", () => {
  it("uses the live replay when the event is still in the live buffer", async () => {
    vi.mocked(live.replayEvent).mockResolvedValue({ newEventId: "live-new" });
    await expect(replayEvent("ev-1")).resolves.toEqual({ newEventId: "live-new" });
    expect(archive.getEventById).not.toHaveBeenCalled();
  });

  it("re-emits the archived payload when the event aged out of the live buffer", async () => {
    // The dev server's event buffer is lossy — every historical failed run hits
    // this path, which is exactly what 批量重试 exists for.
    vi.mocked(live.replayEvent).mockRejectedValue(
      new Error("event ev-1 not found in live buffer"),
    );
    vi.mocked(archive.getEventById).mockResolvedValue(
      evt("ev-1", "2026-06-15T08:00:00Z", { candidate_id: "c1" }),
    );
    vi.mocked(live.sendEvent).mockResolvedValue({ id: "archived-new" });
    await expect(replayEvent("ev-1")).resolves.toEqual({ newEventId: "archived-new" });
    expect(live.sendEvent).toHaveBeenCalledWith(
      "EVENT",
      { candidate_id: "c1" },
      { replayOf: "ev-1" },
    );
  });

  it("falls back to the run archive's trigger copy when the event archive has a gap", async () => {
    // The event archiver polls the lossy live buffer, so an event can be
    // missing from the event archive while its run (with eventPayload) exists.
    vi.mocked(live.replayEvent).mockRejectedValue(
      new Error("event ev-2 not found in live buffer"),
    );
    vi.mocked(archive.getEventById).mockResolvedValue(null);
    vi.mocked(archive.getTriggerEventFromRuns).mockResolvedValue({
      name: "REQUIREMENT_LOGGED",
      data: { entity_id: "REQ-1" },
    });
    vi.mocked(live.sendEvent).mockResolvedValue({ id: "run-copy-new" });
    await expect(replayEvent("ev-2")).resolves.toEqual({ newEventId: "run-copy-new" });
    expect(live.sendEvent).toHaveBeenCalledWith(
      "REQUIREMENT_LOGGED",
      { entity_id: "REQ-1" },
      { replayOf: "ev-2" },
    );
  });

  it("surfaces the live error when the event is not archived either", async () => {
    vi.mocked(live.replayEvent).mockRejectedValue(new Error("event ev-x not found"));
    vi.mocked(archive.getEventById).mockResolvedValue(null);
    vi.mocked(archive.getTriggerEventFromRuns).mockResolvedValue(null);
    await expect(replayEvent("ev-x")).rejects.toThrow("event ev-x not found");
    expect(live.sendEvent).not.toHaveBeenCalled();
  });

  it("live mode never consults the archive", async () => {
    process.env.MONITOR_READ_SOURCE = "live";
    vi.mocked(live.replayEvent).mockRejectedValue(new Error("nope"));
    await expect(replayEvent("ev-1")).rejects.toThrow("nope");
    expect(archive.getEventById).not.toHaveBeenCalled();
  });
});

type EventRun = Awaited<ReturnType<typeof live.getEventRuns>>[number];
function evtRun(runId: string, status: EventRun["status"], startedAt: string): EventRun {
  return { run_id: runId, status, run_started_at: startedAt };
}

describe("inngest-source getEventRuns (auto = merge live + archive)", () => {
  it("returns archived runs when live answers [] for an aged-out event", async () => {
    vi.mocked(live.getEventRuns).mockResolvedValue([]);
    vi.mocked(archive.listRunsByTriggerEvent).mockResolvedValue([
      evtRun("r1", "Failed", "2026-06-15T08:00:00Z"),
    ]);
    const rows = await getEventRuns("ev-1");
    expect(rows.map((r) => r.run_id)).toEqual(["r1"]);
  });

  it("lets the live row win on run_id conflict and sorts newest-first", async () => {
    vi.mocked(archive.listRunsByTriggerEvent).mockResolvedValue([
      evtRun("r1", "Running", "2026-06-15T08:00:00Z"), // stale archive status
      evtRun("r0", "Completed", "2026-06-15T07:00:00Z"),
    ]);
    vi.mocked(live.getEventRuns).mockResolvedValue([
      evtRun("r1", "Completed", "2026-06-15T08:00:00Z"),
    ]);
    const rows = await getEventRuns("ev-1");
    expect(rows.map((r) => r.run_id)).toEqual(["r1", "r0"]);
    expect(rows[0].status).toBe("Completed");
  });

  it("falls back to the archive when live is unreachable", async () => {
    vi.mocked(live.getEventRuns).mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(archive.listRunsByTriggerEvent).mockResolvedValue([
      evtRun("r1", "Failed", "2026-06-15T08:00:00Z"),
    ]);
    const rows = await getEventRuns("ev-1");
    expect(rows.map((r) => r.run_id)).toEqual(["r1"]);
  });
});

describe("inngest-source tombstoned runs (操作员删除后 live 不复活)", () => {
  it("hides a tombstoned run that the live buffer still returns", async () => {
    // Archive row is deleted; only live still knows the run. Without the
    // filter the merge would resurrect it in 监控 right after 删除.
    vi.mocked(archive.listRecentRuns).mockResolvedValue([]);
    vi.mocked(live.listRecentRuns).mockResolvedValue([
      run("deleted", "Failed", "2026-06-03T05:00:00Z"),
      run("kept", "Completed", "2026-06-03T05:00:30Z"),
    ]);
    vi.mocked(archive.listTombstonedRunIds).mockResolvedValueOnce(["deleted"]);
    const rows = await listRecentRuns({ limit: 50 });
    expect(rows.map((r) => r.id)).toEqual(["kept"]);
  });

  it("fails open when the tombstone lookup errors (monitor must stay up)", async () => {
    vi.mocked(archive.listRecentRuns).mockResolvedValue([]);
    vi.mocked(live.listRecentRuns).mockResolvedValue([
      run("a", "Completed", "2026-06-03T05:00:00Z"),
    ]);
    vi.mocked(archive.listTombstonedRunIds).mockRejectedValueOnce(new Error("pg down"));
    const rows = await listRecentRuns({ limit: 50 });
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("filters tombstoned runs out of listRunsWithEvents too", async () => {
    vi.mocked(archive.listRunsWithEvents).mockResolvedValue([]);
    vi.mocked(live.listRunsWithEvents).mockResolvedValue([
      rwe("deleted", "Failed", "2026-06-03T05:00:00Z"),
      rwe("kept", "Completed", "2026-06-03T05:00:30Z"),
    ]);
    vi.mocked(archive.listTombstonedRunIds).mockResolvedValueOnce(["deleted"]);
    const rows = await listRunsWithEvents("slug", { limit: 50 });
    expect(rows.map((r) => r.runId)).toEqual(["kept"]);
  });
});
