// GET /api/funnel/jobs — 招聘漏斗 L1（按岗位）
//
// 读时聚合，零新表。漏斗只有「规则预筛」一环今天有真数据
// (RuleCheckAudit: candidate_id × job_requisition_id × decision)；上游
// (入库) 与下游 (评分/邀约/HITL/offer) 在伙伴系统或只在事件流里按 trace
// 散着、未按岗位聚合，故标 available:false 由前端打灰「数据未接入」。
//
// 每岗位的预筛计数按 distinct candidate_id 取该候选人最新一条 decision。

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { jobMetaFromSnapshot, resolveNamesBestEffort } from "@/lib/funnel/names";
import { eventToStage, type PipelineStage } from "@/lib/events/pipeline-stages";

export const dynamic = "force-dynamic";

// pipeline-stage → 漏斗阶段 key（parse 折进 intake，other 忽略）。
const PIPELINE_TO_FUNNEL: Partial<Record<PipelineStage, string>> = {
  intake: "intake",
  parse: "intake",
  rule_check: "rule_check",
  match: "match",
  interview: "interview",
  evaluate: "evaluate",
  submit: "submit",
};

const CAND_RE = /"candidate_id"\s*:\s*"([^"]+)"/;
const JR_RE = /"job_requisition_id"\s*:\s*"([^"]+)"/;

// 事件驱动：扫近 8000 条 EventInstance，按 job → 漏斗阶段 → distinct 候选人 聚合。
// 让 match/interview/evaluate/submit 等环在真事件流入后自动点亮（#3 接线）。
async function loadEventStagesByJob(): Promise<Map<string, Map<string, Set<string>>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  const rows = await prisma.eventInstance.findMany({
    select: { name: true, payloadSummary: true },
    orderBy: { ts: "desc" },
    take: 8000,
  });
  for (const r of rows) {
    if (!r.payloadSummary) continue;
    const stage = PIPELINE_TO_FUNNEL[eventToStage(r.name)];
    if (!stage) continue;
    const job = JR_RE.exec(r.payloadSummary)?.[1];
    const cand = CAND_RE.exec(r.payloadSummary)?.[1];
    if (!job || !cand) continue;
    let byStage = out.get(job);
    if (!byStage) out.set(job, (byStage = new Map()));
    let set = byStage.get(stage);
    if (!set) byStage.set(stage, (set = new Set()));
    set.add(cand);
  }
  return out;
}

// 漏斗阶段目录 — 对齐 lib/events/pipeline-stages 的标准招聘流程顺序：
// 入库 → 规则预筛 → 匹配 → 面试 → 评估 → 提交。available 决定前端是否打灰。
// （旧版误把"评估"放面试前、且把"人工确认"当作流程阶段，均已修正。）
export const FUNNEL_STAGES = [
  { key: "intake", available: false },
  { key: "rule_check", available: true },
  { key: "match", available: false },
  { key: "interview", available: false },
  { key: "evaluate", available: false },
  { key: "submit", available: false },
] as const;

export type FunnelStageCount = {
  key: string;
  available: boolean;
  passed?: number; // 通过该环的候选人数
  dropped?: number; // 在该环掉队 (拦截/失败) 的候选人数
};

export type FunnelJobRow = {
  jobId: string;
  client: string;
  title: string;
  titleResolved: boolean; // true=title 是解析到的真名；false=回退成 jobId
  city?: string;
  status: string;
  candidateTotal: number; // 进入漏斗 (命中预筛) 的 distinct 候选人数
  stages: FunnelStageCount[];
};

export type FunnelJobsResponse = {
  jobs: FunnelJobRow[];
  kpi: { openJobs: number; candidatesInFunnel: number; ruleCheckPassRate: number | null };
  stages: { key: string; available: boolean }[];
  meta: { generatedAt: string; error?: string };
};

const OPEN_STATUSES = new Set(["jd_ready", "published"]);

