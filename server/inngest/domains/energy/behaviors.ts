// Per-action behaviors for the energy chain.
//
// The generic factory (make-agent.ts) runs every action as an LLM pass-through
// or a simulated-human auto-responder. A few actions need REAL deterministic
// logic instead — the two rule-check steps and the human gates. Those are
// declared here as `EnergyBehavior`s; the factory looks each action up by name
// and, when a behavior exists, calls `compute()` instead of the LLM and honors
// any `gate` it returns (notify + waitForEvent + route-by-decision).
//
//   validateConstraints  rule-check → CONSTRAINT_VALIDATED{redlineFlag,violations}
//   triageScheme         rule-check → ROUTING_DECIDED{route,failedConditions}
//   manualConfirm        gate when route=manual / auto-pass / skip on risk-first
//   raiseRiskEvent       deterministic RK from the red-line violation
//   handleFloodControl   gate (T3 防洪) — the 风险处置 human闸口
//   resolveRiskAndResume auto-resume → RISK_DISPOSED
//   finalizePlan         gate when versionMismatch (封口三问) else auto-lock DP

import type { ScenarioData } from "./sim-data";
import { evidenceLine } from "./sim-data";
import {
  fetchEnergyEngineRules,
  runConstraintCheck,
  runRoutingCheck,
  runForecastCheck,
  runSuggestionCheck,
  persistRuleCheck,
} from "./rule-check/run-rule-check";
import type { Behavior } from "@/server/inngest/agent-factory/types";

// The gate/result/decision types are shared across runnable domains.
export type { HumanDecision, GateRoute, GateRequest, ComputeResult, ComputeCtx } from "@/server/inngest/agent-factory/types";

/** An energy behavior is the shared Behavior contract bound to the energy
 *  scenario dataset, so ctx.dataset is typed ScenarioData. */
export type EnergyBehavior = Behavior<ScenarioData>;

const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);
const bool = (v: unknown): boolean => v === true;

// ── validateConstraints — CR-* 约束规则校验 ──────────────────────────────────
const validateConstraints: EnergyBehavior = {
  retries: 3,
  async compute(ctx) {
    const d = ctx.dataset;
    if (!d) return { skip: true, skipReason: "no-dataset" };
    const ruleset = await ctx.step.run("fetch-rules", () => fetchEnergyEngineRules());
    const chk = runConstraintCheck(ruleset.rules, d);

    ctx.logger.event("rules_selected", { stage: chk.stage, total: ruleset.total, selected: chk.selected.length, codes: chk.selected.map((r) => r.code) });
    ctx.logger.event("selection_verified", { ok: chk.verification.ok, missing: chk.verification.missing, note: "二次验证:四条硬红线是否全部抓到 + 解析完整" });
    for (const e of chk.evals.filter((x) => x.result !== "PASS")) {
      ctx.logger.event("rule_judged", { code: e.code, group: e.group, result: e.result, checkPoint: e.checkPoint, before: e.beforeVal, after: e.afterVal, risk: e.riskType ? `${e.riskType}/${e.riskLevel}` : undefined });
    }
    const violations = chk.evals.filter((e) => e.hardSoft === "hard" && e.result === "FAIL").map((e) => ({ code: e.code, name: e.name, riskType: e.riskType, riskLevel: e.riskLevel, before: e.beforeVal, after: e.afterVal }));
    ctx.logger.event("decision", { action: "validateConstraints", decision: chk.decision, redlineFlag: chk.redlineFlag, violations: violations.length });

    await ctx.step.run("persist-rulecheck", () =>
      persistRuleCheck({ agentSlug: "energy-validate-constraints", agentName: "ValidateConstraintsAgent", stage: chk.stage, caseId: ctx.caseId, runId: ctx.runId, dsNo: ctx.dsNo, decision: chk.decision, redlineFlag: chk.redlineFlag, rulesTotal: ruleset.total, rulesExpected: chk.rulesExpected, selected: chk.selected, verification: chk.verification, evals: chk.evals, ruleSource: ruleset.source }),
    );

    return {
      payloadByEvent: {
        CONSTRAINT_VALIDATED: {
          redlineFlag: chk.redlineFlag,
          violations,
          decision: chk.decision,
          rulesEvaluated: chk.evals.length,
          selectionOk: chk.verification.ok,
          evidence: evidenceLine(d),
        },
      },
    };
  },
};

