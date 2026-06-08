// 费控 rule-check orchestration: 筛查 → 二次验证 → 规则判断 → 落审计。
//
// One rule-check agent (validateExpenseRules) runs all four groups in PIPE-02
// order (票据组 INV → 标准组 STD → 合规组 CMP → 预算组 BUD), then synthesizes
// (PIPE-04 取最重 + 累加): a risk-raiser FAIL → VIOLATED (→ ANOMALY_DETECTED);
// otherwise VALIDATED with the累加 deduction (→ VALIDATION_COMPLETED). Persists
// one OntologyRuleCheck row (+ per-rule evals) under domain 费控-v1 so the
// /rule-check 总览 + 审计面板 show 费控 records alongside energy + recruitment.

import { prisma } from "@/server/db";
import { fetchDomainOntology, hasSnapshot, loadSnapshotOntology } from "@/lib/ontology-generator/ontology-source";
import {
  selectRules,
  verifySelection,
  hasRedlineHit,
  type EngineRule,
  type RuleEval,
  type SelectionVerification,
} from "@/lib/rule-check/engine";
import type { Rule } from "@/lib/rule-check/types";
import { COST_CONTROL_DOMAIN_ID } from "@/lib/domain-ids";
import { feikongRulesToEngine, judgeFeikongRules, type FeikongEval } from "./evaluators";
import type { FeikongScenarioData } from "../sim-data";

export type RuleSource = "ontology-api" | "json-fallback" | "snapshot";
export type FeikongRuleSet = { rules: EngineRule[]; source: RuleSource; total: number };

/** Fetch + parse the 费控 rule set. The runnable pack is snapshot-driven (the
 *  deterministic judge keys on the snapshot's RULE-INV/STD/CMP/BUD-* codes +
 *  thresholds), so prefer the in-repo snapshot — its rules carry the proper Rule
 *  shape (Allmeta's live node shape uses uid/rule_id and would need normalizing).
 *  Falls back to the live read only when no snapshot ships. */
export async function fetchFeikongEngineRules(): Promise<FeikongRuleSet> {
  if (hasSnapshot(COST_CONTROL_DOMAIN_ID)) {
    const onto = loadSnapshotOntology(COST_CONTROL_DOMAIN_ID);
    const rules = feikongRulesToEngine(onto.rules as unknown as Rule[]);
    return { rules, source: "snapshot", total: rules.length };
  }
  const onto = await fetchDomainOntology(COST_CONTROL_DOMAIN_ID);
  const rules = feikongRulesToEngine(onto.rules as unknown as Rule[]);
  return { rules, source: onto.source === "allmeta" ? "ontology-api" : "snapshot", total: rules.length };
}

// 二次验证基线:必抓到的硬阻断 + 升风险规则(抓不全 = 事故,HALT 不判)。
const EXPENSE_BASELINE = [
  "RULE-INV-01",
  "RULE-INV-03",
  "RULE-INV-08",
  "RULE-STD-01",
  "RULE-CMP-01",
  "RULE-CMP-06",
  "RULE-BUD-02",
];

export type ExpenseCheck = {
  stage: string;
  selected: EngineRule[];
  verification: SelectionVerification;
  evals: FeikongEval[];
  redlineFlag: boolean;
  rulesExpected: number;
  decision: "VALIDATED" | "VIOLATED";
  deductionTotal: number;
  payableAfterDeduction: number;
  risk: { riskType: string; riskLevel: string; hitRule: string; evidence: string } | null;
};

/** validateExpenseRules rule-check: 四组规则 PIPE-02 顺序数值判断。 */
export function runExpenseRuleCheck(all: EngineRule[], d: FeikongScenarioData): ExpenseCheck {
  const selected = selectRules(all, { codePrefixes: ["RULE-INV-", "RULE-STD-", "RULE-CMP-", "RULE-BUD-"] });
  const verification = verifySelection(selected, EXPENSE_BASELINE);
  const evals = judgeFeikongRules(selected, d);

  const deductionTotal = Math.round(evals.reduce((a, e) => a + (e.deduction ?? 0), 0) * 100) / 100;
  const payableAfterDeduction = Math.round((d.totalAmount - deductionTotal) * 100) / 100;
  const riskEval = evals.find((e) => e.result === "FAIL" && e.riskType);
  const redlineFlag = hasRedlineHit(evals);
  const decision: "VALIDATED" | "VIOLATED" = riskEval ? "VIOLATED" : "VALIDATED";

  return {
    stage: "规则校验",
    selected,
    verification,
    evals,
    redlineFlag,
    rulesExpected: EXPENSE_BASELINE.length,
    decision,
    deductionTotal,
    payableAfterDeduction,
    risk: riskEval
      ? { riskType: String(riskEval.riskType), riskLevel: String(riskEval.riskLevel), hitRule: riskEval.code, evidence: riskEval.evidence ?? "" }
      : null,
  };
}

// ── persistence (soft-fail; never blocks the chain) ─────────────────────────
export type PersistArgs = {
  agentSlug: string;
  agentName: string;
  stage: string;
  caseId: string;
  dsNo?: string;
  decision: string;
  redlineFlag: boolean;
  rulesTotal: number;
  rulesExpected: number;
  selected: EngineRule[];
  verification: SelectionVerification;
  evals: RuleEval[];
  ruleSource: string;
};

export async function persistRuleCheck(a: PersistArgs): Promise<string | null> {
  try {
    const row = await prisma.ontologyRuleCheck.create({
      data: {
        domain: COST_CONTROL_DOMAIN_ID,
        agentSlug: a.agentSlug,
        agentName: a.agentName,
        stage: a.stage,
        caseId: a.caseId,
        runId: a.caseId,
        dsNo: a.dsNo ?? null,
        decision: a.decision,
        redlineFlag: a.redlineFlag,
        rulesTotal: a.rulesTotal,
        rulesSelected: a.selected.length,
        rulesExpected: a.rulesExpected,
        selectionOk: a.verification.ok,
        selectionNote: JSON.stringify({ missing: a.verification.missing, extra: a.verification.extra, parseIssues: a.verification.parseIssues }),
        rulesEvaluated: a.evals.length,
        ruleSource: a.ruleSource,
        evals: {
          create: a.evals.map((e) => ({
            ruleId: e.code || e.ruleId,
            ruleName: e.name,
            ruleGroup: e.group,
            hardSoft: e.hardSoft,
            result: e.result,
            checkPoint: e.checkPoint ?? null,
            beforeVal: e.beforeVal ?? null,
            afterVal: e.afterVal ?? null,
            defaultAction: e.defaultAction ?? null,
            riskType: e.riskType ?? null,
            riskLevel: e.riskLevel ?? null,
            evidence: e.evidence ?? null,
          })),
        },
      },
      select: { id: true },
    });
    return row.id;
  } catch {
    return null; // store unavailable → chain still proceeds; logs remain
  }
}
