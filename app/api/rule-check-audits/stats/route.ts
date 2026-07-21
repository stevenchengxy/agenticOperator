// GET /api/rule-check-audits/stats — Prisma 版
import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { isRuleCheckDomain } from '@/lib/rule-check/domain-scope';
import { hasOntologyRuleChecks, ontologyStats } from '@/lib/rule-check/ontology-audit-source';
import { isInfraFailure } from '@/lib/rule-check/infra-failure';

export const dynamic = 'force-dynamic';

export type RuleCheckStatsResponse = {
  total: number;
  pass: number;
  fail: number;
  blocked_robohire_calls: number;
  avg_llm_duration_ms: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  estimated_robohire_savings_usd: number;
  by_client: Array<{ client: string; pass: number; fail: number }>;
  top_failure_rules: Array<{ rule_id: string; count: number }>;
  meta: { window_days: number | null; not_configured?: boolean; error?: string; generated_at: string };
};

const ROBOHIRE_USD_PER_MATCH = 0.2;

function parseWindowDays(searchParams: URLSearchParams): number | null {
  // accepts ?days=7, ?window=7d, and ?window=all / ?days=all. `all` is
  // intentionally unbounded so persisted history never disappears from stats.
  const raw = searchParams.get('days') ?? (searchParams.get('window') ?? '').replace(/d$/i, '');
  if (raw.toLowerCase() === 'all') return null;
  return Math.max(1, Math.min(36500, parseInt(raw || '7', 10) || 7));
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = parseWindowDays(searchParams);
  const cutoff = days == null ? null : new Date(Date.now() - days * 86_400_000);

  // Non-recruitment domains: serve from the generic ontology rule-check store
  // (energy validateConstraints / triageScheme …) when it has data.
  const domain = searchParams.get('domain');
  if (!isRuleCheckDomain(domain)) {
    if (await hasOntologyRuleChecks(domain)) {
      return NextResponse.json<RuleCheckStatsResponse>(await ontologyStats(domain!.trim(), days));
    }
    return NextResponse.json<RuleCheckStatsResponse>({
      total: 0,
      pass: 0,
      fail: 0,
      blocked_robohire_calls: 0,
      avg_llm_duration_ms: 0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      estimated_robohire_savings_usd: 0,
      by_client: [],
      top_failure_rules: [],
      meta: { window_days: days, generated_at: new Date().toISOString() },
    });
  }

  try {
    const allAudits = await prisma.ruleCheckAudit.findMany({
      where: cutoff ? { created_at: { gte: cutoff } } : {},
      select: {
        decision: true,
        client_name: true,
        llm_duration_ms: true,
        llm_prompt_tokens: true,
        llm_completion_tokens: true,
        failure_reasons: true,
        fail_reason: true,
      },
    });
    // Exclude infra-parked rows (没钱/故障): they carry decision='FAIL' for
    // display but the candidate was NOT rejected, so they must not count toward
    // 通过/未通过. fail_reason is null for every genuine business decision.
    const audits = allAudits.filter((a) => !isInfraFailure(a.fail_reason));

    let pass = 0;
    let fail = 0;
    let durSum = 0;
    let durN = 0;
    let ptSum = 0;
    let ctSum = 0;
    const byClient = new Map<string, { pass: number; fail: number }>();
    const ruleCount = new Map<string, number>();

    for (const a of audits) {
      if (a.decision === 'PASS') pass++;
      else fail++;
      if (a.llm_duration_ms > 0) {
        durSum += a.llm_duration_ms;
        durN++;
      }
      ptSum += a.llm_prompt_tokens ?? 0;
      ctSum += a.llm_completion_tokens ?? 0;
      const client = a.client_name || '(未知)';
      let cb = byClient.get(client);
      if (!cb) {
        cb = { pass: 0, fail: 0 };
        byClient.set(client, cb);
      }
      if (a.decision === 'PASS') cb.pass++;
      else cb.fail++;

      try {
        const reasons = JSON.parse(a.failure_reasons) as string[];
        if (Array.isArray(reasons)) {
          for (const reason of reasons) {
            const ruleId = reason.split(':')[0];
            if (ruleId) ruleCount.set(ruleId, (ruleCount.get(ruleId) ?? 0) + 1);
          }
        }
      } catch {}
    }

    const resp: RuleCheckStatsResponse = {
      total: audits.length,
      pass,
      fail,
      blocked_robohire_calls: fail,
      avg_llm_duration_ms: durN > 0 ? Math.round(durSum / durN) : 0,
      total_prompt_tokens: ptSum,
      total_completion_tokens: ctSum,
      estimated_robohire_savings_usd:
        Math.round(fail * ROBOHIRE_USD_PER_MATCH * 100) / 100,
      by_client: Array.from(byClient.entries())
        .map(([client, v]) => ({ client, pass: v.pass, fail: v.fail }))
        .sort((a, b) => b.pass + b.fail - (a.pass + a.fail))
        .slice(0, 8),
      top_failure_rules: Array.from(ruleCount.entries())
        .map(([rule_id, count]) => ({ rule_id, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),
      meta: { window_days: days, generated_at: new Date().toISOString() },
    };
    return NextResponse.json(resp);
  } catch (e) {
    return NextResponse.json({
      total: 0,
      pass: 0,
      fail: 0,
      blocked_robohire_calls: 0,
      avg_llm_duration_ms: 0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      estimated_robohire_savings_usd: 0,
      by_client: [],
      top_failure_rules: [],
      meta: { window_days: days, error: (e as Error).message.slice(0, 200), generated_at: new Date().toISOString() },
    } as RuleCheckStatsResponse);
  }
}
