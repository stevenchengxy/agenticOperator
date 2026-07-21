import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  workflowFindMany,
  workflowCount,
  dlqFindMany,
  dlqCount,
  statusFindUnique,
} = vi.hoisted(() => ({
  workflowFindMany: vi.fn(),
  workflowCount: vi.fn(),
  dlqFindMany: vi.fn(),
  dlqCount: vi.fn(),
  statusFindUnique: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    workflowRun: { findMany: workflowFindMany, count: workflowCount },
    dLQEntry: { findMany: dlqFindMany, count: dlqCount },
    emSystemStatus: { findUnique: statusFindUnique },
  },
}));

import { GET } from "./route";

describe("GET /api/alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowFindMany.mockResolvedValue([]);
    workflowCount.mockResolvedValue(0);
    dlqFindMany.mockResolvedValue([]);
    dlqCount.mockResolvedValue(0);
    statusFindUnique.mockResolvedValue(null);
  });

  it("reads durable timed-out runs and DLQ rows with numbered pagination", async () => {
    workflowFindMany.mockResolvedValue([{ id: "r1", triggerEvent: "X", lastActivityAt: new Date("2026-01-02") }]);
    workflowCount.mockResolvedValue(1);
    dlqFindMany.mockResolvedValue([{ id: "d1", eventName: "Y", createdAt: new Date("2026-01-01"), resolvedAt: null }]);
    dlqCount.mockResolvedValue(1);

    const response = await GET(new Request("http://x/api/alerts?page=1&pageSize=1"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.alerts).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(1);
    expect(body.totalPages).toBe(2);
  });

  it("marks persistent source failures as partial", async () => {
    workflowFindMany.mockRejectedValue(new Error("db read failed"));
    dlqFindMany.mockRejectedValue(new Error("db read failed"));
    const response = await GET(new Request("http://x/api/alerts"));
    const body = await response.json();
    expect(body.alerts).toEqual([]);
    expect(body.meta.partial).toEqual(expect.arrayContaining(["ws", "em"]));
  });
});
