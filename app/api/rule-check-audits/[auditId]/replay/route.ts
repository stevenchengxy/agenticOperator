// POST /api/rule-check-audits/[auditId]/replay — Prisma 版
//
// 从 Prisma 拉 audit + parsed_resume_json,重新构造 RESUME_PROCESSED 事件触发 matchResumeAgent。

import { NextResponse } from 'next/server';
import { inngest } from '@/server/inngest/client';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

export type ReplayResponse =
  | { ok: true; new_event_id: string; source_audit_id: string }
  | { ok: false; error: string; reason: 'not_found' | 'incomplete' | 'send_failed' };

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ auditId: string }> },
) {
  const { auditId } = await ctx.params;

  try {
    const audit = await prisma.ruleCheckAudit.findUnique({ where: { audit_id: auditId } });
    if (!audit) {
      return NextResponse.json<ReplayResponse>({
        ok: false,
        error: `audit ${auditId} not found`,
        reason: 'not_found',
      });
    }
    if (!audit.parsed_resume_json) {
      return NextResponse.json<ReplayResponse>({
        ok: false,
        error: 'audit 没有 parsed_resume_json,无法 replay。这条 audit 可能是 Q1 之前写的。',
        reason: 'incomplete',
      });
    }

    let parsedData: Record<string, unknown> = {};
    try {
      parsedData = JSON.parse(audit.parsed_resume_json);
    } catch {
      return NextResponse.json<ReplayResponse>({
        ok: false,
        error: 'parsed_resume_json 解析失败',
        reason: 'incomplete',
      });
    }

    const eventData: Record<string, unknown> = {
      upload_id: audit.upload_id,
      candidate_id: audit.candidate_id,
      resume_id: audit.resume_id,
      employee_id: process.env.RAAS_DEFAULT_EMPLOYEE_ID ?? '0000199059',
      job_requisition_id: audit.job_requisition_id,
      parsed: { data: parsedData },
      source_channel: 'ao_rule_check_replay',
      replay_meta: {
        parent_audit_id: auditId,
        parent_trace_id: audit.trace_id,
        replayed_at: new Date().toISOString(),
      },
      bucket: '',
      objectKey: '',
      filename: '',
      hrFolder: null,
      etag: null,
      size: null,
      sourceEventName: null,
      receivedAt: new Date().toISOString(),
      candidate: {},
      candidate_expectation: {},
      resume: {},
      runtime: {},
      parsedAt: new Date().toISOString(),
      parserVersion: 'replay@2026-05-12',
    };

    try {
      const sent = await inngest.send({
        name: 'RESUME_PROCESSED',
        data: eventData as never,
      });
      const newIds = (sent as { ids: string[] }).ids ?? [];
      return NextResponse.json<ReplayResponse>({
        ok: true,
        new_event_id: newIds[0] ?? '<no id>',
        source_audit_id: auditId,
      });
    } catch (e) {
      return NextResponse.json<ReplayResponse>({
        ok: false,
        error: `Inngest send failed: ${(e as Error).message.slice(0, 200)}`,
        reason: 'send_failed',
      });
    }
  } catch (e) {
    return NextResponse.json<ReplayResponse>({
      ok: false,
      error: (e as Error).message.slice(0, 300),
      reason: 'send_failed',
    });
  }
}
