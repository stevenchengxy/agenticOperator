// GET /api/rule-check-audits/rule-health?window=30d|7d|90d|all&domain=<id>
//
// The single payload behind the redesigned 规则检查 · 总览 (rule-centric).
// One window-aware fetch → no more grid/KPI window disagreement. Returns:
//   - per-rule health (evaluated / passed / failed / label) — binary outcome,
//     "失败" = rule actually rejected a candidate (from failure_reasons)
//   - the Dead-rule list (ontology rules that never fired)
//   - the infra-parked 校验 list (LLM 没钱/故障 — candidate NOT rejected),
//     surfaced separately because parked runs carry no per-rule judgment
//
// Recruitment reads the ontology rule set + RuleCheckAudit/Flag. Other Allmeta
// domains fall back to the generic ontology rule-check store (deterministic
// validateConstraints …) mapped into the same shape; those have no LLM-funds
// parking, so infra_parked is empty there.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { extractRawFlagsByRuleId } from '@/app/api/rule-check-audits/[auditId]/route';
import { fetchDomainOntology } from '@/lib/ontology-generator/ontology-source';
import { normalizeOntologyRule } from '@/lib/rule-check/normalize-ontology-rule';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import { isRuleCheckDomain } from '@/lib/rule-check/domain-scope';
import { hasOntologyRuleChecks, ontologyMatrix } from '@/lib/rule-check/ontology-audit-source';
import { isInfraFailure } from '@/lib/rule-check/infra-failure';
import {
  aggregateRuleHealth,
  classifyRuleHealth,
  type AuditOutcome,
  type RuleHealthRow,
  type RuleHealthTotals,
  type RuleMeta,
} from '@/lib/rule-check/rule-health';

export const dynamic = 'force-dynamic';

export type InfraParkedEntry = {
  audit_id: string;
  candidate_name: string | null;
  jr_title: string | null;
  client_name: string | null;
  /** Raw infra reason token (llm-call-error …) — drives styling. */
  fail_reason: string;
  /** Plain-language reason stored at park time (没钱/故障). */
  reason_label: string;
  created_at: string;
};

export type RuleHealthResponse = {
  ok: boolean;
  window: '7d' | '30d' | '90d' | 'all';
  rules: RuleHealthRow[];
  dead_rules: Array<{ rule_id: string; name: string }>;
  infra_parked: InfraParkedEntry[];
  totals: RuleHealthTotals & { audits_total: number; infra_parked: number };
  source: 'ontology-api' | 'json-fallback' | 'snapshot' | 'ontology-store' | 'none';
  meta: { generated_at: string; error?: string };
};

const WINDOW_DAYS: Record<string, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };

function parseWindow(sp: URLSearchParams): { key: '7d' | '30d' | '90d' | 'all'; cutoff: Date } {
  const raw = (sp.get('window') ?? '30d').toLowerCase();
  const key = (raw in WINDOW_DAYS ? raw : '30d') as '7d' | '30d' | '90d' | 'all';
  const days = WINDOW_DAYS[key];
  const cutoff = days == null ? new Date(0) : new Date(Date.now() - days * 86_400_000);
  return { key, cutoff };
}

/** Flag results that mean "this rule was actually assessed against the candidate". */
const ASSESSED = new Set(['PASS', 'FAIL', 'INSUFFICIENT_INFO', 'REVIEW', 'PENDING', 'NOT_EXECUTED']);

