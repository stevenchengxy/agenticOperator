import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: { jobRequisition: { findUnique: vi.fn() }, jobDescription: { findMany: vi.fn() } },
}));
vi.mock("@/lib/raas-api-client", () => ({
  getRequirementDetail: vi.fn(),
  isRaasApiConfigured: vi.fn(),
}));

import { GET } from "./route";
import { prisma } from "@/server/db";
import { getRequirementDetail, isRaasApiConfigured } from "@/lib/raas-api-client";

describe("GET /api/funnel/job-requisition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isRaasApiConfigured as any).mockReturnValue(false);
  });

  it("returns requisition + JD + lifecycle from Postgres", async () => {
    (prisma.jobRequisition.findUnique as any).mockResolvedValue({
      id: "job-1", status: "published", title: "后端工程师", client: "腾讯", city: "深圳", headcount: 2,
      salaryRangeMin: 30000, salaryRangeMax: 50000, responsibilities: "写代码", requirements: "3年", niceToHaves: "Go",
      source: "sync", rawPayload: JSON.stringify({ raw: "原始需求" }), createdAt: new Date("2026-05-01"), updatedAt: new Date("2026-05-02"),
    });
    (prisma.jobDescription.findMany as any).mockResolvedValue([
      { id: "jd-1", title: "后端工程师", status: "published", qualityScore: 0.9, marketCompetitiveness: "高",
        mustHaveSkills: JSON.stringify(["Java", "MySQL"]), niceToHaveSkills: JSON.stringify(["Go"]), degreeRequirement: "本科及以上",
        workYears: 3, expectedLevel: "T3-T4", interviewMode: "视频面试", searchKeywords: "java,backend", generatorMode: "robohire",
        generatorModel: "gemini", jdContent: "JD 全文", createdAt: new Date("2026-05-02") },
    ]);

    const res = await GET(new Request("http://x/api/funnel/job-requisition?id=job-1"));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.found).toBe(true);
    expect(j.status).toBe("published");
    expect(j.requisition).toMatchObject({ title: "后端工程师", headcount: 2 });
    expect(j.jds[0]).toMatchObject({ qualityScore: 0.9, mustHaveSkills: ["Java", "MySQL"], degreeRequirement: "本科及以上" });
    expect(j.rawSource).toBe("postgres");
    expect(j.rawRequirement).toMatchObject({ raw: "原始需求" });
    // lifecycle: published reached up to index 3
    expect(j.lifecycle.filter((s: any) => s.reached).map((s: any) => s.key)).toEqual(["logged", "clarified", "jd_ready", "published"]);
    expect(j.lifecycle.find((s: any) => s.current).key).toBe("published");
  });

  it("falls back to RAAS live when no Postgres row", async () => {
    (prisma.jobRequisition.findUnique as any).mockResolvedValue(null);
    (isRaasApiConfigured as any).mockReturnValue(true);
    (getRequirementDetail as any).mockResolvedValue({ requirement: "from RAAS" });

    const res = await GET(new Request("http://x/api/funnel/job-requisition?id=job-x"));
    const j = await res.json();
    expect(j.found).toBe(false);
    expect(j.rawSource).toBe("raas");
    expect(j.rawRequirement).toMatchObject({ requirement: "from RAAS" });
    expect(j.lifecycle.every((s: any) => !s.reached)).toBe(true);
  });

  it("degrades silently when RAAS throws", async () => {
    (prisma.jobRequisition.findUnique as any).mockResolvedValue(null);
    (isRaasApiConfigured as any).mockReturnValue(true);
    (getRequirementDetail as any).mockRejectedValue(new Error("raas down"));
    const res = await GET(new Request("http://x/api/funnel/job-requisition?id=job-x"));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.found).toBe(false);
    expect(j.rawRequirement).toBeNull();
  });

  it("requires id", async () => {
    const res = await GET(new Request("http://x/api/funnel/job-requisition"));
    expect(res.status).toBe(400);
  });
});
