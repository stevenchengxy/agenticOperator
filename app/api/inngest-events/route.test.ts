import { describe, expect, it, vi } from "vitest";

const { listEventsPage, eventInstanceFindMany, runArchiveFindMany } = vi.hoisted(() => ({
  listEventsPage: vi.fn(),
  eventInstanceFindMany: vi.fn(),
  runArchiveFindMany: vi.fn(),
}));

vi.mock("@/lib/inngest-source", () => ({ listEventsPage }));
vi.mock("@/server/db", () => ({
  prisma: {
    eventInstance: { findMany: eventInstanceFindMany },
    inngestRunArchive: { findMany: runArchiveFindMany },
  },
}));

import { GET } from "./route";

describe("GET /api/inngest-events", () => {
  it("returns the Postgres-counted page and honors ISO since", async () => {
    listEventsPage.mockResolvedValue({
      items: [{
        id: "e1",
        name: "EVENT_A",
        data: {},
        received_at: "2026-01-02T00:00:00Z",
        domain: "RAAS-v1",
      }],
      page: 3,
      pageSize: 20,
      total: 45,
      totalPages: 3,
      source: "postgres",
    });
    eventInstanceFindMany.mockResolvedValue([]);
    runArchiveFindMany.mockResolvedValue([{
      runId: "r1",
      status: "Failed",
      functionSlug: "agentic-operator-main-match-resume-agent",
      eventName: "EVENT_A",
      triggerEventIds: JSON.stringify(["e1"]),
      output: JSON.stringify({ error: { message: "RoboHire timeout" } }),
    }]);
    const response = await GET(new Request(
      "http://x/api/inngest-events?page=3&pageSize=20&domain=RAAS-v1&since=2026-01-01T00%3A00%3A00Z",
    ));
    const body = await response.json();
    expect(listEventsPage).toHaveBeenCalledWith(expect.objectContaining({
      page: 3,
      pageSize: 20,
      domain: "RAAS-v1",
      since: new Date("2026-01-01T00:00:00Z"),
    }));
    expect(body).toMatchObject({ page: 3, pageSize: 20, total: 45, totalPages: 3 });
    expect(body.events[0].outcome).toMatchObject({ technical: "failed", business: "blocked" });
    expect(body.events[0].processingRuns[0].runId).toBe("r1");
  });
});