export async function GET(): Promise<Response> {
  const stages = FUNNEL_STAGES.map((s) => ({ key: s.key, available: s.available }));
  try {
    // 1. 拉预筛审计的最小列，JS 内聚合 (Prisma groupBy 难做 distinct-候选人取最新)。
    const audits = await prisma.ruleCheckAudit.findMany({
      select: {
        job_requisition_id: true,
        candidate_id: true,
        decision: true,
        created_at: true,
        client_display_name: true,
        client_name: true,
        job_requisition_json: true,
      },
      orderBy: { created_at: "desc" },
      take: 5000,
    });

    // 2. 每 (job, candidate) 取最新一条 (audits 已按 created_at desc，先到即最新)。
    //    岗位标题/城市从最新审计的 job_requisition_json 快照里抠。
    type JobAgg = {
      jobId: string;
      client: string;
      snapTitle: string | null;
      snapCity: string | null;
      seen: Map<string, string>; // candidate_id → latest decision
    };
    const byJob = new Map<string, JobAgg>();
    for (const a of audits) {
      let j = byJob.get(a.job_requisition_id);
      if (!j) {
        const meta = jobMetaFromSnapshot(a.job_requisition_json);
        j = {
          jobId: a.job_requisition_id,
          client: a.client_display_name ?? a.client_name ?? "",
          snapTitle: meta.title,
          snapCity: meta.city,
          seen: new Map(),
        };
        byJob.set(a.job_requisition_id, j);
      }
      if (!j.seen.has(a.candidate_id)) j.seen.set(a.candidate_id, a.decision);
    }

    // 3. 富化岗位元信息 (title/city/status)。
    const jobIds = Array.from(byJob.keys());
    const reqs = jobIds.length
      ? await prisma.jobRequisition.findMany({
          where: { id: { in: jobIds } },
          select: { id: true, client: true, title: true, city: true, status: true },
        })
      : [];
    const reqMap = new Map(reqs.map((r) => [r.id, r]));

    // 标题缺口 → Neo4j best-effort（快照与 JobRequisition 都没标题的岗位）。
    const needName = jobIds.filter((id) => {
      const agg = byJob.get(id)!;
      return !agg.snapTitle && !reqMap.get(id)?.title;
    });
    const neoNames = await resolveNamesBestEffort("JobRequisition", needName);

    // 事件驱动的各环候选人数（rule_check 仍用审计的真 pass/fail）。
    const eventStages = await loadEventStagesByJob();

    let candidatesInFunnel = 0;
    let totalPass = 0;
    let totalChecked = 0;

    const jobs: FunnelJobRow[] = jobIds.map((jobId) => {
      const agg = byJob.get(jobId)!;
      const req = reqMap.get(jobId);
      let pass = 0;
      let fail = 0;
      for (const decision of agg.seen.values()) {
        if (decision === "PASS") pass++;
        else if (decision === "FAIL") fail++;
      }
      const total = agg.seen.size;
      candidatesInFunnel += total;
      totalPass += pass;
      totalChecked += pass + fail;

      const jobEventStages = eventStages.get(jobId);
      const stageCounts: FunnelStageCount[] = FUNNEL_STAGES.map((s) => {
        if (s.key === "rule_check") {
          return { key: s.key, available: true, passed: pass, dropped: fail };
        }
        // 其它环：有该阶段事件 → 点亮 + 计数（distinct 候选人）；否则未接入。
        const reached = jobEventStages?.get(s.key)?.size ?? 0;
        return reached > 0 ? { key: s.key, available: true, passed: reached, dropped: 0 } : { key: s.key, available: false };
      });

      // 标题优先级：快照 → JobRequisition → Neo4j → id 兜底。
      const title = agg.snapTitle ?? req?.title ?? neoNames.get(jobId) ?? jobId;
      const titleResolved = title !== jobId;

      return {
        jobId,
        client: req?.client ?? agg.client,
        title,
        titleResolved,
        city: agg.snapCity ?? req?.city ?? undefined,
        status: req?.status ?? "unknown",
        candidateTotal: total,
        stages: stageCounts,
      };
    });

    // 漏斗候选人多的岗位排前。
    jobs.sort((a, b) => b.candidateTotal - a.candidateTotal);

    const openJobs = jobs.filter((j) => OPEN_STATUSES.has(j.status)).length;
    const passRate = totalChecked > 0 ? Math.round((totalPass / totalChecked) * 100) : null;

    return NextResponse.json<FunnelJobsResponse>({
      jobs,
      kpi: { openJobs, candidatesInFunnel, ruleCheckPassRate: passRate },
      stages,
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json<FunnelJobsResponse>(
      {
        jobs: [],
        kpi: { openJobs: 0, candidatesInFunnel: 0, ruleCheckPassRate: null },
        stages,
        meta: { generatedAt: new Date().toISOString(), error: (e as Error).message.slice(0, 200) },
      },
      { status: 500 },
    );
  }
}
