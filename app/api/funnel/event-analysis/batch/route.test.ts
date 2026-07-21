import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: { eventInstance: { findMany: vi.fn() } },
}));
vi.mock("@/lib/funnel/event-analysis", () => ({
  runEventAnalysis: vi.fn(),
}));

import { POST } from "./route";
import { prisma } from "@/server/db";
import { runEventAnalysis } from "@/lib/funnel/event-analysis";

describe("POST /api/funnel/event-analysis/batch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pre-generates FAIL events, counting generated/cached/failed", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([{ id: "e1" }, { id: "e2" }, { id: "e3" }]);
    (runEventAnalysis as any)
      .mockResolvedValueOnce({ status: "ok", cached: false })
      .mockResolvedValueOnce({ status: "ok", cached: true })
      .mockResolvedValueOnce({ status: "parse_error" });

    const res = await POST(new Request("http://x/api/funnel/event-analysis/batch?job=j1", { method: "POST" }));
    const j = await res.json();
    expect(j).toMatchObject({ requested: 3, generated: 1, cached: 1, failed: 1 });
    // FAIL → only MATCH_RULE_CHECK_FAILED, scoped to job j1
    const where = (prisma.eventInstance.findMany as any).mock.calls[0][0].where;
    expect(where.name).toEqual({ in: ["MATCH_RULE_CHECK_FAILED"] });
    expect(where.payloadSummary).toEqual({ contains: "j1" });
  });

  it("stops early and reports when gateway is unavailable", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([{ id: "e1" }, { id: "e2" }]);
    (runEventAnalysis as any).mockResolvedValue({ status: "gateway_unavailable" });
    const res = await POST(new Request("http://x/api/funnel/event-analysis/batch", { method: "POST" }));
    const j = await res.json();
    expect(j.meta.reason).toBe("gateway_unavailable");
    expect(runEventAnalysis).toHaveBeenCalledTimes(1); // stopped after first
  });

  it("clamps limit to [1,50]", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
    await POST(new Request("http://x/api/funnel/event-analysis/batch?limit=999", { method: "POST" }));
    expect((prisma.eventInstance.findMany as any).mock.calls[0][0].take).toBe(50);
  });
});
