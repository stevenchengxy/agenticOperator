import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: { jobRequisition: { groupBy: vi.fn() } },
}));

import { GET } from "./route";
import { prisma } from "@/server/db";

describe("GET /api/funnel/job-intake", () => {
  beforeEach(() => vi.clearAllMocks());

  it("aggregates JobRequisition by status in lifecycle order", async () => {
    (prisma.jobRequisition.groupBy as any).mockResolvedValue([
      { status: "published", _count: { _all: 5 } },
      { status: "pending_clarification", _count: { _all: 3 } },
      { status: "closed", _count: { _all: 1 } },
    ]);
    const res = await GET();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.total).toBe(9);
    expect(j.stages.map((s: any) => [s.status, s.count])).toEqual([
      ["pending_clarification", 3],
      ["clarified", 0],
      ["jd_ready", 0],
      ["published", 5],
      ["closed", 1],
    ]);
  });

  it("returns all-zero stages when empty", async () => {
    (prisma.jobRequisition.groupBy as any).mockResolvedValue([]);
    const j = await (await GET()).json();
    expect(j.total).toBe(0);
    expect(j.stages).toHaveLength(5);
  });

  it("returns 500 on DB failure", async () => {
    (prisma.jobRequisition.groupBy as any).mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).meta.error).toContain("boom");
  });
});
