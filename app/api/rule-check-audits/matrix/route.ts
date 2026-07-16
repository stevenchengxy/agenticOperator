// GET /api/rule-check-audits/matrix — Prisma 版
//
// NOTE (2026-06): the in-app 规则检查 · 总览 no longer fetches this — it was
// rebuilt around /api/rule-check-audits/rule-health. This endpoint is retained
// (no in-repo consumer; possible external/curl use). Don't let a dead-code
// sweep (knip) flag the live route entry point as removable without checking.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { extractRawFlagsByRuleId } from '@/app/api/rule-check-audits/[auditId]/route';
import { isRuleCheckDomain } from '@/lib/rule-check/domain-scope';
import { hasOntologyRuleChecks, ontologyMatrix } from '@/lib/rule-check/ontology-audit-source';

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
  window_days: number | null;
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
  const all = windowParam?.toLowerCase() === 'all' || daysParam?.toLowerCase() === 'all';
  const fromWindow = windowParam?.match(/^(\d+)d$/)?.[1];
  const raw = parseInt(daysParam ?? fromWindow ?? '30', 10);
  const days = all ? null : Math.max(1, Math.min(36500, Number.isFinite(raw) ? raw : 30));
  const cutoff = days == null ? null : new Date(Date.now() - days * 86_400_000);

  // Non-recruitment domains: serve from the generic ontology rule-check store.
  const domain = searchParams.get('domain');
  if (!isRuleCheckDomain(domain)) {
    if (await hasOntologyRuleChecks(domain)) {
      const m = await ontologyMatrix(domain!.trim(), days);
      return NextResponse.json<RuleMatrixResponse>({ rules: m.rules, total_audits: m.total_audits, window_days: days, meta: { generated_at: new Date().toISOString() } });
    }
    return NextResponse.json<RuleMatrixResponse>({
      rules: [],
      total_audits: 0,
      window_days: days,
      meta: { generated_at: new Date().toISOString() },
    });
  }

  try {
    const totalAudits = await prisma.ruleCheckAudit.count({
      where: cutoff ? { created_at: { gte: cutoff } } : {},
    });

    // Read flags the SAME way the audit detail does, so 总览 == 审计:prefer
    // persisted RuleCheckFlag rows; for audits whose flags weren't persisted
    // (legacy), recover them from llm_raw_text. Keeps coverage accurate even
    // before the write-side persistence fills the table for old audits.
    const auditRows = await prisma.ruleCheckAudit.findMany({
      where: cutoff ? { created_at: { gte: cutoff } } : {},
      select: {
        audit_id: true,
        llm_raw_text: true,
        flags: {
          select: {
            rule_id: true,
            rule_name_snapshot: true,
            severity: true,
            applicable_client: true,
            result: true,
            evidence: true,
          },
        },
      },
    });

    type FlagLite = {
      rule_id: string;
      rule_name: string;
      severity: string;
      applicable_client: string;
      result: string;
      evidence: string;
      audit_id: string;
    };
    const flags: FlagLite[] = [];
    for (const a of auditRows) {
      if (a.flags.length > 0) {
        for (const f of a.flags) {
          flags.push({
            rule_id: f.rule_id,
            rule_name: f.rule_name_snapshot,
            severity: f.severity,
            applicable_client: f.applicable_client ?? '',
            result: f.result,
            evidence: f.evidence ?? '',
            audit_id: a.audit_id,
          });
        }
      } else {
        for (const rf of extractRawFlagsByRuleId(a.llm_raw_text).values()) {
          flags.push({
            rule_id: rf.rule_id,
            rule_name: rf.rule_name ?? '',
            severity: typeof rf.severity === 'string' ? rf.severity : '',
            applicable_client: '',
            result: typeof rf.result === 'string' ? rf.result : 'NOT_APPLICABLE',
            evidence: rf.evidence ?? '',
            audit_id: a.audit_id,
          });
        }
      }
    }

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
          rule_name: f.rule_name,
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
