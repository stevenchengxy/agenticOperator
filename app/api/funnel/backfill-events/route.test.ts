import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: {
    ruleCheckAudit: { findMany: vi.fn() },
    eventInstance: { createMany: vi.fn() },
  },
}));

import { POST } from "./route";
import { prisma } from "@/server/db";

describe("POST /api/funnel/backfill-events", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits one MATCH_RULE_CHECK event per audit, idempotent externalEventId", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      { audit_id: "a1", candidate_id: "c1", job_requisition_id: "j1", decision: "PASS", trace_id: null, run_id: "r1", agentName: "MatchAgent", created_at: new Date("2026-05-26") },
      { audit_id: "a2", candidate_id: "c2", job_requisition_id: "j1", decision: "FAIL", trace_id: "tr_2", run_id: "r2", agentName: null, created_at: new Date("2026-05-26") },
    ]);
    (prisma.eventInstance.createMany as any).mockResolvedValue({ count: 2 });

    const res = await POST();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ scanned: 2, created: 2 });

    const arg = (prisma.eventInstance.createMany as any).mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    const [e1, e2] = arg.data;
    expect(e1.externalEventId).toBe("evt_rcheck_a1");
    expect(e1.name).toBe("MATCH_RULE_CHECK_PASSED");
    expect(JSON.parse(e1.payloadSummary)).toMatchObject({ candidate_id: "c1", job_requisition_id: "j1", trace_id: "r1" });
    expect(e2.name).toBe("MATCH_RULE_CHECK_FAILED");
    expect(JSON.parse(e2.payloadSummary).trace_id).toBe("tr_2"); // prefers real trace_id
  });

  it("no-ops cleanly when there are no audits", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([]);
    const res = await POST();
    const j = await res.json();
    expect(j).toMatchObject({ scanned: 0, created: 0 });
    expect(prisma.eventInstance.createMany).not.toHaveBeenCalled();
  });

  it("returns 500 on DB failure", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockRejectedValue(new Error("down"));
    const res = await POST();
    expect(res.status).toBe(500);
    expect((await res.json()).meta.error).toContain("down");
  });
});
