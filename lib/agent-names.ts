"use client";
import React from "react";
import { useApp, type Lang } from "@/lib/i18n";
import { byShort } from "@/lib/agent-mapping";

// Bilingual display names for the 22 raas agents.
// Used by /overview + anywhere we want to honor the AppBar zh/en switch.
// `inngestName` in lib/agent-mapping.ts is the canonical name registered in
// Inngest (mixed zh/en historically); these maps are the user-facing copy.
//
// Convention: zh = noun phrase (no 智能体 suffix — context makes "agent" clear);
// en = Title Case noun phrase.

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

/** Pure lookup. Falls back to the agent's Inngest name (if registered) and
 *  finally to the short code so unknown agents render *something* sensible. */
export function displayNameFor(short: string, lang: Lang): string {
  const map = lang === "en" ? AGENT_NAMES_EN : AGENT_NAMES_ZH;
  if (map[short]) return map[short]!;
  const meta = byShort(short);
  return meta?.inngestName ?? short;
}

/** Hook-style consumer for React trees — reads the active language from
 *  useApp() and returns the locale-appropriate display name. */
export function useDisplayName(short: string): string {
  const { lang } = useApp();
  return React.useMemo(() => displayNameFor(short, lang), [short, lang]);
}

/** Same as `useDisplayName` but resolves the lang once and returns a
 *  resolver function — handy when rendering a list and avoiding per-row
 *  hook calls. */
export function useDisplayNameResolver(): (short: string) => string {
  const { lang } = useApp();
  return React.useCallback((short: string) => displayNameFor(short, lang), [lang]);
}
