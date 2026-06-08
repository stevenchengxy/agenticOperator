// Ontology Generator — per-domain profiles powering the domain dropdown.
//
// Every generated agent is a SANDBOXED SHELL: its `short` is the display agent
// id and its `slug` is prefixed `og-`, so it NEVER collides with a real Inngest
// function id (match-resume-agent, interview-inviter-agent, …). Deploying,
// onlining or offlining a shell therefore can never touch the real production
// agents. `raas` is the screenshot domain; 费控 / 能源调度 are curated profiles
// whose ontologies live outside this repo.
//
// Per spec: domain/candidate display copy is mock-data-only, so it lives here,
// not in lib/i18n.tsx (matching how other pages hardcode domain copy).

import type { DomainProfile } from "./types";

const RAAS: DomainProfile = {
  id: "raas",
  nameZh: "招聘交付",
  nameEn: "Recruitment Delivery",
  iconChar: "招",
  iconColor: "oklch(0.62 0.17 268)",
  counts: { rules: 6, dataObjects: 6, actions: 6, events: 6, workflow: 1 },
  candidates: [
    {
      key: "match-resume",
      short: "MatchResumeAgent",
      slug: "og-match-resume",
      nameZh: "岗位撮合",
      nameEn: "Job Matching",
      agentId: "MatchResumeAgent",
      descZh: "为通过预筛的候选人计算与岗位的契合度并深度评分",
      descEn: "Scores pre-screened candidates against the job for fit depth",
      triggerEvent: "MATCH_RULE_CHECK_PASSED",
      emitEvent: "MATCH_SCORED",
      rationaleZh: "工作流中 MATCH_RULE_CHECK_PASSED 事件下游缺少消费者，且 scoreMatch 动作未被任何智能体绑定",
      rationaleEn: "MATCH_RULE_CHECK_PASSED has no downstream consumer, and the scoreMatch action is bound to no agent",
      confidence: 96,
      iconChar: "岗",
      iconColor: "oklch(0.62 0.17 285)",
    },
    {
      key: "interview-invite",
      short: "InterviewInviterAgent",
      slug: "og-interview-invite",
      nameZh: "面试邀约",
      nameEn: "Interview Invite",
      agentId: "InterviewInviterAgent",
      descZh: "对高契合候选人自动生成话术并发起面试邀约",
      descEn: "Drafts outreach and sends interview invites to high-fit candidates",
      triggerEvent: "EVALUATION_PASSED",
      emitEvent: "INTERVIEW_INVITE_SENT",
      rationaleZh: "EVALUATION_PASSED 事件已定义但无订阅者，InterviewInvite 数据对象未被写入",
      rationaleEn: "EVALUATION_PASSED is defined but has no subscriber, and the InterviewInvite data object is never written",
      confidence: 92,
      iconChar: "面",
      iconColor: "oklch(0.64 0.15 155)",
    },
  ],
};

const FEIKONG: DomainProfile = {
  id: "feikong",
  nameZh: "费控报销",
  nameEn: "Expense Control",
  iconChar: "费",
  iconColor: "oklch(0.64 0.15 70)",
  counts: { rules: 8, dataObjects: 5, actions: 5, events: 7, workflow: 1 },
  candidates: [
    {
      key: "invoice-audit",
      short: "InvoiceAuditAgent",
      slug: "og-invoice-audit",
      nameZh: "票据稽核",
      nameEn: "Invoice Audit",
      agentId: "InvoiceAuditAgent",
      descZh: "对提交的报销票据做真伪与合规稽核并打标",
      descEn: "Audits submitted invoices for authenticity and policy compliance",
      triggerEvent: "EXPENSE_SUBMITTED",
      emitEvent: "AUDIT_FLAGGED",
      rationaleZh: "EXPENSE_SUBMITTED 事件下游无稽核消费者，auditInvoice 动作未被任何智能体绑定",
      rationaleEn: "EXPENSE_SUBMITTED has no audit consumer; the auditInvoice action is bound to no agent",
      confidence: 94,
      iconChar: "票",
      iconColor: "oklch(0.64 0.15 70)",
    },
    {
      key: "budget-guard",
      short: "BudgetGuardAgent",
      slug: "og-budget-guard",
      nameZh: "超标预警",
      nameEn: "Budget Guard",
      agentId: "BudgetGuardAgent",
      descZh: "对稽核通过的费用比对预算并对超标项预警",
      descEn: "Checks audited expenses against budget and alerts on overruns",
      triggerEvent: "EXPENSE_AUDITED",
      emitEvent: "BUDGET_ALERT_SENT",
      rationaleZh: "EXPENSE_AUDITED 事件已定义但无订阅者，BudgetLedger 数据对象未被写入",
      rationaleEn: "EXPENSE_AUDITED is defined but has no subscriber; the BudgetLedger data object is never written",
      confidence: 89,
      iconChar: "超",
      iconColor: "oklch(0.6 0.18 30)",
    },
  ],
};