// ── triageScheme — 分流判断(5 直通条件)────────────────────────────────────
const triageScheme: EnergyBehavior = {
  retries: 3,
  async compute(ctx) {
    const d = ctx.dataset;
    if (!d) return { skip: true, skipReason: "no-dataset" };
    const redlineFlag = bool(ctx.upstream.redlineFlag);
    const revised = bool(ctx.upstream.revised);
    // 退回重算后的第二轮:数据已修正 → 置信度抬到合格线之上。
    const confidence = revised ? Math.max(0.93, d.forecastConfidence) : d.forecastConfidence;

    const ruleset = await ctx.step.run("fetch-rules", () => fetchEnergyEngineRules());
    const chk = runRoutingCheck(ruleset.rules, { gzlDeviationPct: d.gzlDeviationPct, forecastConfidence: confidence, schemeDominant: d.schemeDominant, redlineFlag });

    ctx.logger.event("rules_selected", { stage: chk.stage, total: ruleset.total, selected: chk.selected.length, codes: chk.selected.map((r) => r.code) });
    ctx.logger.event("selection_verified", { ok: chk.verification.ok, missing: chk.verification.missing, note: "二次验证:五条直通条件规则是否全部覆盖" });
    ctx.logger.event("decision", { action: "triageScheme", route: chk.decision.route, failedConditions: chk.decision.failedConditions, revised });

    await ctx.step.run("persist-rulecheck", () =>
      persistRuleCheck({ agentSlug: "energy-triage-scheme", agentName: "TriageSchemeAgent", stage: chk.stage, caseId: ctx.caseId, runId: ctx.runId, dsNo: ctx.dsNo, decision: chk.decision.route.toUpperCase(), redlineFlag, rulesTotal: ruleset.total, rulesExpected: chk.rulesExpected, selected: chk.selected, verification: chk.verification, evals: chk.decision.evals, ruleSource: ruleset.source }),
    );

    return { payloadByEvent: { ROUTING_DECIDED: { route: chk.decision.route, failedConditions: chk.decision.failedConditions, confidence, gzlDeviationPct: d.gzlDeviationPct } } };
  },
};

// ── manualConfirm — 人工确认闸口① ───────────────────────────────────────────
const REGEN_CLAIMS = ["generateSuggestion", "validateConstraints", "compareSchemes", "triageScheme", "manualConfirm"];

const manualConfirm: EnergyBehavior = {
  async compute(ctx) {
    const route = String(ctx.upstream.route ?? "auto");
    const failed = (ctx.upstream.failedConditions as string[]) ?? [];
    if (route === "auto") {
      ctx.logger.event("decision", { action: "manualConfirm", auto_adopted: true, note: "五条件全满足,直通自动采纳(不进人工待办)" });
      return { payloadByEvent: { MANUAL_REVIEW_DECIDED: { decision: "adopt", auto: true } } };
    }
    if (route === "risk-first") {
      return { skip: true, skipReason: "risk-first(走风险处置闸口)" };
    }
    // route === "manual" → human gate
    const d = ctx.dataset;
    return {
      gate: {
        gateKey: "manualConfirm",
        category: "agent",
        source: "智调·分流确认",
        title: `人工确认 · 案件 ${ctx.dsNo}（${failed.join("、") || "需复核"}）`,
        body: `案件 ${ctx.dsNo} 未满足直通条件转人工:${failed.join("、")}。${d ? evidenceLine(d) : ""}。请调度员复核后采纳/退回/否决。`,
        anchors: { caseId: ctx.caseId, dsNo: ctx.dsNo, gate: "manualConfirm", failed: failed.join("、") },
        route: (dec) => {
          if (dec.decision === "采纳") return { emitEvents: ["MANUAL_REVIEW_DECIDED"], payload: { decision: "adopt", edits: dec.edits ?? null, reason: dec.reason ?? null, operator: dec.operator ?? null } };
          // 退回 / 否决 → 真重入一轮重算(清 claim,以修正数据重跑到闸口)
          return { emitEvents: ["FORECAST_COMPLETED"], payload: { revised: true, decision: dec.decision === "否决" ? "reject" : "revise", reason: dec.reason ?? null, operator: dec.operator ?? null }, resetClaims: REGEN_CLAIMS };
        },
      },
    };
  },
};

// ── raiseRiskEvent — 立风险事件(确定性,从红线 violation 派生)──────────────
const raiseRiskEvent: EnergyBehavior = {
  async compute(ctx) {
    const violations = (ctx.upstream.violations as Array<Record<string, unknown>>) ?? [];
    const redline = bool(ctx.upstream.redlineFlag) && violations.length > 0;
    if (!redline) return { skip: true, skipReason: "no-redline" };
    const v = violations[0];
    const rkNo = `RK${ctx.dsNo.replace(/\D/g, "").slice(0, 8) || "20260530"}00001`;
    ctx.logger.event("decision", { action: "raiseRiskEvent", rkNo, hitRule: v.code, riskType: v.riskType, riskLevel: v.riskLevel });
    return { payloadByEvent: { RISK_EVENT_RAISED: { rkNo, hitRule: v.code, riskType: v.riskType, riskLevel: v.riskLevel, before: v.before, after: v.after } } };
  },
};

