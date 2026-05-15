// GET /api/rule-check-audits — Q架构纠偏后:从 Prisma 读 audit
//
// 旧实现:从 Neo4j MATCH (a:RuleCheckAudit) 查 → 节点重、不支持 SQL 索引
// 新实现:从 Prisma SQLite ruleCheckAudit 表查 → 走索引、有事务、轻量

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

export type RuleCheckAuditRow = {
  audit_id: string;
  created_at: string;
  decision: 'PASS' | 'FAIL';
  llm_decision: string;
  candidate_id: string;
  resume_id: string;
  job_requisition_id: string;
  client_name: string;
  business_group: string | null;
  studio: string | null;
  llm_model: string;
  llm_duration_ms: number;
  llm_prompt_tokens: number | null;
  llm_completion_tokens: number | null;
  rules_evaluated: number;
  rule_source: string;
  n_flags: number;
  trace_id: string | null;
  failure_reasons: string[];
};

export type RuleCheckAuditListResponse = {
  rows: RuleCheckAuditRow[];
  total: number;
  meta: { empty: boolean; not_configured?: boolean; error?: string; generatedAt: string };
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const decision = searchParams.get('decision');
  const client = searchParams.get('client') ?? '';
  const jrId = searchParams.get('jrId') ?? '';
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 200);

  try {
    const where: Record<string, unknown> = {};
    if (decision === 'PASS' || decision === 'FAIL') where.decision = decision;
    if (client) where.client_name = client;
    if (jrId) where.job_requisition_id = jrId;

    const audits = await prisma.ruleCheckAudit.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
      include: { _count: { select: { flags: true } } },
    });

    const rows: RuleCheckAuditRow[] = audits.map((a) => ({
      audit_id: a.audit_id,
      created_at: a.created_at.toISOString(),
      decision: a.decision as 'PASS' | 'FAIL',
      llm_decision: a.llm_decision,
      candidate_id: a.candidate_id,
      resume_id: a.resume_id,
      job_requisition_id: a.job_requisition_id,
      client_name: a.client_name ?? '',
      business_group: a.business_group,
      studio: a.studio,
      llm_model: a.llm_model,
      llm_duration_ms: a.llm_duration_ms,
      llm_prompt_tokens: a.llm_prompt_tokens,
      llm_completion_tokens: a.llm_completion_tokens,
      rules_evaluated: a.rules_evaluated,
      rule_source: a.rule_source,
      n_flags: a._count.flags,
      trace_id: a.trace_id,
      failure_reasons: safeJsonArray(a.failure_reasons),
    }));

    return NextResponse.json<RuleCheckAuditListResponse>({
      rows,
      total: rows.length,
      meta: { empty: rows.length === 0, generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json<RuleCheckAuditListResponse>({
      rows: [],
      total: 0,
      meta: {
        empty: true,
        error: (e as Error).message.slice(0, 200),
        generatedAt: new Date().toISOString(),
      },
    });
  }
}

function safeJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
