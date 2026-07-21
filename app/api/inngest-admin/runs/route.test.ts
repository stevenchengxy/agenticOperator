import { describe, expect, it, vi } from "vitest";

const { listRecentRunsPage, getRunTokenUsage, archiveFindMany, archiveFindUnique, logFindMany } = vi.hoisted(() => ({
  listRecentRunsPage: vi.fn(),
  getRunTokenUsage: vi.fn(),
  archiveFindMany: vi.fn(),
  archiveFindUnique: vi.fn(),
  logFindMany: vi.fn(),
}));

vi.mock("@/lib/inngest-source", () => ({ listRecentRunsPage }));
vi.mock("@/lib/monitor/run-token-usage", () => ({ getRunTokenUsage }));
vi.mock("@/server/db", () => ({
  prisma: {
    inngestRunArchive: { findMany: archiveFindMany, findUnique: archiveFindUnique },
    logEvent: { findMany: logFindMany },
  },
}));

import { GET } from "./route";

describe("GET /api/inngest-admin/runs", () => {
  it("returns an exact numbered page and forwards persistent filters", async () => {
    listRecentRunsPage.mockResolvedValue({
      items: [{
        id: "r1",
        status: "Completed",
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:00:01Z",
        function: { name: "Fn", slug: "app-fn" },
        eventName: "EVENT_A",
        eventId: "e1",
      }],
      page: 2,
      pageSize: 25,
      total: 51,
      totalPages: 3,
      source: "postgres",
    });
    getRunTokenUsage.mockResolvedValue({});
    archiveFindMany.mockResolvedValue([{
      runId: "r1",
      output: JSON.stringify({ ok: true, eventName: "MATCH_FAILED", matching_score: 34 }),
      functionSlug: "app-fn",
      eventName: "EVENT_A",
    }]);
    archiveFindUnique.mockResolvedValue(null);
    logFindMany.mockResolvedValue([]);

    const response = await GET(new Request(
      "http://x/api/inngest-admin/runs?page=2&pageSize=25&fn=app-fn&domain=RAAS-v1&status=completed&event=EVENT_A",
    ));
    const body = await response.json();
    expect(listRecentRunsPage).toHaveBeenCalledWith(expect.objectContaining({
      page: 2,
      pageSize: 25,
      functionSlug: "app-fn",
      domain: "RAAS-v1",
      status: ["Completed"],
      eventName: "EVENT_A",
    }));
    expect(body).toMatchObject({ page: 2, pageSize: 25, total: 51, totalPages: 3 });
    expect(body.runs[0].outcome).toMatchObject({ technical: "healthy", business: "rejected", score: 34 });
  });
});
