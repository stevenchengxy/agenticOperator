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
}));

import * as live from "./inngest-admin-client";
import * as archive from "./inngest-archive/reader";
import { listRecentRuns, listRunsWithEvents, getRunHistory } from "./inngest-source";

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
