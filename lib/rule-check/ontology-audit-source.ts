// Serve the /rule-check 总览 + 审计面板 for non-recruitment domains from the
// generic OntologyRuleCheck store (energy validateConstraints / triageScheme and
// future domains/steps). Maps each rule-check run → the recruitment-shaped
// stats/list/matrix/detail responses the dashboard already renders, so the same
// UI shows energy records when the energy 业务领域 is active.
//
// Repurposed columns for the energy view: client_name → 校验步骤(stage),
// business_group → 业务领域, job_requisition_id → 案件 DS号.

import { prisma } from "@/server/db";
import { friendlyDomainName, RECRUITMENT_DOMAIN_ID } from "@/lib/domain-ids";
import type { RuleCheckAuditDetail } from "@/app/api/rule-check-audits/[auditId]/route";

function isOntologyAuditDomain(domain: string | null | undefined): boolean {
  const d = (domain ?? "").trim();
  return d !== "" && d !== RECRUITMENT_DOMAIN_ID && d !== "RAAS-v1" && d !== "raas";
}

/** True when this domain has any recorded ontology rule-check runs. */
export async function hasOntologyRuleChecks(domain: string | null | undefined): Promise<boolean> {
  if (!isOntologyAuditDomain(domain)) return false;
  try {
    const n = await prisma.ontologyRuleCheck.count({ where: { domain: domain!.trim() } });
    return n > 0;
  } catch {
    return false;
  }
}

const passOf = (decision: string, redline: boolean, selectionOk: boolean): "PASS" | "FAIL" =>
  !redline && selectionOk && (decision === "VALIDATED" || decision === "AUTO") ? "PASS" : "FAIL";

