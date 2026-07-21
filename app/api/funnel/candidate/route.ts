// GET /api/funnel/candidate?id=<candidateId>
//
// 按候选人维度的详情：这个候选人申请/匹配了哪些岗位、各岗位预筛结果、
// 经历了多少事件、到达了哪些流程阶段。给"按候选人"视图的候选人画像用。

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { candidateNameFromSnapshot, jobMetaFromSnapshot, resolveNamesBestEffort } from "@/lib/funnel/names";
import { eventToStage, STAGE_META, type PipelineStage } from "@/lib/events/pipeline-stages";

export const dynamic = "force-dynamic";

export type CandidateJobRow = {
  jobId: string;
  jobTitle: string;
  titleResolved: boolean;
  client: string | null;
  decision: string; // 该岗位最新预筛决策 PASS | FAIL
  auditCount: number; // 该岗位上的预筛次数
  lastActivityAt: string;
};

export type FunnelCandidateDetailResponse = {
  candidateId: string;
  candidateName: string | null;
  jobs: CandidateJobRow[];
  totalEvents: number;
  stagesReached: { key: PipelineStage; label: string }[];
  hasLineage: boolean;
  meta: { generatedAt: string; error?: string };
};

export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id")?.trim() ?? "";
  if (!id) {
    return NextResponse.json<FunnelCandidateDetailResponse>(
      { candidateId: "", candidateName: null, jobs: [], totalEvents: 0, stagesReached: [], hasLineage: false, meta: { generatedAt: new Date().toISOString(), error: "id is required" } },
      { status: 400 },
    );
  }

  try {
    const audits = await prisma.ruleCheckAudit.findMany({
      where: { candidate_id: id },
      orderBy: { created_at: "desc" },
      take: 2000,
      select: {
        job_requisition_id: true,
        decision: true,
        created_at: true,
        job_requisition_json: true,
        client_display_name: true,
        client_name: true,
        parsed_resume_json: true,
      },
    });

    // 每岗位：最新决策 + 计数 + 标题（快照）。
    type Agg = { jobId: string; decision: string; count: number; last: Date; title: string | null; client: string | null };
    const byJob = new Map<string, Agg>();
    let snapName: string | null = null;
    for (const a of audits) {
      if (!snapName) snapName = candidateNameFromSnapshot(a.parsed_resume_json);
      let j = byJob.get(a.job_requisition_id);
      if (!j) {
        const meta = jobMetaFromSnapshot(a.job_requisition_json);
        j = {
          jobId: a.job_requisition_id,
          decision: a.decision, // audits desc → first is latest
          count: 0,
          last: a.created_at,
          title: meta.title,
          client: a.client_display_name ?? a.client_name ?? null,
        };
        byJob.set(a.job_requisition_id, j);
      }
      j.count++;
    }

    // 名字 + 缺标题的岗位 → Neo4j 兜底。
    const jobIds = Array.from(byJob.keys());
    const needTitle = jobIds.filter((jid) => !byJob.get(jid)!.title);
    const [candName, jobNames] = await Promise.all([
      snapName
        ? Promise.resolve(new Map([[id, snapName]]))
        : resolveNamesBestEffort("Candidate", [id]),
      resolveNamesBestEffort("JobRequisition", needTitle),
    ]);

    const jobs: CandidateJobRow[] = jobIds
      .map((jid) => {
        const j = byJob.get(jid)!;
        const title = j.title ?? jobNames.get(jid) ?? jid;
        return {
          jobId: jid,
          jobTitle: title,
          titleResolved: title !== jid,
          client: j.client,
          decision: j.decision,
          auditCount: j.count,
          lastActivityAt: j.last.toISOString(),
        };
      })
      .sort((a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt));

    // 事件：总数 + 到达的阶段。
    const events = await prisma.eventInstance.findMany({
      where: { payloadSummary: { contains: id } },
      select: { name: true },
      take: 500,
    });
    const stageSet = new Set<PipelineStage>();
    for (const e of events) stageSet.add(eventToStage(e.name));
    const stagesReached = Array.from(stageSet)
      .sort((a, b) => STAGE_META[a].order - STAGE_META[b].order)
      .map((k) => ({ key: k, label: STAGE_META[k].zh }));

    return NextResponse.json<FunnelCandidateDetailResponse>({
      candidateId: id,
      candidateName: candName.get(id) ?? null,
      jobs,
      totalEvents: events.length,
      stagesReached,
      hasLineage: events.length > 0,
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json<FunnelCandidateDetailResponse>(
      { candidateId: id, candidateName: null, jobs: [], totalEvents: 0, stagesReached: [], hasLineage: false, meta: { generatedAt: new Date().toISOString(), error: (e as Error).message.slice(0, 200) } },
      { status: 500 },
    );
  }
}
