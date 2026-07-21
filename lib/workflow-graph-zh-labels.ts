// Curated Chinese display labels for generated-domain workflow nodes.
//
// Generated ontologies (能源调度 / 费控 / …) only carry an English action `name`
// (e.g. "forecastOutput") plus a Chinese prose `description` — there is no
// per-action Chinese name field. So the workflow canvas can't localize those
// nodes the way recruitment does (via the `display_<short>` i18n keys).
//
// This map provides a concise Chinese label per action, keyed by domain id then
// by the ontology action `name`. The builder uses it for `node.titleZh`; any
// action not listed here falls back to deriveZhLabel(description) → humanized
// English, so adding a new action degrades gracefully (English) rather than
// breaking. Labels are condensed from each action's own description.

import { ENERGY_DOMAIN_ID } from "./domain-ids";

/** Allmeta domain id for the expense-control (费控) ontology pack. */
export const EXPENSE_DOMAIN_ID = "费控-v1";

export const WORKFLOW_ZH_LABELS: Record<string, Record<string, string>> = {
  [ENERGY_DOMAIN_ID]: {
    ingestAndOpenCase: "数据接入开案",
    interpretData: "数据解释",
    forecastOutput: "出力预测",
    generateSuggestion: "调度建议生成",
    validateConstraints: "约束校验",
    compareSchemes: "方案比选",
    triageScheme: "分流判断",
    manualConfirm: "人工确认",
    finalizePlan: "计划定版",
    postToEMS: "回写能控EMS",
    declareMarket: "市场申报",
    dispatchInstruction: "指令下发",
    captureExecution: "执行回采监盘",
    rollingRevision: "日内滚动修正",
    analyzeDeviation: "偏差分析复盘",
    archiveCase: "全链路归档",
    raiseRiskEvent: "风险事件立项",
    handleFloodControl: "防洪应急处置",
    handleGridSecurity: "电网安全应急",
    handleEquipmentFault: "设备故障应急",
    handleRenewableCurtailment: "新能源消纳处置",
    switchOperatingMode: "运行方式切换",
    handoverShift: "交接班",
    assessForecastAccuracy: "预测准确率考核",
    runOperationAudit: "运行稽核审计",
    maintainConstraintConfig: "约束配置维护",
    resolveRiskAndResume: "风险闭环解除",
    validateAndDeploySystemChange: "系统变更上线",
  },
  [EXPENSE_DOMAIN_ID]: {
    submitExpenseClaim: "报销提报",
    runInvoiceOCR: "发票OCR识别",
    fixInvoice: "发票修复",
    validateExpenseRules: "费用规则校验",
    occupyBudget: "预算占用",
    generateApprovalSuggestion: "审批建议生成",
    routeOrAutoApprove: "分流与自动核准",
    manualReview: "人工复核",
    runApprovalFlow: "审批流转",
    postToERP: "回写ERP记账",
    initiatePayment: "发起付款",
    confirmPayment: "支付确认",
    disposeRiskEvent: "风险事件处置",
    archiveCase: "全流程归档",
  },
};

/** Curated Chinese label for a domain's action, if one exists. */
export function curatedZhLabel(
  domainId: string,
  actionName: string,
): string | undefined {
  return WORKFLOW_ZH_LABELS[domainId]?.[actionName];
}
