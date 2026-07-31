// Manual trigger for INTERVIEW_INVITATION_REQUESTED — bypasses RaaS.
//
// 用 case 见 docs/research/2026-05-25-interview-inviter-agent-use-cases.md §3.
//
// Body 跟 InterviewInvitationRequestedPayload 对齐(见
// server/inngest/client.ts);candidate_id + job_requisition_id 必填,其它
// 全可选。空 body 时填入 stub 默认值跑 happy path 烟测。
//
// 注意:
//  - 没有真实 ROBOHIRE_API_KEY 时,inviteCandidateDirect 会抛 CLIENT err
//    "ROBOHIRE_API_KEY not set" → emit _FAILED ROBOHIRE_4XX。链路完整跑通,
//    只是 RoboHire 那一跳被短路,Neo4j 不会写。
//  - 期望 schema 通过 em.publish(builtin RESUME_INVITATION_REQUESTED_v1
//    zod 校验)→ Inngest 触发 interviewInviterAgent。
//  - 看结果:/events 列表 / Inngest dashboard / Allmeta studio / file log。

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { blockUnsafeDevRouteInProduction } from "@/lib/unsafe-route-guard";

type Body = Partial<{
  // 必填(兜底默认值)
  candidate_id: string;
  job_requisition_id: string;
  // anchors
  application_id: string;
  candidate_match_result_id: string;
  client_id: string;
  resume_id: string;
  recruiter_id: string;
  // RaaS 透传 trace 字段
  correlation_id: string;
  job_posting_id: string;
  requested_at: string;
  trigger_source: string;
  // RoboHire 入参直透
  resume_text: string;
  jd_text: string;
  robohire_resume_id: string;
  robohire_job_id: string;
  hiring_request_id: string;
  candidate_email: string;
  recruiter_email: string;
  interviewer_requirement: string;
  job_title: string;
  company_name: string;
  interview_language: "en" | "zh" | "ja";
  interview_duration: number;
  interview_mode: string;
  passing_score: number;
  linked_assessment_id: string | null;
}>;

export async function POST(req: Request): Promise<Response> {
  const blocked = blockUnsafeDevRouteInProduction("/api/test/trigger-interview-invite");
  if (blocked) return blocked;

  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK — 用默认 stub 跑烟测 */
  }

  const candidateId = body.candidate_id ?? `C-test-${Date.now()}`;
  const jrId = body.job_requisition_id ?? `JR-test-${Date.now()}`;
  const traceId = `trace-test-${randomUUID()}`;

  // Build payload — 只透传调用方明确给的字段(避免 zod 校验时 undefined 误判)。
  const payload: Record<string, unknown> = {
    candidate_id: candidateId,
    job_requisition_id: jrId,
  };
  const optionalFields = [
    "application_id",
    "candidate_match_result_id",
    "client_id",
    "resume_id",
    "recruiter_id",
    "correlation_id",
    "job_posting_id",
    "requested_at",
    "trigger_source",
    "resume_text",
    "jd_text",
    "robohire_resume_id",
    "robohire_job_id",
    "hiring_request_id",
    "candidate_email",
    "recruiter_email",
    "interviewer_requirement",
    "job_title",
    "company_name",
    "interview_language",
    "interview_duration",
    "interview_mode",
    "passing_score",
  ] as const;
  for (const k of optionalFields) {
    const v = (body as Record<string, unknown>)[k];
    if (v !== undefined && v !== null && v !== "") payload[k] = v;
  }
  // linked_assessment_id 单独处理 — null 是合法值(对齐 RaaS 真实发送形态),
  // 上面的 if (v !== null) 过滤会吞掉,所以这里显式透传 null.
  if ("linked_assessment_id" in body) {
    payload.linked_assessment_id = body.linked_assessment_id ?? null;
  }
  // 兜底:既无 resume_text 也无 robohire_resume_id 也无 resume_id 时,
  // 注入一个 stub resume_text — 否则 backfill 会失败 + emit _FAILED
  // BACKFILL_FAILED,虽然链路通了但 happy path 跑不出来,烟测意义打折。
  if (
    !payload.resume_text &&
    !payload.robohire_resume_id &&
    !payload.resume_id
  ) {
    payload.resume_text =
      "[stub] /api/test/trigger-interview-invite 自动注入的简历文本 — 仅用于本地烟测。" +
      "真实联调请在 body 里塞 resume_text 或 resume_id 或 robohire_resume_id。";
  }
  // 同理兜底 JD
  if (
    !payload.jd_text &&
    !payload.robohire_job_id
  ) {
    // 注:job_requisition_id 已在 payload 里,backfill 会尝试查 partner-pg;
    // 若 partner-pg 没这个 JR 行则 backfill 会失败。 这里直接给 stub jd_text
    // 跳过 backfill,确保烟测可见 RoboHire 那一跳(然后失败在 API key)。
    payload.jd_text =
      "[stub] 测试岗位 / 深圳 / Java + Spring。真实联调请塞 jd_text 或 robohire_job_id。";
  }

  const envelope = {
    entity_type: "Candidate",
    entity_id: candidateId,
    event_id: randomUUID(),
    payload,
    trace: {
      trace_id: traceId,
      request_id: null,
      workflow_id: null,
      parent_trace_id: null,
    },
  };

  try {
    const { em } = await import("@/server/em");
    const result = await em.publish("INTERVIEW_INVITATION_REQUESTED", envelope, {
      source: "manual.test-trigger",
      externalEventId: envelope.event_id,
    });
    if (result.accepted) {
      return NextResponse.json({
        ok: true,
        sent: { name: "INTERVIEW_INVITATION_REQUESTED", data: envelope },
        em_event_id: result.eventId,
        schema_version: result.schemaVersionUsed,
        hint: {
          events_ui: "http://localhost:3002/events",
          inngest_runs: `http://localhost:8288/runs?app=agentic-operator-main&fn=agentic-operator-main-interview-inviter-agent`,
          neo4j_interview_record: `http://localhost:3500/instances/Interview_Record/ivr_${candidateId}_${jrId}_inv`,
          file_log_dir: "~/.claude_logs/agents/interviewInviter/",
        },
      });
    } else {
      return NextResponse.json(
        {
          ok: false,
          error: "EM_REJECTED",
          reason: result.reason,
          details: result.details,
          sent: { name: "INTERVIEW_INVITATION_REQUESTED", data: envelope },
        },
        { status: 422 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: "INTERNAL",
        message: (e as Error).message,
        hint: "Make sure Inngest dev is reachable on INNGEST_BASE_URL",
      },
      { status: 500 },
    );
  }
}
