import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    logEvent: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

vi.mock("@/server/db", () => ({ prisma }));

import { GET } from "./route";

describe("GET /api/audit/runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.logEvent.findMany.mockResolvedValue([]);
    prisma.logEvent.groupBy.mockResolvedValue([]);
  });

  it("reads the complete durable history by default", async () => {
    const response = await GET(new Request("http://x/api/audit/runs?page=2&pageSize=25"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(prisma.logEvent.findMany.mock.calls[0][0].where).not.toHaveProperty("ts");
    expect(prisma.logEvent.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      skip: 25,
      take: 25,
    }));
    expect(body).toMatchObject({ page: 2, pageSize: 25, total: 0, totalPages: 1 });
  });

  it("still supports an explicit rolling-day filter", async () => {
    await GET(new Request("http://x/api/audit/runs?days=7"));

    expect(prisma.logEvent.findMany.mock.calls[0][0].where.ts.gte).toBeInstanceOf(Date);
    expect(prisma.logEvent.groupBy.mock.calls[0][0].where.ts.gte).toBeInstanceOf(Date);
  });
});