// ── risk handlers — gate only for the matching risk type ─────────────────────
function riskHandler(actionName: string, riskTypes: string[], gateTitle: string, source: string, emitEvent: string): EnergyBehavior {
  return {
    async compute(ctx) {
      const rt = String(ctx.upstream.riskType ?? "");
      if (!riskTypes.includes(rt)) return { skip: true, skipReason: `not-${riskTypes.join("/")}(本案 ${rt || "无"})` };
      const d = ctx.dataset;
      const rkNo = String(ctx.upstream.rkNo ?? "RK?");
      return {
        gate: {
          gateKey: actionName,
          category: "event",
          source,
          title: `${gateTitle} · ${rkNo}（${ctx.upstream.riskLevel}）`,
          body: `命中 ${ctx.upstream.hitRule}（${rt}/${ctx.upstream.riskLevel}）,案件 ${ctx.dsNo} 已 SUSPENDED。${d ? evidenceLine(d) : ""}。值长/总工处置后放行或暂缓。`,
          riskType: rt,
          riskLevel: String(ctx.upstream.riskLevel ?? ""),
          anchors: { caseId: ctx.caseId, dsNo: ctx.dsNo, gate: actionName, rkNo, hitRule: String(ctx.upstream.hitRule ?? "") },
          route: (dec) => {
            if (dec.decision === "放行") return { emitEvents: [emitEvent], payload: { disposed: true, rkNo, reason: dec.reason ?? null, operator: dec.operator ?? null } };
            return { emitEvents: [], payload: { suspended: true, reason: dec.reason ?? null } }; // 暂缓/上报 → 维持 SUSPENDED
          },
        },
      };
    },
  };
}

// ── resolveRiskAndResume — 处置闭环后恢复 ───────────────────────────────────
const resolveRiskAndResume: EnergyBehavior = {
  async compute(ctx) {
    ctx.logger.event("decision", { action: "resolveRiskAndResume", note: "风险已闭环,恢复计划定版", rkNo: ctx.upstream.rkNo });
    return { payloadByEvent: { RISK_DISPOSED: { disposed: true, rkNo: ctx.upstream.rkNo ?? null } } };
  },
};

// ── finalizePlan — 定版封口闸口③(版本不符才进人工)/ 否则自动锁 DP ──────────
const finalizePlan: EnergyBehavior = {
  triggerOverride: ["MANUAL_REVIEW_DECIDED", "RISK_DISPOSED"], // 不在 ROUTING_DECIDED 上抢跑
  async compute(ctx) {
    const decision = String(ctx.upstream.decision ?? "");
    if (decision === "revise" || decision === "reject") return { skip: true, skipReason: "revise/reject 不定版,等重算" };
    const d = ctx.dataset;
    const versionMismatch = !!d && d.versionMismatch && ctx.scenario === "finalize-confirm";
    if (!versionMismatch) {
      ctx.logger.event("decision", { action: "finalizePlan", note: "封口三问通过,自动锁定计划", dpNo: ctx.dsNo ? d?.dpNo : undefined });
      return { payloadByEvent: { PLAN_FINALIZED: { dpNo: d?.dpNo ?? "DP?", locked: true, sealOk: true } } };
    }
    // 封口三问:拟封口版本 ≠ 最终确认采纳版 → 转人工确认版本
    return {
      gate: {
        gateKey: "finalizePlan",
        category: "agent",
        source: "智调·计划定版",
        title: `计划定版封口 · ${d?.dpNo}（版本核对）`,
        body: `案件 ${ctx.dsNo} 封口三问发现拟定版版本与最终确认采纳版不一致(退回重算过),请核对 DP 版本号后确认封口或退回。`,
        anchors: { caseId: ctx.caseId, dsNo: ctx.dsNo, gate: "finalizePlan", dpNo: d?.dpNo ?? "" },
        route: (dec) => {
          if (dec.decision === "确认封口") return { emitEvents: ["PLAN_FINALIZED"], payload: { dpNo: d?.dpNo ?? "DP?", locked: true, sealOk: true, versionConfirmed: true, operator: dec.operator ?? null } };
          return { emitEvents: ["FORECAST_COMPLETED"], payload: { revised: true, decision: "revise" }, resetClaims: REGEN_CLAIMS }; // 不通过 → 回重算
        },
      },
    };
  },
};

