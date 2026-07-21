// Per-action behaviors for the 费控 (cost-control) chain.
//
// The generic factory (../energy/make-agent.ts) runs every action as an LLM
// pass-through or simulated-human auto-responder. The chain steps that need REAL
// deterministic logic — OCR, the rule-check, budget, routing, the financial
// actions, and the two human gates — are declared here as Behaviors; the factory
// runs compute() instead of the LLM and honors any gate (notify + waitForEvent +
// route-by-decision). submitExpenseClaim / fixInvoice stay simulated-human.
//
//   runInvoiceOCR             → OCR_COMPLETED{minConf,verified}
//   validateExpenseRules      rule-check → VALIDATION_COMPLETED{deduction} | ANOMALY_DETECTED{risk}
//   occupyBudget              → BUDGET_OCCUPIED{bgNo} | BUDGET_INSUFFICIENT{T5}
//   generateApprovalSuggestion→ APPROVAL_SUGGESTION_GENERATED{recommend,routing}
//   routeOrAutoApprove        → AUTO_APPROVED | ROUTED_TO_MANUAL{reason} (PIPE-01 五条件)
//   manualReview              gate(确认核准/降额/退回/驳回)
//   runApprovalFlow           → APPROVAL_PASSED (simulated 逐级)
//   postToERP/initiatePayment/confirmPayment/archiveCase  → 财务动作 FA-04…FA-09
//   disposeRiskEvent          gate(放行/暂缓/上报) — L3/L4 风险处置

import type { Behavior, ComputeResult } from "@/server/inngest/agent-factory/types";
import { evidenceLine, type FeikongScenarioData } from "./sim-data";
import { fetchFeikongEngineRules, runExpenseRuleCheck, persistRuleCheck } from "./rule-check/run-rule-check";

type FeikongBehavior = Behavior<FeikongScenarioData>;

const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);

function rkNoFrom(dsNo: string): string {
  return `RK${dsNo.replace(/\D/g, "").slice(0, 8) || "20260530"}00001`;
}

// ── runInvoiceOCR — 发票 OCR 结构化 + 置信度门槛(PIPE-03)─────────────────────
const runInvoiceOCR: FeikongBehavior = {
  async compute(ctx): Promise<ComputeResult> {
    const d = ctx.dataset;
    if (!d) return { skip: true, skipReason: "no-dataset" };
    const minConf = Math.min(...d.lines.map((l) => l.ocrConfidence));
    const verified = d.lines.every((l) => l.verification === "已验真");
    const ok = minConf >= d.limits.ocrFloor && verified;
    ctx.logger.event("decision", { action: "runInvoiceOCR", minConf, verified, ocrFloor: d.limits.ocrFloor, route: ok ? "OCR_COMPLETED" : "OCR_FAILED" });
    return ok
      ? { emitEvents: ["OCR_COMPLETED"], payloadByEvent: { OCR_COMPLETED: { minConf, verified, lines: d.lines.length } } }
      : { emitEvents: ["OCR_FAILED"], payloadByEvent: { OCR_FAILED: { minConf, verified, note: "关键字段低置信,转人工补正" } } };
  },
};

