import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: { ruleCheckAudit: { findMany: vi.fn() }, eventInstance: { findMany: vi.fn() } },
}));
vi.mock("@/lib/allmeta-client", () => ({
  resolveEntityNames: vi.fn().mockResolvedValue(new Map()),
}));

import { GET } from "./route";
import { prisma } from "@/server/db";

describe("GET /api/funnel/candidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
  });

  it("groups the candidate's jobs with latest decision + counts + stages", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      { job_requisition_id: "job-1", decision: "PASS", created_at: new Date("2026-06-02"), job_requisition_json: JSON.stringify({ client_job_title: "后端工程师" }), client_display_name: "腾讯", client_name: null, parsed_resume_json: JSON.stringify({ name: "张伟" }) },
      { job_requisition_id: "job-1", decision: "FAIL", created_at: new Date("2026-06-01"), job_requisition_json: null, client_display_name: "腾讯", client_name: null, parsed_resume_json: null },
      { job_requisition_id: "job-2", decision: "FAIL", created_at: new Date("2026-06-02"), job_requisition_json: null, client_display_name: "字节", client_name: null, parsed_resume_json: null },
    ]);
    (prisma.eventInstance.findMany as any).mockResolvedValue([
      { name: "MATCH_RULE_CHECK_PASSED" },
      { name: "RESUME_PROCESSED" },
    ]);

    const res = await GET(new Request("http://x/api/funnel/candidate?id=c1"));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.candidateName).toBe("张伟");
    expect(j.jobs).toHaveLength(2);
    const job1 = j.jobs.find((x: any) => x.jobId === "job-1");
    expect(job1).toMatchObject({ jobTitle: "后端工程师", titleResolved: true, decision: "PASS", auditCount: 2 });
    expect(j.totalEvents).toBe(2);
    // stages reached, ordered: parse(RESUME_PROCESSED), rule_check
    expect(j.stagesReached.map((s: any) => s.key)).toEqual(["parse", "rule_check"]);
    expect(j.hasLineage).toBe(true);
  });

  it("requires id", async () => {
    const res = await GET(new Request("http://x/api/funnel/candidate"));
    expect(res.status).toBe(400);
    expect((await res.json()).meta.error).toContain("id");
  });

  it("returns 500 on DB failure", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockRejectedValue(new Error("boom"));
    const res = await GET(new Request("http://x/api/funnel/candidate?id=c1"));
    expect(res.status).toBe(500);
    expect((await res.json()).meta.error).toContain("boom");
  });
});