// ── forecastOutput — 出力预测 QC 规则校验(per-step rule-check #3)──────────────
const forecastOutput: EnergyBehavior = {
  retries: 3,
  async compute(ctx) {
    const d = ctx.dataset;
    if (!d) return { skip: true, skipReason: "no-dataset" };
    const ruleset = await ctx.step.run("fetch-rules", () => fetchEnergyEngineRules());
    const chk = runForecastCheck(ruleset.rules, d);
    ctx.logger.event("rules_selected", { stage: chk.stage, total: ruleset.total, selected: chk.selected.length, codes: chk.selected.map((r) => r.code) });
    ctx.logger.event("selection_verified", { ok: chk.verification.ok, missing: chk.verification.missing, note: "二次验证:出力预测关键规则(置信区间/版本)是否覆盖" });
    ctx.logger.event("decision", { action: "forecastOutput", decision: chk.decision, confidence: d.forecastConfidence });
    await ctx.step.run("persist-rulecheck", () =>
      persistRuleCheck({ agentSlug: "energy-forecast-output", agentName: "ForecastOutputAgent", stage: chk.stage, caseId: ctx.caseId, runId: ctx.runId, dsNo: ctx.dsNo, decision: chk.decision, redlineFlag: chk.decision === "VIOLATED", rulesTotal: ruleset.total, rulesExpected: chk.rulesExpected, selected: chk.selected, verification: chk.verification, evals: chk.evals, ruleSource: ruleset.source }),
    );
    return { payloadByEvent: { FORECAST_COMPLETED: { fcNo: d.fcNo, forecastConfidence: d.forecastConfidence, p50p90: true } } };
  },
};

// ── generateSuggestion — 调度建议生成 QC 规则校验(per-step rule-check #4)───────
const generateSuggestion: EnergyBehavior = {
  retries: 3,
  async compute(ctx) {
    const d = ctx.dataset;
    if (!d) return { skip: true, skipReason: "no-dataset" };
    const ruleset = await ctx.step.run("fetch-rules", () => fetchEnergyEngineRules());
    const chk = runSuggestionCheck(ruleset.rules, d);
    ctx.logger.event("rules_selected", { stage: chk.stage, total: ruleset.total, selected: chk.selected.length, codes: chk.selected.map((r) => r.code) });
    ctx.logger.event("selection_verified", { ok: chk.verification.ok, missing: chk.verification.missing, note: "二次验证:建议生成关键规则(关口对齐/目标优先级)是否覆盖" });
    ctx.logger.event("decision", { action: "generateSuggestion", decision: chk.decision, gzlDeviationPct: d.gzlDeviationPct, revised: bool(ctx.upstream.revised) });
    await ctx.step.run("persist-rulecheck", () =>
      persistRuleCheck({ agentSlug: "energy-generate-suggestion", agentName: "GenerateSuggestionAgent", stage: chk.stage, caseId: ctx.caseId, runId: ctx.runId, dsNo: ctx.dsNo, decision: chk.decision, redlineFlag: chk.decision === "VIOLATED", rulesTotal: ruleset.total, rulesExpected: chk.rulesExpected, selected: chk.selected, verification: chk.verification, evals: chk.evals, ruleSource: ruleset.source }),
    );
    return { payloadByEvent: { SUGGESTION_GENERATED: { gzlDeviationPct: d.gzlDeviationPct } } };
  },
};

export const ENERGY_BEHAVIORS: Record<string, EnergyBehavior> = {
  forecastOutput,
  generateSuggestion,
  validateConstraints,
  triageScheme,
  manualConfirm,
  raiseRiskEvent,
  resolveRiskAndResume,
  finalizePlan,
  handleFloodControl: riskHandler("handleFloodControl", ["T3"], "防洪风险处置", "智调·防洪调度", "FLOOD_CONTROL_HANDLED"),
  handleGridSecurity: riskHandler("handleGridSecurity", ["T2"], "电网安全处置", "智调·电网安全", "GRID_SECURITY_HANDLED"),
  handleEquipmentFault: riskHandler("handleEquipmentFault", ["T4"], "设备故障处置", "智调·设备", "EQUIPMENT_FAULT_HANDLED"),
  handleRenewableCurtailment: riskHandler("handleRenewableCurtailment", ["T1"], "弃风弃光处置", "智调·新能源消纳", "CURTAILMENT_HANDLED"),
};
