// Energy rule-check orchestration: 筛查 → 二次验证 → 规则判断 → 落审计。
//
// FOUR per-step rule-check agents share this file (and the same engine + store),
// proving the principle is uniform across agents/steps — each pipeline step that
// has rules gets its OWN rule-check agent (classify, not one mega-agent):
//   forecastOutput      → 出力预测
//   generateSuggestion  → 调度建议生成
//   validateConstraints → 约束校验 (CR-* 五组)
//   triageScheme        → 分流与人工确认 (5 直通条件)
// Each returns its evals + a selection verification + the expected-rule count,
// and persists one OntologyRuleCheck row (+ per-rule evals) so the /rule-check
// 总览 + 审计面板 show distinct, per-stage energy records.

import { persistOntologyRuleCheckAudit } from "@/lib/rule-check/ontology-audit-writer";
import { fetchDomainOntology } from "@/lib/ontology-generator/ontology-source";
import { normalizeOntologyRule } from "@/lib/rule-check/normalize-ontology-rule";
import {
  toEngineRules,
  selectRules,
  verifySelection,
  verifyCoverage,
  hasRedlineHit,
  hasBlockingFailure,
  HARD_REDLINES,
  type EngineRule,
  type RuleEval,
  type SelectionVerification,
} from "@/lib/rule-check/engine";
import { ENERGY_DOMAIN_ID } from "@/lib/domain-ids";
import { judgeConstraints, judgeRouting, judgeForecast, judgeSuggestion, type RoutingContext, type RoutingDecision } from "./evaluators";
import type { ScenarioData } from "../sim-data";

// 'snapshot' = the AO-shipped curated in-repo ontology — authoritative for the
// energy domain, NOT a degradation (Allmeta's online copy of a new domain is
// often empty by design). Kept distinct from recruitment's degraded
// 'json-fallback' so the UI can frame it honestly.
export type RuleSource = "ontology-api" | "json-fallback" | "snapshot";

export type EnergyRuleSet = { rules: EngineRule[]; source: RuleSource; total: number };

/** Fetch + normalize + parse the domain's full rule set (Allmeta live → snapshot). */
export async function fetchEnergyEngineRules(): Promise<EnergyRuleSet> {
  const onto = await fetchDomainOntology(ENERGY_DOMAIN_ID);
  const rules = toEngineRules(onto.rules.map((r) => normalizeOntologyRule(r as Record<string, unknown>)));
  return { rules, source: onto.source === "allmeta" ? "ontology-api" : "snapshot", total: rules.length };
}

export type ConstraintCheck = {
  stage: string;
  selected: EngineRule[];
  verification: SelectionVerification;
  evals: RuleEval[];
  redlineFlag: boolean;
  rulesExpected: number;
  decision: "VALIDATED" | "VIOLATED";
};

/** validateConstraints rule-check: CR-* 约束,PIPE-01 顺序数值判断。 */
export function runConstraintCheck(all: EngineRule[], d: ScenarioData): ConstraintCheck {
  const selected = selectRules(all, { stage: "约束校验", codePrefixes: ["CR-"] });
  const verification = verifySelection(selected, HARD_REDLINES as unknown as string[]);
  const evals = judgeConstraints(selected, d);
  const redlineFlag = hasRedlineHit(evals);
  return { stage: "约束校验", selected, verification, evals, redlineFlag, rulesExpected: HARD_REDLINES.length, decision: redlineFlag ? "VIOLATED" : "VALIDATED" };
}

const ROUTING_REQUIRED = [
  { name: "关口偏差", re: /关口偏差/ },
  { name: "高等级风险", re: /高等级风险|风险转人工/ },
  { name: "低置信", re: /低置信/ },
  { name: "硬约束红线", re: /硬约束红线/ },
  { name: "需裁量", re: /裁量/ },
];

export type RoutingCheck = {
  stage: string;
  selected: EngineRule[];
  verification: SelectionVerification;
  rulesExpected: number;
  decision: RoutingDecision;
};

/** triageScheme rule-check: 5 直通条件(分流与人工确认 step)。 */
export function runRoutingCheck(all: EngineRule[], ctx: RoutingContext): RoutingCheck {
  const selected = selectRules(all, { stage: "分流与人工确认", namePattern: /直通|转人工/ });
  const verification = verifyCoverage(selected, ROUTING_REQUIRED);
  const decision = judgeRouting(selected, ctx);
  return { stage: "分流与人工确认", selected, verification, rulesExpected: ROUTING_REQUIRED.length, decision };
}

// ── forecastOutput (出力预测) + generateSuggestion (调度建议生成) ──────────────
const FORECAST_REQUIRED = [
  { name: "置信区间/P50", re: /置信区间|P50|预测出力/ },
  { name: "模型版本", re: /版本|模型/ },
];
const SUGGEST_REQUIRED = [
  { name: "关口对齐GZL", re: /关口|GZL/ },
  { name: "目标优先级", re: /优先级|目标/ },
];

export type StageCheck = {
  stage: string;
  selected: EngineRule[];
  verification: SelectionVerification;
  evals: RuleEval[];
  rulesExpected: number;
  decision: "VALIDATED" | "VIOLATED";
};

/** forecastOutput rule-check: 出力预测 QC(P50/P90、各站≤装机、置信度)。 */
export function runForecastCheck(all: EngineRule[], d: ScenarioData): StageCheck {
  const selected = selectRules(all, { stage: "出力预测" });
  const verification = verifyCoverage(selected, FORECAST_REQUIRED);
  const evals = judgeForecast(selected, d);
  const bad = hasBlockingFailure(evals);
  return { stage: "出力预测", selected, verification, evals, rulesExpected: FORECAST_REQUIRED.length, decision: bad ? "VIOLATED" : "VALIDATED" };
}

/** generateSuggestion rule-check: 调度建议生成 QC(关口对齐 GZL、目标优先级、消纳)。 */
export function runSuggestionCheck(all: EngineRule[], d: ScenarioData): StageCheck {
  const selected = selectRules(all, { stage: "调度建议生成" });
  const verification = verifyCoverage(selected, SUGGEST_REQUIRED);
  const evals = judgeSuggestion(selected, d);
  const bad = hasBlockingFailure(evals);
  return { stage: "调度建议生成", selected, verification, evals, rulesExpected: SUGGEST_REQUIRED.length, decision: bad ? "VIOLATED" : "VALIDATED" };
}

// ── persistence (mandatory; Inngest retries before downstream can advance) ──
export type PersistArgs = {
  agentSlug: string;
  agentName: string;
  stage: string;
  caseId: string;
  runId: string;
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

export async function persistRuleCheck(a: PersistArgs): Promise<string> {
  return persistOntologyRuleCheckAudit({
    domain: ENERGY_DOMAIN_ID,
    agentSlug: a.agentSlug,
    agentName: a.agentName,
    stage: a.stage,
    caseId: a.caseId,
    runId: a.runId,
    dsNo: a.dsNo ?? null,
    decision: a.decision,
    redlineFlag: a.redlineFlag,
    rulesTotal: a.rulesTotal,
    rulesSelected: a.selected.length,
    rulesExpected: a.rulesExpected,
    selectionOk: a.verification.ok,
    selectionNote: JSON.stringify({
      missing: a.verification.missing,
      extra: a.verification.extra,
      parseIssues: a.verification.parseIssues,
    }),
    rulesEvaluated: a.evals.length,
    ruleSource: a.ruleSource,
    evals: a.evals.map((e) => ({
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
  });
}
