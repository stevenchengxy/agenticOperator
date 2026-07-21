import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: {
    ruleCheckAudit: { findMany: vi.fn() },
    jobRequisition: { findMany: vi.fn() },
    eventInstance: { findMany: vi.fn() },
  },
}));

// Neo4j name resolver — keep unit tests offline (pure snapshot path still real).
vi.mock("@/lib/allmeta-client", () => ({
  resolveEntityNames: vi.fn().mockResolvedValue(new Map()),
}));

import { GET } from "./route";
import { prisma } from "@/server/db";

describe("GET /api/funnel/jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.eventInstance.findMany as any).mockResolvedValue([]); // no events by default
  });

  it("aggregates rule-check pass/fail per job by distinct latest candidate", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      // c1 latest=PASS (newer row first), older FAIL ignored
      { job_requisition_id: "job-1", candidate_id: "c1", decision: "PASS", created_at: new Date("2026-06-02"), client_display_name: "腾讯", client_name: null },
      { job_requisition_id: "job-1", candidate_id: "c1", decision: "FAIL", created_at: new Date("2026-06-01"), client_display_name: "腾讯", client_name: null },
      { job_requisition_id: "job-1", candidate_id: "c2", decision: "FAIL", created_at: new Date("2026-06-02"), client_display_name: "腾讯", client_name: null },
      { job_requisition_id: "job-2", candidate_id: "c3", decision: "PASS", created_at: new Date("2026-06-02"), client_display_name: "字节", client_name: null },
    ]);
    (prisma.jobRequisition.findMany as any).mockResolvedValue([
      { id: "job-1", client: "腾讯", title: "后端开发(Java)", city: "深圳", status: "published" },
      // job-2 has no requisition row → falls back to id as title
    ]);

    const res = await GET();
    const j = await res.json();

    expect(res.status).toBe(200);
    const job1 = j.jobs.find((x: any) => x.jobId === "job-1");
    expect(job1.candidateTotal).toBe(2);
    const rc1 = job1.stages.find((s: any) => s.key === "rule_check");
    expect(rc1).toMatchObject({ available: true, passed: 1, dropped: 1 });
    expect(job1.title).toBe("后端开发(Java)");

    const job2 = j.jobs.find((x: any) => x.jobId === "job-2");
    expect(job2.title).toBe("job-2"); // fallback
    expect(job2.stages.find((s: any) => s.key === "rule_check").passed).toBe(1);
  });

  it("resolves real job title from job_requisition_json snapshot (titleResolved)", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      {
        job_requisition_id: "job-9",
        candidate_id: "c1",
        decision: "PASS",
        created_at: new Date("2026-06-02"),
        client_display_name: "腾讯",
        client_name: null,
        job_requisition_json: JSON.stringify({ client_job_title: "高级后端工程师", work_city: "深圳" }),
      },
    ]);
    (prisma.jobRequisition.findMany as any).mockResolvedValue([]); // no req row

    const res = await GET();
    const j = await res.json();
    const job = j.jobs[0];
    expect(job.title).toBe("高级后端工程师");
    expect(job.titleResolved).toBe(true);
    expect(job.city).toBe("深圳");
  });

  it("marks non-rule-check stages as not wired (available:false, no counts)", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      { job_requisition_id: "job-1", candidate_id: "c1", decision: "PASS", created_at: new Date("2026-06-02"), client_display_name: "腾讯", client_name: null },
    ]);
    (prisma.jobRequisition.findMany as any).mockResolvedValue([
      { id: "job-1", client: "腾讯", title: "后端", city: null, status: "published" },
    ]);

    const res = await GET();
    const j = await res.json();
    const intake = j.jobs[0].stages.find((s: any) => s.key === "intake");
    expect(intake.available).toBe(false);
    expect(intake.passed).toBeUndefined();
    // catalog reflects only rule_check as wired
    expect(j.stages.filter((s: any) => s.available).map((s: any) => s.key)).toEqual(["rule_check"]);
  });

  it("computes kpi pass rate over checked candidates", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      { job_requisition_id: "job-1", candidate_id: "c1", decision: "PASS", created_at: new Date("2026-06-02"), client_display_name: null, client_name: null },
      { job_requisition_id: "job-1", candidate_id: "c2", decision: "PASS", created_at: new Date("2026-06-02"), client_display_name: null, client_name: null },
      { job_requisition_id: "job-1", candidate_id: "c3", decision: "FAIL", created_at: new Date("2026-06-02"), client_display_name: null, client_name: null },
    ]);
    (prisma.jobRequisition.findMany as any).mockResolvedValue([
      { id: "job-1", client: "x", title: "t", city: null, status: "published" },
    ]);
    const res = await GET();
    const j = await res.json();
    expect(j.kpi.candidatesInFunnel).toBe(3);
    expect(j.kpi.ruleCheckPassRate).toBe(67); // 2/3
    expect(j.kpi.openJobs).toBe(1);
  });

  it("returns 500 + empty + error on DB failure", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockRejectedValue(new Error("down"));
    const res = await GET();
    const j = await res.json();
    expect(res.status).toBe(500);
    expect(j.jobs).toEqual([]);
    expect(j.meta.error).toContain("down");
  });
});
