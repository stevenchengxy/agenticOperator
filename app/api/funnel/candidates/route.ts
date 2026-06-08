// GET /api/funnel/candidates — 招聘漏斗 L2（阶段候选人名单）/ 按候选人维度
//
//   ?job=<id>[&stage=<k>]  → 该岗位落在/通过该环的候选人名单 (L2 cohort)
//   ?byCandidate=1         → 按候选人维度的花名册 (L1 的「按候选人」切换)
//
// 数据来自 RuleCheckAudit 按 candidate_id 分组取最新一条；状态用 run_id
// 富化 HumanTask(pending→待复核) 与 WorkflowRun(failed→失败)。trace_id 透传
// 给 L3 (/api/correlations/:traceId) 做端到端时间线深链。

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { candidateNameFromSnapshot, resolveNamesBestEffort } from "@/lib/funnel/names";

export const dynamic = "force-dynamic";

export type FunnelCandidateStatus =
  | "active" // 进行中
  | "review" // 待复核
  | "blocked" // 已拦截
  | "failed" // 失败
  | "submitted"; // 已提交

export type FunnelCandidateRow = {
  candidateId: string;
  candidateName: string | null; // 解析到的真名；null=没解到，前端回退显示 id
  jobId: string;
  jobTitle?: string;
  client?: string;
  traceId: string | null;
  runId: string;
  // L3 端到端时间线的桥接 id：优先 trace_id，缺失时回退 run_id。
  // /api/correlations/:id 对 trace_id / correlationId / runId 一律 OR 匹配，
  // 而 RuleCheckAudit.trace_id 实测常为空、run_id 恒有值，故回退到 run_id。
  lineageId: string;
  // 是否真有端到端血缘可下钻：trace_id 存在，或 run_id 真对应一条 WorkflowRun。
  // 实测部分预筛审计的 run_id 是 `rca_no-trace_*` 合成占位符、不指向任何真 run，
  // 此时 L3 时间线为空——故据此控制行是否可点，避免"点了进空页"。
  hasLineage: boolean;
  status: FunnelCandidateStatus;
  stageKey: string; // 已达最远阶段 — Phase 1 恒为 "rule_check"
  decision: string; // PASS | FAIL
  lastActivityAt: string;
  jobCount?: number; // 仅 byCandidate 维度：该候选人横跨的岗位数
};

export type FunnelCandidatesResponse = {
  candidates: FunnelCandidateRow[];
  dimension: "job" | "candidate";
  jobId?: string;
  meta: { generatedAt: string; error?: string };
};

type AuditLite = {
  candidate_id: string;
  job_requisition_id: string;
  decision: string;
  trace_id: string | null;
  run_id: string;
  created_at: Date;
  client_display_name: string | null;
  client_name: string | null;
  parsed_resume_json: string | null;
};

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("job");
  const byCandidate = searchParams.get("byCandidate") === "1";
  const stage = searchParams.get("stage");
  const dimension: "job" | "candidate" = byCandidate ? "candidate" : "job";

  try {
    const audits = (await prisma.ruleCheckAudit.findMany({
      where: jobId ? { job_requisition_id: jobId } : undefined,
      select: {
        candidate_id: true,
        job_requisition_id: true,
        decision: true,
        trace_id: true,
        run_id: true,
        created_at: true,
        client_display_name: true,
        client_name: true,
        parsed_resume_json: true,
      },
      orderBy: { created_at: "desc" },
      take: 5000,
    })) as AuditLite[];

    if (byCandidate) {
      // 花名册：每 candidate 取最新一条 + 横跨岗位数。
      const latest = new Map<string, AuditLite>();
      const jobsPerCand = new Map<string, Set<string>>();
      for (const a of audits) {
        if (!latest.has(a.candidate_id)) latest.set(a.candidate_id, a);
        let s = jobsPerCand.get(a.candidate_id);
        if (!s) jobsPerCand.set(a.candidate_id, (s = new Set()));
        s.add(a.job_requisition_id);
      }
      const candIds = Array.from(latest.keys());
      const [enrich, names, evset] = await Promise.all([
        loadRunStatus(Array.from(latest.values()).map((a) => a.run_id)),
        buildNameMap(latest),
        loadCandidatesWithEvents(candIds),
      ]);
      const candidates: FunnelCandidateRow[] = Array.from(latest.values())
        .map((a) =>
          toRow(a, enrich, names.get(a.candidate_id) ?? null, evset.has(a.candidate_id), jobsPerCand.get(a.candidate_id)?.size ?? 1),
        )
        .sort((x, y) => +new Date(y.lastActivityAt) - +new Date(x.lastActivityAt));
      return NextResponse.json<FunnelCandidatesResponse>({
        candidates,
        dimension,
        meta: { generatedAt: new Date().toISOString() },
      });
    }

    // L2 cohort：每 candidate 取最新一条。
    const latest = new Map<string, AuditLite>();
    for (const a of audits) if (!latest.has(a.candidate_id)) latest.set(a.candidate_id, a);

    const cohortIds = Array.from(latest.keys());
    const [enrich, names, evset] = await Promise.all([
      loadRunStatus(Array.from(latest.values()).map((a) => a.run_id)),
      buildNameMap(latest),
      loadCandidatesWithEvents(cohortIds),
    ]);
    let candidates = Array.from(latest.values()).map((a) =>
      toRow(a, enrich, names.get(a.candidate_id) ?? null, evset.has(a.candidate_id)),
    );

    // 阶段筛选 — Phase 1 仅 rule_check 真：PASS→进行中/待复核, FAIL→已拦截。
    if (stage === "rule_check") {
      candidates = candidates.filter((c) => c.decision === "PASS" || c.decision === "FAIL");
    }

    candidates.sort((x, y) => +new Date(y.lastActivityAt) - +new Date(x.lastActivityAt));

    return NextResponse.json<FunnelCandidatesResponse>({
      candidates,
      dimension,
      jobId: jobId ?? undefined,
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json<FunnelCandidatesResponse>(
      {
        candidates: [],
        dimension,
        jobId: jobId ?? undefined,
        meta: { generatedAt: new Date().toISOString(), error: (e as Error).message.slice(0, 200) },
      },
      { status: 500 },
    );
  }
}

type RunStatus = { pendingHitl: Set<string>; failedRun: Set<string>; existingRun: Set<string> };

async function loadRunStatus(runIds: string[]): Promise<RunStatus> {
  const ids = Array.from(new Set(runIds.filter(Boolean)));
  const pendingHitl = new Set<string>();
  const failedRun = new Set<string>();
  const existingRun = new Set<string>();
  if (!ids.length) return { pendingHitl, failedRun, existingRun };

  const [tasks, runs] = await Promise.all([
    prisma.humanTask.findMany({
      where: { runId: { in: ids }, status: "pending" },
      select: { runId: true },
    }),
    prisma.workflowRun.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    }),
  ]);
  for (const t of tasks) pendingHitl.add(t.runId);
  for (const r of runs) {
    existingRun.add(r.id);
    if (r.status === "failed" || r.status === "timed_out") failedRun.add(r.id);
  }
  return { pendingHitl, failedRun, existingRun };
}