// ── validateExpenseRules — 四组规则校验(INV→STD→CMP→BUD,PIPE-02/04)──────────
const validateExpenseRules: FeikongBehavior = {
  retries: 3,
  async compute(ctx): Promise<ComputeResult> {
    const d = ctx.dataset;
    if (!d) return { skip: true, skipReason: "no-dataset" };
    const ruleset = await ctx.step.run("fetch-rules", () => fetchFeikongEngineRules());
    const chk = runExpenseRuleCheck(ruleset.rules, d);

    ctx.logger.event("rules_selected", { stage: chk.stage, total: ruleset.total, selected: chk.selected.length, codes: chk.selected.map((r) => r.code) });
    ctx.logger.event("selection_verified", { ok: chk.verification.ok, missing: chk.verification.missing, note: "二次验证:硬阻断 + 升风险规则是否全部抓到" });
    for (const e of chk.evals.filter((x) => x.result !== "PASS")) {
      ctx.logger.event("rule_judged", { code: e.code, group: e.group, result: e.result, checkPoint: e.checkPoint, before: e.beforeVal, after: e.afterVal, risk: e.riskType ? `${e.riskType}/${e.riskLevel}` : undefined });
    }
    ctx.logger.event("decision", { action: "validateExpenseRules", decision: chk.decision, deduction: chk.deductionTotal, payable: chk.payableAfterDeduction, risk: chk.risk?.riskType });

    await ctx.step.run("persist-rulecheck", () =>
      persistRuleCheck({ agentSlug: "feikong-validate-expense-rules", agentName: "ValidateExpenseRulesAgent", stage: chk.stage, caseId: ctx.caseId, runId: ctx.runId, dsNo: ctx.dsNo, decision: chk.decision, redlineFlag: chk.redlineFlag, rulesTotal: ruleset.total, rulesExpected: chk.rulesExpected, selected: chk.selected, verification: chk.verification, evals: chk.evals, ruleSource: ruleset.source }),
    );

    if (chk.risk) {
      const rkNo = rkNoFrom(ctx.dsNo);
      return {
        emitEvents: ["ANOMALY_DETECTED"],
        payloadByEvent: { ANOMALY_DETECTED: { rkNo, hitRule: chk.risk.hitRule, riskType: chk.risk.riskType, riskLevel: chk.risk.riskLevel, evidence: chk.risk.evidence, deductionTotal: chk.deductionTotal, payable: chk.payableAfterDeduction } },
      };
    }
    return {
      emitEvents: ["VALIDATION_COMPLETED"],
      payloadByEvent: { VALIDATION_COMPLETED: { conclusion: chk.deductionTotal > 0 ? "有核减" : "通过", deductionTotal: chk.deductionTotal, payable: chk.payableAfterDeduction, evidence: evidenceLine(d) } },
    };
  },
};

// ── occupyBudget — 预算占用(成本中心×科目×期间)─────────────────────────────
const occupyBudget: FeikongBehavior = {
  async compute(ctx): Promise<ComputeResult> {
    const d = ctx.dataset;
    if (!d) return { skip: true, skipReason: "no-dataset" };
    const payable = num(ctx.upstream.payable, d.totalAmount);
    const ok = payable <= d.budgetAvailable;
    ctx.logger.event("decision", { action: "occupyBudget", payable, available: d.budgetAvailable, result: ok ? "BUDGET_OCCUPIED" : "BUDGET_INSUFFICIENT" });
    if (ok) {
      const bgNo = `BG${d.dsNo.replace(/\D/g, "").slice(0, 8)}01234`;
      return { emitEvents: ["BUDGET_OCCUPIED"], payloadByEvent: { BUDGET_OCCUPIED: { bgNo, occupied: payable, availableAfter: Math.round((d.budgetAvailable - payable) * 100) / 100, fa: "FA-01" } } };
    }
    return { emitEvents: ["BUDGET_INSUFFICIENT"], payloadByEvent: { BUDGET_INSUFFICIENT: { payable, available: d.budgetAvailable, riskType: "T5", riskLevel: "L3", hitRule: "RULE-BUD-02" } } };
  },
};

// ── generateApprovalSuggestion — 汇总校验/风险/预算 → 审批建议 + 路由 ──────────
const APPROVAL_TIERS: Array<[number, string]> = [
  [5000, "直接主管"],
  [20000, "主管→经理"],
  [50000, "主管→经理→总监"],
  [200000, "…→VP"],
  [Infinity, "…→CFO→CEO"],
];

const generateApprovalSuggestion: FeikongBehavior = {
  async compute(ctx): Promise<ComputeResult> {
    const d = ctx.dataset;
    if (!d) return { skip: true, skipReason: "no-dataset" };
    const deduction = num(ctx.upstream.deductionTotal);
    const payable = num(ctx.upstream.payable, d.totalAmount);
    const routingPlan = APPROVAL_TIERS.find(([cap]) => payable <= cap)?.[1] ?? "直接主管";
    const recommended = deduction > 0 ? "建议降额" : "建议核准";
    ctx.logger.event("decision", { action: "generateApprovalSuggestion", recommended, payable, routingPlan });
    return {
      emitEvents: ["APPROVAL_SUGGESTION_GENERATED"],
      payloadByEvent: { APPROVAL_SUGGESTION_GENERATED: { recommendedAction: recommended, payable, deduction, routingPlan } },
    };
  },
};

