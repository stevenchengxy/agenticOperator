// GET /api/funnel/job-requisition?id=<jobRequisitionId>
//
// 按 job_requisition_id 串起岗位画像：原始需求(RAAS/rawPayload) → 解析后的
// JobRequisition → 生成的 JD(JobDescription，含技能/质量分)。并把 status 映射
// 成岗位生命周期(需求→澄清→JD就绪→发布→关闭)。
//
// 数据来源：Postgres(走过 JD 生成管道的岗位有行) → 若无行且 RAAS 已配置，
// 现场 getRequirementDetail(id) 拉原始需求兜底(best-effort，不可达静默降级)。

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { getRequirementDetail, isRaasApiConfigured } from "@/lib/raas-api-client";

export const dynamic = "force-dynamic";

// 岗位生命周期阶段（与 JobRequisition.status 对齐）。
export const JOB_LIFECYCLE = [
  { key: "logged", statuses: ["pending_clarification"] },
  { key: "clarified", statuses: ["clarified"] },
  { key: "jd_ready", statuses: ["jd_ready"] },
  { key: "published", statuses: ["published"] },
  { key: "closed", statuses: ["closed"] },
] as const;

export type LifecycleStep = { key: string; reached: boolean; current: boolean };

export type RequisitionView = {
  status: string;
  title: string;
  client: string;
  city: string | null;
  headcount: number | null;
  salaryRangeMin: number | null;
  salaryRangeMax: number | null;
  responsibilities: string | null;
  requirements: string | null;
  niceToHaves: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type JdView = {
  id: string;
  title: string;
  status: string;
  qualityScore: number | null;
  marketCompetitiveness: string | null;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  degreeRequirement: string | null;
  workYears: number | null;
  expectedLevel: string | null;
  interviewMode: string | null;
  searchKeywords: string | null;
  generatorMode: string | null;
  generatorModel: string | null;
  jdContent: string | null;
  createdAt: string;
};

export type FunnelJobRequisitionResponse = {
  jobId: string;
  found: boolean; // JobRequisition row exists in Postgres
  status: string | null;
  lifecycle: LifecycleStep[];
  requisition: RequisitionView | null;
  jds: JdView[];
  rawRequirement: unknown | null; // rawPayload parsed OR RAAS live
  rawSource: "postgres" | "raas" | null;
  meta: { generatedAt: string; error?: string };
};

function jsonStrArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function lifecycleFor(status: string | null): LifecycleStep[] {
  const idx = status ? JOB_LIFECYCLE.findIndex((s) => (s.statuses as readonly string[]).includes(status)) : -1;
  return JOB_LIFECYCLE.map((s, i) => ({ key: s.key, reached: idx >= 0 && i <= idx, current: i === idx }));
}

export async function GET(req: Request): Promise<Response> {
  const jobId = new URL(req.url).searchParams.get("id")?.trim() ?? "";
  if (!jobId) {
    return NextResponse.json<FunnelJobRequisitionResponse>(
      { jobId: "", found: false, status: null, lifecycle: lifecycleFor(null), requisition: null, jds: [], rawRequirement: null, rawSource: null, meta: { generatedAt: new Date().toISOString(), error: "id is required" } },
      { status: 400 },
    );
  }

  try {
    const r = await prisma.jobRequisition.findUnique({ where: { id: jobId } });

    let requisition: RequisitionView | null = null;
    let rawRequirement: unknown | null = null;
    let rawSource: "postgres" | "raas" | null = null;
    let jds: JdView[] = [];

    if (r) {
      requisition = {
        status: r.status,
        title: r.title,
        client: r.client,
        city: r.city,
        headcount: r.headcount,
        salaryRangeMin: r.salaryRangeMin,
        salaryRangeMax: r.salaryRangeMax,
        responsibilities: r.responsibilities,
        requirements: r.requirements,
        niceToHaves: r.niceToHaves,
        source: r.source,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
      if (r.rawPayload) {
        try {
          rawRequirement = JSON.parse(r.rawPayload);
          rawSource = "postgres";
        } catch {
          /* ignore */
        }
      }
      const jdRows = await prisma.jobDescription.findMany({
        where: { requisitionId: jobId },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
      jds = jdRows.map((j) => ({
        id: j.id,
        title: j.title,
        status: j.status,
        qualityScore: j.qualityScore,
        marketCompetitiveness: j.marketCompetitiveness,
        mustHaveSkills: jsonStrArray(j.mustHaveSkills),
        niceToHaveSkills: jsonStrArray(j.niceToHaveSkills),
        degreeRequirement: j.degreeRequirement,
        workYears: j.workYears,
        expectedLevel: j.expectedLevel,
        interviewMode: j.interviewMode,
        searchKeywords: j.searchKeywords,
        generatorMode: j.generatorMode,
        generatorModel: j.generatorModel,
        jdContent: j.jdContent ? j.jdContent.slice(0, 4000) : null,
        createdAt: j.createdAt.toISOString(),
      }));
    }

    // 没有 Postgres 行 → RAAS 现场拉原始需求兜底。
    if (!rawRequirement && isRaasApiConfigured()) {
      try {
        rawRequirement = await getRequirementDetail(jobId);
        rawSource = "raas";
      } catch {
        /* RAAS 不可达或无此 id → 静默 */
      }
    }

    return NextResponse.json<FunnelJobRequisitionResponse>({
      jobId,
      found: !!r,
      status: r?.status ?? null,
      lifecycle: lifecycleFor(r?.status ?? null),
      requisition,
      jds,
      rawRequirement,
      rawSource,
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json<FunnelJobRequisitionResponse>(
      { jobId, found: false, status: null, lifecycle: lifecycleFor(null), requisition: null, jds: [], rawRequirement: null, rawSource: null, meta: { generatedAt: new Date().toISOString(), error: (e as Error).message.slice(0, 200) } },
      { status: 500 },
    );
  }
}
