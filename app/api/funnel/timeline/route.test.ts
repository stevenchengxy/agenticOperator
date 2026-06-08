import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: { eventInstance: { findMany: vi.fn() } },
}));

vi.mock("@/lib/allmeta-client", () => ({
  resolveEntityNames: vi.fn().mockResolvedValue(new Map()),
}));

import { GET } from "./route";
import { prisma } from "@/server/db";

describe("GET /api/funnel/timeline", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps events to stages and extracts job/decision from payload", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([
      {
        id: "e1",
        name: "MATCH_RULE_CHECK_PASSED",
        ts: new Date("2026-05-26T10:00:00Z"),
        source: "rule-check-backfill",
        status: "accepted",
        payloadSummary: JSON.stringify({ candidate_id: "c1", job_requisition_id: "j1", decision: "PASS", audit_id: "a1" }),
      },
    ]);
    const res = await GET(new Request("http://x/api/funnel/timeline?candidate=c1"));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.events).toHaveLength(1);
    expect(j.events[0]).toMatchObject({ stage: "rule_check", stageLabelZh: "规则检查", jobId: "j1", decision: "PASS", auditId: "a1" });
    expect(j.events[0].payload).toMatchObject({ candidate_id: "c1", audit_id: "a1" });
  });

  it("filters by job when provided (keeps payload-less events)", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([
      { id: "e1", name: "MATCH_RULE_CHECK_PASSED", ts: new Date(), source: "s", status: "accepted", payloadSummary: JSON.stringify({ candidate_id: "c1", job_requisition_id: "j1" }) },
      { id: "e2", name: "MATCH_RULE_CHECK_FAILED", ts: new Date(), source: "s", status: "accepted", payloadSummary: JSON.stringify({ candidate_id: "c1", job_requisition_id: "j2" }) },
    ]);
    const res = await GET(new Request("http://x/api/funnel/timeline?candidate=c1&job=j1"));
    const j = await res.json();
    expect(j.events.map((e: any) => e.id)).toEqual(["e1"]);
  });

  it("requires candidate", async () => {
    const res = await GET(new Request("http://x/api/funnel/timeline"));
    const j = await res.json();
    expect(j.events).toEqual([]);
    expect(j.meta.error).toContain("candidate");
  });

  it("returns 500 on DB failure", async () => {
    (prisma.eventInstance.findMany as any).mockRejectedValue(new Error("boom"));
    const res = await GET(new Request("http://x/api/funnel/timeline?candidate=c1"));
    expect(res.status).toBe(500);
    expect((await res.json()).meta.error).toContain("boom");
  });
});