export async function ontologyStats(domain: string, days: number) {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.ontologyRuleCheck.findMany({
    where: { domain, createdAt: { gte: cutoff } },
    select: { decision: true, redlineFlag: true, selectionOk: true, stage: true, evals: { where: { result: "FAIL" }, select: { ruleId: true } } },
  });
  let pass = 0;
  let fail = 0;
  const byStage = new Map<string, { pass: number; fail: number }>();
  const failByRule = new Map<string, number>();
  for (const r of rows) {
    const p = passOf(r.decision, r.redlineFlag, r.selectionOk);
    if (p === "PASS") pass++;
    else fail++;
    const s = byStage.get(r.stage) ?? { pass: 0, fail: 0 };
    s[p === "PASS" ? "pass" : "fail"]++;
    byStage.set(r.stage, s);
    for (const e of r.evals) failByRule.set(e.ruleId, (failByRule.get(e.ruleId) ?? 0) + 1);
  }
  return {
    total: rows.length,
    pass,
    fail,
    blocked_robohire_calls: 0,
    avg_llm_duration_ms: 0,
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    estimated_robohire_savings_usd: 0,
    by_client: Array.from(byStage.entries()).map(([client, v]) => ({ client, pass: v.pass, fail: v.fail })),
    top_failure_rules: Array.from(failByRule.entries()).map(([rule_id, count]) => ({ rule_id, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    meta: { window_days: days, generated_at: new Date().toISOString() },
  };
}

export async function ontologyAuditList(domain: string, limit: number) {
  const rows = await prisma.ontologyRuleCheck.findMany({
    where: { domain },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true, createdAt: true, decision: true, redlineFlag: true, selectionOk: true, stage: true,
      caseId: true, dsNo: true, agentName: true, rulesEvaluated: true, ruleSource: true,
      evals: { where: { result: "FAIL" }, select: { ruleId: true, ruleName: true } },
    },
  });
  const friendly = friendlyDomainName(domain);
  return rows.map((r) => ({
    audit_id: r.id,
    created_at: r.createdAt.toISOString(),
    decision: passOf(r.decision, r.redlineFlag, r.selectionOk),
    llm_decision: r.decision,
    candidate_id: r.dsNo ?? r.caseId,
    resume_id: r.caseId,
    job_requisition_id: r.dsNo ?? r.caseId,
    client_name: r.stage,
    business_group: friendly,
    studio: null,
    candidate_name: r.dsNo ?? null,
    jr_title: r.stage,
    dept_label: r.agentName,
    llm_model: "(确定性规则引擎)",
    llm_duration_ms: 0,
    llm_prompt_tokens: null,
    llm_completion_tokens: null,
    rules_evaluated: r.rulesEvaluated,
    rule_source: r.ruleSource,
    n_flags: r.evals.length,
    trace_id: r.caseId,
    failure_reasons: r.evals.map((e) => `${e.ruleId} ${e.ruleName}`),
  }));
}

export async function ontologyMatrix(domain: string, days: number) {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const checks = await prisma.ontologyRuleCheck.findMany({
    where: { domain, createdAt: { gte: cutoff } },
    select: { id: true, evals: { select: { ruleId: true, ruleName: true, result: true, evidence: true, hardSoft: true, ruleGroup: true } } },
  });
  type Row = { rule_id: string; rule_name: string; severity: string; applicable_client: string; total: number; pass: number; fail: number; not_applicable: number; sample_fail_evidence?: string; sample_audit_ids: { pass?: string; fail?: string } };
  const byRule = new Map<string, Row>();
  for (const c of checks) {
    for (const e of c.evals) {
      const m: Row = byRule.get(e.ruleId) ?? { rule_id: e.ruleId, rule_name: e.ruleName, severity: e.hardSoft === "hard" ? "terminal" : "flag_only", applicable_client: e.ruleGroup, total: 0, pass: 0, fail: 0, not_applicable: 0, sample_audit_ids: {} };
      m.total++;
      if (e.result === "FAIL") {
        m.fail++;
        if (!m.sample_fail_evidence && e.evidence) m.sample_fail_evidence = e.evidence;
        if (!m.sample_audit_ids.fail) m.sample_audit_ids.fail = c.id;
      } else if (e.result === "NA") m.not_applicable++;
      else {
        m.pass++; // PASS or CLAMPED
        if (!m.sample_audit_ids.pass) m.sample_audit_ids.pass = c.id;
      }
      byRule.set(e.ruleId, m);
    }
  }
  return { rules: Array.from(byRule.values()).sort((a, b) => b.fail - a.fail || a.rule_id.localeCompare(b.rule_id)), total_audits: checks.length };
}

/** 二次验证概要(筛查抓取对不对)— extra field carried alongside the canonical
 *  detail; the UI ignores unknown fields, future tabs can surface it. */
type SelectionInfo = { ok: boolean; selected: number; expected: number; missing?: string[]; extra?: string[]; parseIssues?: string[] };
export type OntologyAuditDetail = RuleCheckAuditDetail & { selection: SelectionInfo };

// Return the FULL canonical RuleCheckAuditDetail shape so the recruitment-built
// detail UI (header/banner + 规则筛选/规则判断/prompt/response/instances tabs)
// renders an energy audit without crashing. Typed as RuleCheckAuditDetail →
// TS forces every field, so a missing iterated array (rule_provenance,
// filtered_out_rules, partial_resume_fields, failure_reasons, child_audit_ids)
// can never slip through again. Energy-specific values where they map; null/[]
// for recruitment-only fields (candidate/resume/jr/LLM I/O).
export async function ontologyAuditDetail(checkId: string): Promise<OntologyAuditDetail | null> {
  const c = await prisma.ontologyRuleCheck.findUnique({
    where: { id: checkId },
    include: { evals: { orderBy: { createdAt: "asc" } } },
  });
  if (!c) return null;
  const selectionNote = (() => {
    try {
      return JSON.parse(c.selectionNote ?? "{}") as Partial<SelectionInfo>;
    } catch {
      return {};
    }
  })();

  return {
    audit_id: c.id,
    // Deterministic numeric rule-check (no LLM) — drives the ontology-aware tabs.
    deterministic: true,
    decision: passOf(c.decision, c.redlineFlag, c.selectionOk),
    llm_decision: c.decision,
    created_at: c.createdAt.toISOString(),
    upload_id: c.caseId,
    candidate_id: c.dsNo ?? c.caseId,
    resume_id: c.caseId,
    job_requisition_id: c.dsNo ?? c.caseId,
    trace_id: c.caseId,
    client_name: c.stage,
    client_display_name: null,
    business_group: friendlyDomainName(c.domain),
    studio: null,
    llm_model: "(确定性规则引擎)",
    llm_duration_ms: 0,
    llm_prompt_tokens: null,
    llm_completion_tokens: null,
    parse_error: null,
    rules_evaluated: c.rulesEvaluated,
    rules_total_in_ontology: c.rulesTotal,
    rule_source: c.ruleSource,
    partial_resume_fields: [],
    failure_reasons: c.evals.filter((e) => e.result === "FAIL").map((e) => `${e.ruleId} ${e.ruleName}`),
    // 能源没有「筛掉的规则」概念(本步骤的规则全部纳入)→ 空,UI 走「全部纳入」分支
    filtered_out_rules: [],
    // 三层抓取证据:能源 CR 规则都是通用(general),tier 用合法字面量,组别放进 reason
    rule_provenance: c.evals.map((e) => ({
      rule_id: e.ruleId,
      tier: "general" as const,
      included: true,
      reason: e.checkPoint ?? e.evidence ?? `${e.ruleGroup} 组规则`,
    })),
    user_prompt: null,
    system_prompt: null,
    llm_raw_text: null,
    resume_augmentation: null,
    parsed_resume_full: null,
    job_requisition_full: null,
    flags: c.evals.map((e) => ({
      flag_id: e.id,
      rule_id: e.ruleId,
      rule_name_snapshot: e.ruleName,
      severity: e.hardSoft === "hard" ? "terminal" : "flag_only",
      applicable: true,
      result: e.result === "PASS" || e.result === "CLAMPED" ? "PASS" : e.result === "NA" ? "NOT_APPLICABLE" : "FAIL",
      evidence: [e.checkPoint, e.beforeVal && `前值 ${e.beforeVal}`, e.afterVal && `后值 ${e.afterVal}`, e.defaultAction, e.riskType && `${e.riskType}/${e.riskLevel}`, e.evidence].filter(Boolean).join(" · "),
      next_action: e.hardSoft === "hard" && e.result === "FAIL" ? "block" : "continue",
    })),
    candidate_snapshot: null,
    resume_snapshot: null,
    jr_snapshot: null,
    parent_audit_id: null,
    child_audit_ids: [],
    // 二次验证概要(extra, non-contract)
    selection: { ok: c.selectionOk, selected: c.rulesSelected, expected: c.rulesExpected, ...selectionNote },
  };
}
