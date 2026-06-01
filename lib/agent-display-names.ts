// Server-safe bilingual agent display names.
//
// Pure data + lookup — NO "use client", no React — so server paths (run-summary
// synthesis, audit) can localize agent identifiers to business names without
// pulling in the client bundle. lib/agent-names.ts (client) re-exports these
// and adds the React hooks (useDisplayName, …).
//
// Convention: zh = noun phrase (no 智能体 suffix — context makes "agent" clear);
// en = Title Case noun phrase.

import { resolveAgentMeta } from "@/lib/agent-mapping";

export type DisplayLang = "zh" | "en";

export const AGENT_NAMES_ZH: Record<string, string> = {
  ReqSync: "需求同步",
  ManualEntry: "手工录入",
  ReqAnalyzer: "需求分析",
  Clarifier: "需求澄清",
  ReClarifier: "需求重澄清",
  JDGenerator: "JD 生成",
  JDReviewer: "JD 审核",
  TaskAssigner: "任务分配",
  Publisher: "渠道发布",
  ManualPublish: "手工发布",
  ResumeCollector: "简历收集",
  ResumeParser: "简历解析",
  ResumeFixer: "简历修复",
  Matcher: "简历匹配",
  RuleCheck: "规则校验",
  InterviewInviter: "面试邀约",
  AIInterviewer: "AI 面试",
  Evaluator: "面试评估",
  ResumeRefiner: "简历优化",
  PackageBuilder: "推荐包构建",
  PackageFiller: "推荐包补全",
  PackageReviewer: "推荐包审核",
  PortalSubmitter: "客户端提交",
  Chatbot: "助手",
};

export const AGENT_NAMES_EN: Record<string, string> = {
  ReqSync: "Requirement Sync",
  ManualEntry: "Manual Entry",
  ReqAnalyzer: "Requirement Analyzer",
  Clarifier: "Clarifier",
  ReClarifier: "Re-Clarifier",
  JDGenerator: "JD Generator",
  JDReviewer: "JD Reviewer",
  TaskAssigner: "Task Assigner",
  Publisher: "Channel Publisher",
  ManualPublish: "Manual Publisher",
  ResumeCollector: "Resume Collector",
  ResumeParser: "Resume Parser",
  ResumeFixer: "Resume Fixer",
  Matcher: "Resume Matcher",
  RuleCheck: "Rule Check",
  InterviewInviter: "Interview Inviter",
  AIInterviewer: "AI Interviewer",
  Evaluator: "Evaluator",
  ResumeRefiner: "Resume Refiner",
  PackageBuilder: "Package Builder",
  PackageFiller: "Package Filler",
  PackageReviewer: "Package Reviewer",
  PortalSubmitter: "Portal Submitter",
  Chatbot: "Assistant",
};

/**
 * Resolve ANY agent identifier — canonical short ('RuleCheck'), bare Inngest fn
 * id ('rule-check-agent'), or app-prefixed Inngest slug
 * ('agentic-operator-main-rule-check-agent') — to a business display name in
 * the given language. Falls back to inngestName then the raw id so unknown
 * agents still render something sensible (never a raw slug if it's known).
 */
export function displayNameFor(idOrShort: string, lang: DisplayLang): string {
  const meta = resolveAgentMeta(idOrShort);
  const short = meta?.short ?? idOrShort;
  const map = lang === "en" ? AGENT_NAMES_EN : AGENT_NAMES_ZH;
  return map[short] ?? meta?.inngestName ?? short;
}