function parseObj(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
function pluck(o: Record<string, unknown> | null, k: string): string | null {
  const v = o?.[k];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function firstReason(failureReasonsJson: string): string | null {
  try {
    const a = JSON.parse(failureReasonsJson);
    return Array.isArray(a) && typeof a[0] === 'string' ? a[0] : null;
  } catch {
    return null;
  }
}

function empty(window: RuleHealthResponse['window'], source: RuleHealthResponse['source'], error?: string): RuleHealthResponse {
  return {
    ok: !error,
    window,
    rules: [],
    dead_rules: [],
    infra_parked: [],
    totals: { rules_total: 0, rules_fired: 0, rules_dead: 0, blocking_rules: 0, rules_unassessed: 0, audits_total: 0, infra_parked: 0 },
    source,
    meta: { generated_at: new Date().toISOString(), ...(error ? { error } : {}) },
  };
}

/**
 * 取**当前 domain** 的 live 全量规则目录(名/severity/stage),供总览展示 + Dead 库存。
 * 走 fetchDomainOntology(domain) —— 按 AO 当前所在领域抓规则,不再写死招聘。
 * ontology 不可达 → 返回空 catalog(调用方降级)。
 */
async function loadDomainRuleCatalog(
  domain: string,
): Promise<{ ruleMeta: Map<string, RuleMeta>; ontologyIds: string[] }> {
  const ruleMeta = new Map<string, RuleMeta>();
  try {
    const onto = await fetchDomainOntology(domain);
    for (const raw of onto.rules) {
      const rule = normalizeOntologyRule(raw as Record<string, unknown>);
      if (!rule.id) continue;
      const severity =
        rule.enforcementLevel === 'mandatory' && rule.failurePolicy === 'block'
          ? 'terminal'
          : rule.enforcementLevel === 'optional' && rule.failurePolicy === 'warn'
            ? 'flag_only'
            : 'needs_human';
      ruleMeta.set(rule.id, {
        name: rule.businessLogicRuleName || rule.id,
        severity,
        stage: rule.specificScenarioStage || '',
        // 逻辑正文截断到 300 字,够总览搜索「内容」用,又不把 payload 撑爆。
        logic: (rule.standardizedLogicRule || '').slice(0, 300),
      });
    }
  } catch {
    /* ontology 不可达 → 空 catalog,调用方降级 */
  }
  return { ruleMeta, ontologyIds: [...ruleMeta.keys()] };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const { key: window, cutoff } = parseWindow(searchParams);
  const domain = searchParams.get('domain');

  // Non-recruitment domains: map the deterministic ontology rule-check store
  // into the same shape (no LLM-funds parking there → infra_parked empty).
  if (!isRuleCheckDomain(domain)) {
    try {
      if (!(await hasOntologyRuleChecks(domain))) return NextResponse.json(empty(window, 'none'));
      const days = WINDOW_DAYS[window] ?? 36500; // 'all' → effectively unbounded
      const m = await ontologyMatrix(domain!.trim(), days);
      const matrixById = new Map(m.rules.map((r) => [r.rule_id, r]));
      // 取**当前 domain** 的全量目录(带 stage)→ 总览展示该域全阶段、可按阶段筛选。
      // 不提取已不在本体的孤儿;本体不可达时降级为列 matrix 里发过的。
      const { ruleMeta, ontologyIds } = await loadDomainRuleCatalog(domain!.trim());
      const ids = ontologyIds.length > 0 ? ontologyIds : [...matrixById.keys()];
      const rules: RuleHealthRow[] = ids.map((id) => {
        const mr = matrixById.get(id);
        // evaluated = pass + fail(规则实际适用);not-applicable 不算「通过」。
        const evaluated = mr ? mr.pass + mr.fail : 0;
        const failed = mr ? mr.fail : 0;
        const meta = ruleMeta.get(id);
        return {
          rule_id: id,
          name: meta?.name || mr?.rule_name || id,
          severity: meta?.severity || mr?.severity || '',
          stage: meta?.stage || '',
          logic: meta?.logic ?? '',
          evaluated,
          passed: evaluated - failed,
          failed,
          // 非招聘域:该域全部规则都由本域 rule-check 评估 → 都算 in-scope(未发火=dead,非 unassessed)。
          health: classifyRuleHealth(evaluated, failed, true),
        };
      });
      rules.sort((a, b) => b.failed - a.failed || b.evaluated - a.evaluated || a.rule_id.localeCompare(b.rule_id));
      const dead_rules = rules
        .filter((r) => r.health === 'dead')
        .map((r) => ({ rule_id: r.rule_id, name: r.name }));
      return NextResponse.json<RuleHealthResponse>({
        ok: true,
        window,
        rules,
        dead_rules,
        infra_parked: [],
        totals: {
          rules_total: ontologyIds.length > 0 ? ontologyIds.length : rules.length,
          rules_fired: rules.filter((r) => r.evaluated > 0).length,
          rules_dead: rules.filter((r) => r.health === 'dead').length,
          blocking_rules: rules.filter((r) => r.health === 'blocking').length,
          rules_unassessed: 0,
          audits_total: m.total_audits,
          infra_parked: 0,
        },
        source: ontologyIds.length > 0 ? 'ontology-api' : 'ontology-store',
        meta: { generated_at: new Date().toISOString() },
      });
    } catch (e) {
      return NextResponse.json(empty(window, 'none', (e as Error).message.slice(0, 200)));
    }
  }

  // ── Recruitment ──────────────────────────────────────────────────────────
  try {
    // Ontology rule set (names / severity / Dead-rule inventory). Degrade to a
    // flags-only view if the ontology API is unreachable.
    // 全阶段规则清单(名/severity/stage/Dead 库存):取**当前 domain** 的整域全部规则
    // (招聘域默认 招聘-v1)→ 总览展示全阶段、按阶段筛选。ontology 不可达 → 降级 flags-only。
    const ontoDomain = domain && domain.trim() ? domain : RECRUITMENT_DOMAIN_ID;
    const { ruleMeta, ontologyIds } = await loadDomainRuleCatalog(ontoDomain);
    const source: RuleHealthResponse['source'] = ontologyIds.length > 0 ? 'ontology-api' : 'json-fallback';

    const auditRows = await prisma.ruleCheckAudit.findMany({
      where: { created_at: { gte: cutoff } },
      select: {
        audit_id: true,
        decision: true,
        fail_reason: true,
        failure_reasons: true,
        created_at: true,
        client_name: true,
        client_display_name: true,
        llm_raw_text: true,
        parsed_resume_json: true,
        job_requisition_json: true,
        flags: { select: { rule_id: true, result: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    // Build per-audit outcomes for the pure aggregator, recovering assessed
    // rules from llm_raw_text for legacy audits whose flags weren't persisted
    // (same recovery the matrix/detail use, so 总览 == 审计).
    const outcomes: AuditOutcome[] = [];
    const infra_parked: InfraParkedEntry[] = [];
    let auditsReal = 0;

    for (const a of auditRows) {
      if (isInfraFailure(a.fail_reason)) {
        const resume = parseObj(a.parsed_resume_json);
        const jr = parseObj(a.job_requisition_json);
        infra_parked.push({
          audit_id: a.audit_id,
          candidate_name: pluck(resume, 'name'),
          jr_title: pluck(jr, 'client_job_title'),
          client_name: a.client_display_name || a.client_name || null,
          fail_reason: a.fail_reason ?? '',
          reason_label: firstReason(a.failure_reasons) ?? '',
          created_at: a.created_at.toISOString(),
        });
        continue;
      }
      auditsReal++;
      let assessed: string[];
      if (a.flags.length > 0) {
        assessed = a.flags.filter((f) => ASSESSED.has(f.result)).map((f) => f.rule_id);
      } else {
        assessed = [];
        for (const rf of extractRawFlagsByRuleId(a.llm_raw_text).values()) {
          const res = typeof rf.result === 'string' ? rf.result : '';
          if (ASSESSED.has(res)) assessed.push(rf.rule_id);
        }
      }
      outcomes.push({
        decision: a.decision,
        fail_reason: a.fail_reason,
        failure_reasons: a.failure_reasons,
        assessed_rule_ids: assessed,
      });
    }

    const { rules, dead_rules, totals } = aggregateRuleHealth(outcomes, ruleMeta, ontologyIds);

    return NextResponse.json<RuleHealthResponse>({
      ok: true,
      window,
      rules,
      dead_rules,
      infra_parked,
      totals: { ...totals, audits_total: auditsReal, infra_parked: infra_parked.length },
      source,
      meta: { generated_at: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json(empty(window, 'none', (e as Error).message.slice(0, 200)));
  }
}
