// GET /api/funnel/timeline?candidate=<id>[&job=<id>]
//
// 流程追踪 L3：按【事件】重建一个候选人的端到端时间线 —— 扫 EventInstance
// 里 payload 提到该 candidate_id 的事件，按 ts 排成一条线。这是"按事件打通"
// 的读取面：与 trace_id/run_id 那条桥解耦，事件总线里有什么就显示什么。
//
// 事件名 → 业务阶段用 eventToStage（与 /events 候选人聚合同源）。

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { eventToStage, STAGE_META, type PipelineStage } from "@/lib/events/pipeline-stages";
import { candidateNameFromSnapshot, resolveNamesBestEffort } from "@/lib/funnel/names";

export const dynamic = "force-dynamic";

const JR_ID_RE = /"job_requisition_id"\s*:\s*"([^"]+)"/;
const DECISION_RE = /"decision"\s*:\s*"([^"]+)"/;

export type FunnelTimelineEvent = {
  id: string;
  name: string;
  ts: string;
  source: string;
  status: string;
  stage: PipelineStage;
  stageLabelZh: string;
  jobId: string | null;
  decision: string | null;
  auditId: string | null; // 深链到规则检查详情
  payload: Record<string, unknown> | null; // 解析后的 payloadSummary（详情抽屉用）
};

export type FunnelTimelineResponse = {
  candidateId: string;
  candidateName: string | null;
  events: FunnelTimelineEvent[];
  meta: { generatedAt: string; error?: string };
};

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const candidateId = (searchParams.get("candidate") ?? "").trim();
  const jobId = searchParams.get("job")?.trim() || null;

  if (!candidateId) {
    return NextResponse.json<FunnelTimelineResponse>({
      candidateId: "",
      candidateName: null,
      events: [],
      meta: { generatedAt: new Date().toISOString(), error: "candidate is required" },
    });
  }

  try {
    // payloadSummary 是 JSON 字符串；用 contains 命中提到该候选人的事件。
    const rows = await prisma.eventInstance.findMany({
      where: { payloadSummary: { contains: candidateId } },
      orderBy: { ts: "asc" },
      take: 300,
      select: { id: true, name: true, ts: true, source: true, status: true, payloadSummary: true },
    });

    const events: FunnelTimelineEvent[] = rows
      .map((r) => {
        const raw = r.payloadSummary ?? "";
        const eventJob = JR_ID_RE.exec(raw)?.[1] ?? null;
        const stage = eventToStage(r.name);
        let payload: Record<string, unknown> | null = null;
        try {
          const p = JSON.parse(raw);
          if (p && typeof p === "object" && !Array.isArray(p)) payload = p;
        } catch {
          /* leave null */
        }
        return {
          id: r.id,
          name: r.name,
          ts: r.ts.toISOString(),
          source: r.source,
          status: r.status,
          stage,
          stageLabelZh: STAGE_META[stage].zh,
          jobId: eventJob,
          decision: DECISION_RE.exec(raw)?.[1] ?? null,
          auditId: typeof payload?.audit_id === "string" ? (payload.audit_id as string) : null,
          payload,
        };
      })
      // 若带 job，过滤到该岗位的事件（payload 无 job 的保留）。
      .filter((e) => !jobId || e.jobId === null || e.jobId === jobId);

    // 候选人真名：先看事件 payload 里的快照名，再 Neo4j 兜底。
    const snapName =
      events
        .map((e) => candidateNameFromSnapshot(JSON.stringify(e.payload ?? {})))
        .find(Boolean) ?? null;
    const candidateName =
      snapName ?? (await resolveNamesBestEffort("Candidate", [candidateId])).get(candidateId) ?? null;

    return NextResponse.json<FunnelTimelineResponse>({
      candidateId,
      candidateName,
      events,
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json<FunnelTimelineResponse>(
      { candidateId, candidateName: null, events: [], meta: { generatedAt: new Date().toISOString(), error: (e as Error).message.slice(0, 200) } },
      { status: 500 },
    );
  }
}