// ── routeOrAutoApprove — 直通自动核准五条件(PIPE-01,木桶取最短板)──────────────
const routeOrAutoApprove: FeikongBehavior = {
  async compute(ctx): Promise<ComputeResult> {
    const d = ctx.dataset;
    if (!d) return { skip: true, skipReason: "no-dataset" };
    const L = d.limits;
    const deduction = num(ctx.upstream.deductionTotal);
    const payable = num(ctx.upstream.payable, d.totalAmount);
    const minConf = Math.min(...d.lines.map((l) => l.ocrConfidence));
    const verified = d.lines.every((l) => l.verification === "已验真");

    const failed: string[] = [];
    if (payable > L.autoTotalMax) failed.push(`合计可报>${L.autoTotalMax}`);
    if (d.lines.some((l) => l.amount > L.autoInvoiceMax)) failed.push(`单票>${L.autoInvoiceMax}`);
    if (minConf < L.ocrFloor || !verified) failed.push("OCR低置信/验真存疑");
    if (deduction > 0) failed.push("有核减,需人工确认核减额");

    const route = failed.length === 0 ? "AUTO_APPROVED" : "ROUTED_TO_MANUAL";
    ctx.logger.event("decision", { action: "routeOrAutoApprove", route, failed, payable });
    if (route === "AUTO_APPROVED") {
      return { emitEvents: ["AUTO_APPROVED"], payloadByEvent: { AUTO_APPROVED: { payable, auto: true } } };
    }
    return { emitEvents: ["ROUTED_TO_MANUAL"], payloadByEvent: { ROUTED_TO_MANUAL: { reason: failed.join("、"), payable, deduction } } };
  },
};

// ── manualReview — 转人工复核闸口(确认核准/降额/退回/驳回)────────────────────
const manualReview: FeikongBehavior = {
  async compute(ctx): Promise<ComputeResult> {
    const d = ctx.dataset;
    const reason = String(ctx.upstream.reason ?? "需复核");
    const deduction = num(ctx.upstream.deductionTotal);
    const payable = num(ctx.upstream.payable, d?.totalAmount ?? 0);
    return {
      gate: {
        gateKey: "manualReview",
        category: "agent",
        source: "费控·人工复核",
        title: `人工复核 · 报销单 ${d?.claimId ?? ctx.dsNo}（${reason}）`,
        body: `案件 ${ctx.dsNo} 转人工:${reason}。可报 ${payable} 元${deduction > 0 ? `(已核减 ${deduction})` : ""}。${d ? evidenceLine(d) : ""}。请费控审核员确认核准/降额/退回/驳回。`,
        anchors: { caseId: ctx.caseId, dsNo: ctx.dsNo, gate: "manualReview", claimId: d?.claimId ?? "", reason },
        route: (dec) => {
          if (dec.decision === "确认核准" || dec.decision === "降额") {
            return { emitEvents: ["MANUAL_CONFIRMED"], payload: { decision: "confirm", disposition: dec.decision, payable, deduction, reason: dec.reason ?? null, operator: dec.operator ?? null } };
          }
          if (dec.decision === "退回") {
            return { emitEvents: ["RETURNED_FOR_FIX"], payload: { returned: true, reason: dec.reason ?? null, operator: dec.operator ?? null } };
          }
          // 驳回 → 终态 VOID,FA-02 释放预算
          return { emitEvents: ["REJECTED"], payload: { rejected: true, reason: dec.reason ?? null, operator: dec.operator ?? null } };
        },
      },
    };
  },
};

// ── runApprovalFlow — 多级 BPM 审批(模拟逐级通过)──────────────────────────────
const runApprovalFlow: FeikongBehavior = {
  async compute(ctx): Promise<ComputeResult> {
    const d = ctx.dataset;
    const apNo = `AP${ctx.dsNo.replace(/\D/g, "").slice(0, 8)}001`;
    ctx.logger.event("decision", { action: "runApprovalFlow", apNo, note: "模拟逐级审批通过" });
    return { emitEvents: ["APPROVAL_PASSED"], payloadByEvent: { APPROVAL_PASSED: { apNo, payable: num(ctx.upstream.payable, d?.totalAmount ?? 0), levels: "已逐级通过" } } };
  },
};

// ── 财务动作:过账 → 发起支付 → 确认到账 → 归档 ────────────────────────────────
const postToERP: FeikongBehavior = {
  async compute(ctx): Promise<ComputeResult> {
    const d = ctx.dataset;
    const yfNo = `YF${ctx.dsNo.replace(/\D/g, "").slice(0, 8)}01`;
    const pzNo = `PZ${ctx.dsNo.replace(/\D/g, "").slice(0, 8)}01`;
    ctx.logger.event("decision", { action: "postToERP", yfNo, pzNo, fa: ["FA-04", "FA-05", "FA-06"] });
    return { emitEvents: ["ERP_POSTED"], payloadByEvent: { ERP_POSTED: { yfNo, pzNo, payable: num(ctx.upstream.payable, d?.totalAmount ?? 0), fa: "FA-04/05/06" } } };
  },
};

