import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRunFindMany = vi.fn();
const mockRunCount = vi.fn();

vi.mock("../../server/db", () => ({
  prisma: {
    inngestRunArchive: {
      findMany: (...args: unknown[]) => mockRunFindMany(...args),
      count: (...args: unknown[]) => mockRunCount(...args),
    },
    inngestEventArchive: { findMany: vi.fn() },
  },
}));
vi.mock("../persistence/domain-backfill", () => ({
  ensureArchivedEventDomains: vi.fn().mockResolvedValue(undefined),
  ensureArchivedRunDomains: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../inngest-admin-client", () => ({
  deriveFlowId: vi.fn(() => "flow"),
  flowLabel: vi.fn(() => ({})),
}));

import { listRecentRuns, listRecentRunsPage, listRunsWithEvents } from "./reader";

function runRow(over: Record<string, unknown> = {}) {
  return {
    runId: "run_1",
    functionSlug: "agentic-operator-main-resume-parser-agent",
    functionName: "Resume Parser",
    appId: null,
    status: "Completed",
    startedAt: new Date("2026-06-01T10:00:00Z"),
    endedAt: new Date("2026-06-01T10:00:10Z"),
    durationMs: 10_000,
    eventName: "RESUME_DOWNLOADED",
    triggerEventIds: JSON.stringify(["evt_1"]),
    eventPayload: JSON.stringify({ upload_id: "up_1" }),
    output: null,
    flowId: null,
    traceFetched: true,
    archivedAt: new Date("2026-06-01T10:00:11Z"),
    lastSyncedAt: new Date("2026-06-01T10:00:11Z"),
    ...over,
  };
}

beforeEach(() => {
  mockRunFindMany.mockReset();
  mockRunCount.mockReset();
});

describe("archive reader run windows", () => {
  it("does not add a startedAt cutoff when sinceHours is omitted", async () => {
    mockRunFindMany.mockResolvedValue([runRow()]);

    const rows = await listRecentRuns({ limit: 25 });

    expect(rows[0]?.id).toBe("run_1");
    const arg = mockRunFindMany.mock.calls[0][0];
    expect(arg.take).toBe(25);
    expect(arg.where).toEqual({});
    expect(arg.orderBy).toEqual([{ startedAt: "desc" }, { runId: "desc" }]);
  });

  it("adds a startedAt cutoff only when sinceHours is explicit", async () => {
    mockRunFindMany.mockResolvedValue([]);

    await listRecentRuns({ limit: 25, sinceHours: 24 });

    const arg = mockRunFindMany.mock.calls[0][0];
    expect(arg.where.startedAt.gte).toBeInstanceOf(Date);
  });

  it("keeps per-function flow history unbounded by default", async () => {
    mockRunFindMany.mockResolvedValue([runRow()]);

    const rows = await listRunsWithEvents("agentic-operator-main-resume-parser-agent", {
      limit: 100,
    });

    expect(rows[0]?.runId).toBe("run_1");
    const arg = mockRunFindMany.mock.calls[0][0];
    expect(arg.where).toEqual({ functionSlug: "agentic-operator-main-resume-parser-agent" });
  });

  it("applies domain/status/event filters before exact count + pagination", async () => {
    mockRunFindMany.mockResolvedValue([runRow()]);
    mockRunCount.mockResolvedValue(31);
    const result = await listRecentRunsPage({
      page: 3,
      pageSize: 10,
      domain: "RAAS-v1",
      status: ["Completed"],
      eventName: "RESUME_DOWNLOADED",
    });
    expect(result).toMatchObject({ page: 3, pageSize: 10, total: 31, totalPages: 4 });
    expect(mockRunFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        domain: "RAAS-v1",
        status: { in: ["Completed"] },
        eventName: "RESUME_DOWNLOADED",
      },
      skip: 20,
      take: 10,
      orderBy: [{ startedAt: "desc" }, { runId: "desc" }],
    }));
  });
});
