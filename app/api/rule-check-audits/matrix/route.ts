// GET /api/rule-check-audits/matrix — Prisma 版

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

export type RuleMatrixRow = {
  rule_id: string;
  rule_name: string;
  severity: string;
  applicable_client: string;
  total: number;
  pass: number;
  fail: number;
  not_applicable: number;
  sample_fail_evidence?: string;
  sample_audit_ids: { pass?: string; fail?: string };
};

export type RuleMatrixResponse = {
  rules: RuleMatrixRow[];
  total_audits: number;
  window_days: number;
  meta: { generated_at: string; error?: string };
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  // Accept either ?days=N or ?window=Nd (the dashboard uses the latter for
  // consistency with the stats endpoint). Previously only `days` was read
  // so a "?window=7d" call silently fell through to the 30-day default,
  // causing the matrix to disagree with the dashboard's KPI window.
  const windowParam = searchParams.get('window');
  const daysParam = searchParams.get('days');
  const fromWindow = windowParam?.match(/^(\d+)d$/)?.[1];
  const raw = parseInt(daysParam ?? fromWindow ?? '30', 10);
  const days = Math.max(1, Math.min(90, Number.isFinite(raw) ? raw : 30));
  const cutoff = new Date(Date.now() - days * 86_400_000);

  try {
    const totalAudits = await prisma.ruleCheckAudit.count({
      where: { created_at: { gte: cutoff } },
    });

    // 拉所有最近的 flags + 关联 audit_id
    const flags = await prisma.ruleCheckFlag.findMany({
      where: { audit: { created_at: { gte: cutoff } } },
      select: {
        rule_id: true,
        rule_name_snapshot: true,
        severity: true,
        applicable_client: true,
        result: true,
        evidence: true,
        audit_id: true,
      },
    });

    type Agg = {
      rule_id: string;
      rule_name: string;
      severity: string;
      applicable_client: string;
      total: number;
      pass: number;
      fail: number;
      not_applicable: number;
      sample_fail_evidence?: string;
      sample_audit_ids: { pass?: string; fail?: string };
    };
    const byRule = new Map<string, Agg>();
    for (const f of flags) {
      let r = byRule.get(f.rule_id);
      if (!r) {
        r = {
          rule_id: f.rule_id,
          rule_name: f.rule_name_snapshot,
          severity: f.severity,
          applicable_client: f.applicable_client ?? '',
          total: 0,
          pass: 0,
          fail: 0,
          not_applicable: 0,
          sample_audit_ids: {},
        };
        byRule.set(f.rule_id, r);
      }
      r.total++;
      if (f.result === 'PASS') {
        r.pass++;
        if (!r.sample_audit_ids.pass) r.sample_audit_ids.pass = f.audit_id;
      } else if (f.result === 'FAIL') {
        r.fail++;
        if (!r.sample_audit_ids.fail) r.sample_audit_ids.fail = f.audit_id;
        if (!r.sample_fail_evidence && f.evidence) r.sample_fail_evidence = f.evidence;
      } else if (f.result === 'NOT_APPLICABLE') {
        r.not_applicable++;
      }
    }

    return NextResponse.json<RuleMatrixResponse>({
      rules: Array.from(byRule.values()).sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
      total_audits: totalAudits,
      window_days: days,
      meta: { generated_at: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json<RuleMatrixResponse>({
      rules: [],
      total_audits: 0,
      window_days: days,
      meta: { generated_at: new Date().toISOString(), error: (e as Error).message.slice(0, 200) },
    });
  }
}