const initiatePayment: FeikongBehavior = {
  async compute(ctx): Promise<ComputeResult> {
    const payNo = `PAY${ctx.dsNo.replace(/\D/g, "").slice(0, 8)}01`;
    ctx.logger.event("decision", { action: "initiatePayment", payNo, channel: "银企直连", fa: "FA-07" });
    return { emitEvents: ["PAYMENT_INITIATED"], payloadByEvent: { PAYMENT_INITIATED: { payNo, channel: "银企直连", fa: "FA-07" } } };
  },
};

const confirmPayment: FeikongBehavior = {
  async compute(ctx): Promise<ComputeResult> {
    ctx.logger.event("decision", { action: "confirmPayment", fa: "FA-08", note: "银行回单确认到账" });
    return { emitEvents: ["PAYMENT_COMPLETED"], payloadByEvent: { PAYMENT_COMPLETED: { paid: true, fa: "FA-08" } } };
  },
};

const archiveCase: FeikongBehavior = {
  async compute(ctx): Promise<ComputeResult> {
    ctx.logger.event("decision", { action: "archiveCase", fa: "FA-09", note: "回写总账 + 全链路归档票夹云" });
    return { emitEvents: ["AUDIT_ARCHIVED"], payloadByEvent: { AUDIT_ARCHIVED: { archived: true, fa: "FA-09" } } };
  },
};

// ── disposeRiskEvent — L3/L4 风险处置闸口(放行/暂缓/上报)────────────────────────
const disposeRiskEvent: FeikongBehavior = {
  async compute(ctx): Promise<ComputeResult> {
    const d = ctx.dataset;
    const riskType = String(ctx.upstream.riskType ?? "");
    if (!riskType) return { skip: true, skipReason: "no-risk(本案无风险类型)" };
    const rkNo = String(ctx.upstream.rkNo ?? rkNoFrom(ctx.dsNo));
    const riskLevel = String(ctx.upstream.riskLevel ?? "L3");
    const payable = num(ctx.upstream.payable, d?.totalAmount ?? 0);
    return {
      gate: {
        gateKey: "disposeRiskEvent",
        category: "event",
        source: "费控·风险处置",
        title: `风险处置 · ${rkNo}（${riskType}/${riskLevel}）`,
        body: `命中 ${ctx.upstream.hitRule}(${riskType}/${riskLevel}),案件 ${ctx.dsNo} 已 SUSPENDED、付款冻结。${ctx.upstream.evidence ?? ""}。${d ? evidenceLine(d) : ""}。请费控主管/稽核处置后放行/暂缓/上报。`,
        riskType,
        riskLevel,
        anchors: { caseId: ctx.caseId, dsNo: ctx.dsNo, gate: "disposeRiskEvent", rkNo, hitRule: String(ctx.upstream.hitRule ?? "") },
        route: (dec) => {
          if (dec.decision === "放行") {
            // 误报/已说明 → 解冻,恢复主线(从校验通过继续到预算占用)
            return { emitEvents: ["VALIDATION_COMPLETED"], payload: { disposed: true, rkNo, conclusion: "风险已闭环放行", payable, reason: dec.reason ?? null, operator: dec.operator ?? null } };
          }
          if (dec.decision === "上报") {
            // 移送稽核内审,登记风险事件,维持 SUSPENDED
            return { emitEvents: ["RISK_EVENT_RAISED"], payload: { escalated: true, rkNo, riskType, riskLevel, reason: dec.reason ?? null, operator: dec.operator ?? null } };
          }
          // 暂缓 → 维持 SUSPENDED,不放行
          return { emitEvents: [], payload: { suspended: true, rkNo, reason: dec.reason ?? null } };
        },
      },
    };
  },
};

export const FEIKONG_BEHAVIORS: Record<string, FeikongBehavior> = {
  runInvoiceOCR,
  validateExpenseRules,
  occupyBudget,
  generateApprovalSuggestion,
  routeOrAutoApprove,
  manualReview,
  runApprovalFlow,
  postToERP,
  initiatePayment,
  confirmPayment,
  archiveCase,
  disposeRiskEvent,
};
