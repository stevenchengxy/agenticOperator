// POST /api/funnel/backfill-events
//
// 把已有的 RuleCheckAudit（直接 seed、没走事件总线的预筛审计）"按事件"
// 重建：给每条审计写一条 MATCH_RULE_CHECK_PASSED/FAILED 的 EventInstance，
// payload 带 candidate_id / job_requisition_id / trace_id，让流程追踪的 L3
// 时间线与 /api/events/candidates 这类事件聚合能"按事件"串起这条链。
//
// 幂等：externalEventId = evt_rcheck_<audit_id>，createMany skipDuplicates，
// 重复跑只补新审计、不重复写。

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

export type BackfillResponse = {
  scanned: number;
  created: number;
  meta: { generatedAt: string; error?: string };
};

export async function POST(): Promise<Response> {
  try {
    const audits = await prisma.ruleCheckAudit.findMany({
      select: {
        audit_id: true,
        candidate_id: true,
        job_requisition_id: true,
        decision: true,
        trace_id: true,
        run_id: true,
        created_at: true,
      },
      orderBy: { created_at: "asc" },
      take: 20000,
    });

    const rows = audits.map((a) => {
      const pass = a.decision === "PASS";
      return {
        externalEventId: `evt_rcheck_${a.audit_id}`,
        name: pass ? "MATCH_RULE_CHECK_PASSED" : "MATCH_RULE_CHECK_FAILED",
        source: "rule-check-backfill",
        status: "accepted",
        payloadSummary: JSON.stringify({
          candidate_id: a.candidate_id,
          job_requisition_id: a.job_requisition_id,
          trace_id: a.trace_id ?? a.run_id,
          run_id: a.run_id,
          decision: a.decision,
          audit_id: a.audit_id,
          backfilled: true,
        }),
        ts: a.created_at,
      };
    });

    const res = rows.length
      ? await prisma.eventInstance.createMany({ data: rows, skipDuplicates: true })
      : { count: 0 };

    return NextResponse.json<BackfillResponse>({
      scanned: audits.length,
      created: res.count,
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json<BackfillResponse>(
      { scanned: 0, created: 0, meta: { generatedAt: new Date().toISOString(), error: (e as Error).message.slice(0, 200) } },
      { status: 500 },
    );
  }
}
