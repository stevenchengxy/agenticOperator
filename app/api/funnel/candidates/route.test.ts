import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: {
    ruleCheckAudit: { findMany: vi.fn() },
    humanTask: { findMany: vi.fn() },
    workflowRun: { findMany: vi.fn() },
    eventInstance: { findMany: vi.fn() },
  },
}));

// Neo4j name resolver — keep unit tests offline (pure snapshot path still real).
vi.mock("@/lib/allmeta-client", () => ({
  resolveEntityNames: vi.fn().mockResolvedValue(new Map()),
}));

import { GET } from "./route";
import { prisma } from "@/server/db";

function mockEnrich({
  pending = [],
  failed = [],
  existing = [],
  events = [],
}: { pending?: string[]; failed?: string[]; existing?: string[]; events?: string[] } = {}) {
  (prisma.humanTask.findMany as any).mockResolvedValue(pending.map((runId) => ({ runId })));
  (prisma.workflowRun.findMany as any).mockResolvedValue([
    ...failed.map((id) => ({ id, status: "failed" })),
    ...existing.map((id) => ({ id, status: "completed" })),
  ]);
  (prisma.eventInstance.findMany as any).mockResolvedValue(
    events.map((cid) => ({ payloadSummary: JSON.stringify({ candidate_id: cid }) })),
  );
}

describe("GET /api/funnel/candidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.eventInstance.findMany as any).mockResolvedValue([]); // default: no events
  });

  it("L2 cohort: latest audit per candidate with trace_id passthrough", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      { candidate_id: "c1", job_requisition_id: "job-1", decision: "PASS", trace_id: "tr_1", run_id: "r1", created_at: new Date("2026-06-02"), client_display_name: "腾讯", client_name: null },
      { candidate_id: "c1", job_requisition_id: "job-1", decision: "FAIL", trace_id: "tr_old", run_id: "r0", created_at: new Date("2026-06-01"), client_display_name: "腾讯", client_name: null },
      { candidate_id: "c2", job_requisition_id: "job-1", decision: "FAIL", trace_id: "tr_2", run_id: "r2", created_at: new Date("2026-06-02"), client_display_name: "腾讯", client_name: null },
    ]);
    mockEnrich();

    const res = await GET(new Request("http://x/api/funnel/candidates?job=job-1"));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.dimension).toBe("job");
    const c1 = j.candidates.find((c: any) => c.candidateId === "c1");
    expect(c1).toMatchObject({ status: "active", decision: "PASS", traceId: "tr_1" });
    const c2 = j.candidates.find((c: any) => c.candidateId === "c2");
    expect(c2.status).toBe("blocked"); // FAIL
  });

  it("maps pending HITL → review and failed run → failed", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      { candidate_id: "c1", job_requisition_id: "job-1", decision: "PASS", trace_id: "tr_1", run_id: "r1", created_at: new Date("2026-06-02"), client_display_name: null, client_name: null },
      { candidate_id: "c2", job_requisition_id: "job-1", decision: "PASS", trace_id: "tr_2", run_id: "r2", created_at: new Date("2026-06-02"), client_display_name: null, client_name: null },
    ]);
    mockEnrich({ pending: ["r1"], failed: ["r2"] });

    const res = await GET(new Request("http://x/api/funnel/candidates?job=job-1"));
    const j = await res.json();
    expect(j.candidates.find((c: any) => c.candidateId === "c1").status).toBe("review");
    expect(j.candidates.find((c: any) => c.candidateId === "c2").status).toBe("failed");
  });

  it("byCandidate roster counts distinct jobs per candidate", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      { candidate_id: "c1", job_requisition_id: "job-1", decision: "PASS", trace_id: "tr_1", run_id: "r1", created_at: new Date("2026-06-02"), client_display_name: null, client_name: null },
      { candidate_id: "c1", job_requisition_id: "job-2", decision: "FAIL", trace_id: "tr_1b", run_id: "r1b", created_at: new Date("2026-06-01"), client_display_name: null, client_name: null },
    ]);
    mockEnrich();

    const res = await GET(new Request("http://x/api/funnel/candidates?byCandidate=1"));
    const j = await res.json();
    expect(j.dimension).toBe("candidate");
    expect(j.candidates).toHaveLength(1);
    expect(j.candidates[0].jobCount).toBe(2);
  });

  it("gates hasLineage: trace_id present OR run exists; falls back lineageId to run_id", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      // synthetic run, no trace, run not in WorkflowRun → no lineage
      { candidate_id: "c1", job_requisition_id: "job-1", decision: "PASS", trace_id: null, run_id: "rca_no-trace_x", created_at: new Date("2026-06-02"), client_display_name: null, client_name: null },
      // real run exists → lineage available via run_id
      { candidate_id: "c2", job_requisition_id: "job-1", decision: "PASS", trace_id: null, run_id: "r-real", created_at: new Date("2026-06-02"), client_display_name: null, client_name: null },
    ]);
    mockEnrich({ existing: ["r-real"] });

    const res = await GET(new Request("http://x/api/funnel/candidates?job=job-1"));
    const j = await res.json();
    const c1 = j.candidates.find((c: any) => c.candidateId === "c1");
    expect(c1.hasLineage).toBe(false);
    expect(c1.lineageId).toBe("rca_no-trace_x"); // fallback to run_id
    const c2 = j.candidates.find((c: any) => c.candidateId === "c2");
    expect(c2.hasLineage).toBe(true);
  });

  it("resolves real candidate name from parsed_resume_json snapshot", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      {
        candidate_id: "c1",
        job_requisition_id: "job-1",
        decision: "PASS",
        trace_id: "tr_1",
        run_id: "r1",
        created_at: new Date("2026-06-02"),
        client_display_name: null,
        client_name: null,
        parsed_resume_json: JSON.stringify({ name: "张伟" }),
      },
    ]);
    mockEnrich();
    const res = await GET(new Request("http://x/api/funnel/candidates?job=job-1"));
    const j = await res.json();
    expect(j.candidates[0].candidateName).toBe("张伟");
  });

  it("event-driven lineage: candidate with an EventInstance is clickable (hasLineage)", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([
      // synthetic run, no trace — would be dead, but it has a backfilled event
      { candidate_id: "c1", job_requisition_id: "job-1", decision: "PASS", trace_id: null, run_id: "rca_no-trace_x", created_at: new Date("2026-06-02"), client_display_name: null, client_name: null, parsed_resume_json: null },
    ]);
    mockEnrich({ events: ["c1"] }); // EventInstance mentions c1
    const res = await GET(new Request("http://x/api/funnel/candidates?job=job-1"));
    const j = await res.json();
    expect(j.candidates[0].hasLineage).toBe(true);
  });

  it("returns 500 + empty on DB failure", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockRejectedValue(new Error("boom"));
    const res = await GET(new Request("http://x/api/funnel/candidates?job=job-1"));
    const j = await res.json();
    expect(res.status).toBe(500);
    expect(j.candidates).toEqual([]);
    expect(j.meta.error).toContain("boom");
  });
});