const ENERGY: DomainProfile = {
  id: "energy",
  nameZh: "能源调度",
  nameEn: "Energy Dispatch",
  iconChar: "能",
  iconColor: "oklch(0.62 0.14 200)",
  counts: { rules: 9, dataObjects: 7, actions: 8, events: 8, workflow: 2 },
  candidates: [
    {
      key: "load-forecast",
      short: "LoadForecastAgent",
      slug: "og-load-forecast",
      nameZh: "负荷预测",
      nameEn: "Load Forecast",
      agentId: "LoadForecastAgent",
      descZh: "基于实时遥测预测区域负荷曲线",
      descEn: "Forecasts regional load curves from real-time telemetry",
      triggerEvent: "TELEMETRY_INGESTED",
      emitEvent: "LOAD_FORECASTED",
      rationaleZh: "TELEMETRY_INGESTED 事件下游无预测消费者，forecastLoad 动作未被任何智能体绑定",
      rationaleEn: "TELEMETRY_INGESTED has no forecasting consumer; the forecastLoad action is bound to no agent",
      confidence: 91,
      iconChar: "荷",
      iconColor: "oklch(0.62 0.14 200)",
    },
    {
      key: "dispatch-optimize",
      short: "DispatchOptimizerAgent",
      slug: "og-dispatch-optimize",
      nameZh: "调度优化",
      nameEn: "Dispatch Optimize",
      agentId: "DispatchOptimizerAgent",
      descZh: "依据负荷预测求解机组出力并下发调度计划",
      descEn: "Solves unit output from the forecast and issues the dispatch plan",
      triggerEvent: "LOAD_FORECASTED",
      emitEvent: "DISPATCH_PLAN_ISSUED",
      rationaleZh: "LOAD_FORECASTED 事件已定义但无订阅者，DispatchPlan 数据对象未被写入",
      rationaleEn: "LOAD_FORECASTED is defined but has no subscriber; the DispatchPlan data object is never written",
      confidence: 88,
      iconChar: "调",
      iconColor: "oklch(0.6 0.16 255)",
    },
  ],
};

export const DOMAIN_PROFILES: DomainProfile[] = [RAAS, FEIKONG, ENERGY];

export const DEFAULT_DOMAIN_ID = RAAS.id;

// Curated ontology for an app domain that has no defined ontology — a clean
// empty state (zero elements, no candidates) rather than fabricated agents.
const GENERIC_PROFILE: DomainProfile = {
  id: "generic",
  nameZh: "",
  nameEn: "",
  iconChar: "·",
  iconColor: "oklch(0.6 0.02 260)",
  counts: { rules: 0, dataObjects: 0, actions: 0, events: 0, workflow: 0 },
  candidates: [],
};

// Direct id → profile (for app domains whose id is one of the curated ids).
const PROFILE_BY_ID: Record<string, DomainProfile> = {
  raas: RAAS,
  feikong: FEIKONG,
  energy: ENERGY,
};

// Keyword → profile, matched against the app domain's name + id. Lets the real
// app domains (业务领域, R7·ATS, A-采购报销, …) resolve to a curated ontology
// even though their ids/names differ from the curated profiles.
const KEYWORD_RULES: { profile: DomainProfile; keywords: string[] }[] = [
  { profile: RAAS, keywords: ["招聘", "人才", "交付", "recruit", "ats", "hr", "raas", "r7"] },
  { profile: FEIKONG, keywords: ["费控", "报销", "采购", "差旅", "财务", "expense", "reimburse", "procure", "finance"] },
  { profile: ENERGY, keywords: ["能源", "电力", "电网", "调度", "energy", "power", "grid", "dispatch"] },
];

// Match a keyword against the domain "haystack" (lowercased name + id). ASCII
// keywords (hr, power, grid, ats, …) use word-boundary matching so short tokens
// don't false-positive as substrings (e.g. "power" inside "Empowerment"). CJK
// keywords (招聘, 费控, …) use substring matching since CJK has no word breaks.
function matchesKeyword(hay: string, keyword: string): boolean {
  const k = keyword.toLowerCase();
  if (/^[a-z0-9]+$/.test(k)) {
    return new RegExp(`\\b${k}\\b`).test(hay);
  }
  return hay.includes(k);
}

/**
 * Resolve the ontology profile for an APP domain (id + optional display name).
 * The generator's domain selector is the app-wide domain list; this maps each
 * domain to a curated ontology where one fits (by id, then by keyword), and a
 * clean empty ontology otherwise. Pure — safe to call on server and client.
 */
export function resolveProfile(domainId: string, domainName?: string): DomainProfile {
  const byId = PROFILE_BY_ID[domainId];
  if (byId) return byId;
  const hay = `${domainName ?? ""} ${domainId}`.toLowerCase();
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some((k) => matchesKeyword(hay, k))) return rule.profile;
  }
  return GENERIC_PROFILE;
}

/** Back-compat id-only lookup (no name/keyword matching). */
export function getDomainProfile(domainId: string): DomainProfile {
  return PROFILE_BY_ID[domainId] ?? RAAS;
}