// 名字映射：先从每个候选人最新审计的 parsed_resume_json 快照抠 name，
// 抠不到的再走 Neo4j best-effort。
async function buildNameMap(latest: Map<string, AuditLite>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const missing: string[] = [];
  for (const [cid, a] of latest) {
    const n = candidateNameFromSnapshot(a.parsed_resume_json);
    if (n) names.set(cid, n);
    else missing.push(cid);
  }
  const neo = await resolveNamesBestEffort("Candidate", missing);
  for (const [id, n] of neo) names.set(id, n);
  return names;
}

// 哪些候选人在事件总线里有事件（端到端链路可下钻）。一次性扫近 8000 条
// EventInstance 的 payloadSummary 抠 candidate_id，与本批求交集。回填后每个
// 预筛候选人都有一条 MATCH_RULE_CHECK 事件 → 行可点进事件时间线。
async function loadCandidatesWithEvents(candidateIds: string[]): Promise<Set<string>> {
  const want = new Set(candidateIds.filter(Boolean));
  const has = new Set<string>();
  if (want.size === 0) return has;
  const rows = await prisma.eventInstance.findMany({
    select: { payloadSummary: true },
    orderBy: { ts: "desc" },
    take: 8000,
  });
  const RE = /"candidate_id"\s*:\s*"([^"]+)"/g;
  for (const r of rows) {
    if (!r.payloadSummary) continue;
    RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE.exec(r.payloadSummary)) !== null) {
      if (want.has(m[1])) has.add(m[1]);
    }
  }
  return has;
}

function toRow(
  a: AuditLite,
  enrich: RunStatus,
  name: string | null,
  hasEvent: boolean,
  jobCount?: number,
): FunnelCandidateRow {
  let status: FunnelCandidateStatus;
  if (a.decision === "FAIL") status = "blocked";
  else if (enrich.pendingHitl.has(a.run_id)) status = "review";
  else if (enrich.failedRun.has(a.run_id)) status = "failed";
  else status = "active";

  return {
    candidateId: a.candidate_id,
    candidateName: name,
    jobId: a.job_requisition_id,
    client: a.client_display_name ?? a.client_name ?? undefined,
    traceId: a.trace_id ?? null,
    runId: a.run_id,
    lineageId: a.trace_id ?? a.run_id,
    // 事件驱动：有事件即可下钻 L3 事件时间线；trace/run 存在也算（向前兼容）。
    hasLineage: hasEvent || !!a.trace_id || enrich.existingRun.has(a.run_id),
    status,
    stageKey: "rule_check",
    decision: a.decision,
    lastActivityAt: a.created_at.toISOString(),
    ...(jobCount !== undefined ? { jobCount } : {}),
  };
}
