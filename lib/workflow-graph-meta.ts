import type { IcName } from '@/components/shared/Ic';

export type NodeKind = 'trigger' | 'agent' | 'branch' | 'hitl' | 'guard' | 'done';

export type WorkflowNode = {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  title: string;
  sub: string;
  icon: IcName;
};

export type WorkflowEdge = {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
};

// 1620×560 viewBox — match the historical /workflow layout exactly.
// Coordinates copied 1:1 from components/workflow/WorkflowContent.tsx
// (before extraction on 2026-05-14).
export const GRAPH_VIEWBOX = '0 0 1620 560' as const;
export const GRAPH_WIDTH = 1620 as const;
export const GRAPH_HEIGHT = 560 as const;

export const NODES: WorkflowNode[] = [
  { id: "trig", kind: "trigger", x: 20, y: 240, title: "定时同步 / Webhook", sub: "SCHEDULED_SYNC · 客户 RMS", icon: "bolt" },
  { id: "sync", kind: "agent", x: 200, y: 240, title: "ReqSync", sub: "需求同步 → REQUIREMENT_SYNCED", icon: "db" },
  { id: "analyze", kind: "agent", x: 380, y: 240, title: "ReqAnalyzer", sub: "需求分析 → ANALYSIS_COMPLETED", icon: "sparkle" },
  { id: "clarify", kind: "branch", x: 560, y: 240, title: "信息完整?", sub: "缺失字段 / 冲突", icon: "branch" },
  { id: "ask", kind: "hitl", x: 740, y: 360, title: "HSM 澄清", sub: "CLARIFICATION_RETRY", icon: "user" },
  { id: "jd", kind: "agent", x: 740, y: 140, title: "JDGenerator", sub: "JD 生成 → JD_GENERATED", icon: "sparkle" },
  { id: "jdappr", kind: "hitl", x: 920, y: 140, title: "HSM 审批 JD", sub: "JD_APPROVED / JD_REJECTED", icon: "shield" },
  { id: "publish", kind: "agent", x: 1100, y: 140, title: "Publisher", sub: "多渠道发布 → CHANNEL_PUBLISHED", icon: "plug" },
  { id: "collect", kind: "agent", x: 1280, y: 140, title: "ResumeCollector", sub: "RESUME_DOWNLOADED", icon: "db" },
  { id: "parse", kind: "agent", x: 1280, y: 240, title: "ResumeParser + DupeCheck", sub: "RESUME_PROCESSED / LOCKED_CONFLICT", icon: "cpu" },
  { id: "match", kind: "branch", x: 1100, y: 340, title: "人岗匹配", sub: "Matcher · 硬性 / 加分 / 负向", icon: "branch" },
  { id: "reject", kind: "done", x: 1280, y: 420, title: "归档 · MATCH_FAILED", sub: "黑名单 / 硬性不符", icon: "cross" },
  { id: "itv", kind: "agent", x: 920, y: 340, title: "AIInterviewer", sub: "AI 面试官 → AI_INTERVIEW_COMPLETED", icon: "sparkle" },
  { id: "eval", kind: "agent", x: 740, y: 340, title: "Evaluator", sub: "EVALUATION_PASSED / FAILED", icon: "cpu" },
  { id: "pkg", kind: "agent", x: 560, y: 340, title: "PackageBuilder", sub: "PACKAGE_GENERATED · 简历+评估", icon: "book" },
  { id: "review", kind: "hitl", x: 380, y: 440, title: "HSM 审核推荐包", sub: "PACKAGE_APPROVED · SLA 4h", icon: "user" },
  { id: "guard", kind: "guard", x: 200, y: 440, title: "合规 & 黑名单", sub: "PII / EEO / Blacklist", icon: "shield" },
  { id: "submit", kind: "agent", x: 20, y: 440, title: "PortalSubmitter", sub: "APPLICATION_SUBMITTED", icon: "mail" },
];

export const EDGES: WorkflowEdge[] = [
  { from: "trig", to: "sync" },
  { from: "sync", to: "analyze" },
  { from: "analyze", to: "clarify" },
  { from: "clarify", to: "jd", label: "OK" },
  { from: "clarify", to: "ask", label: "缺失", dashed: true },
  { from: "ask", to: "analyze", dashed: true },
  { from: "jd", to: "jdappr" },
  { from: "jdappr", to: "publish" },
  { from: "publish", to: "collect" },
  { from: "collect", to: "parse" },
  { from: "parse", to: "match" },
  { from: "match", to: "reject", label: "不符", dashed: true },
  { from: "match", to: "itv", label: "匹配" },
  { from: "itv", to: "eval" },
  { from: "eval", to: "pkg" },
  { from: "pkg", to: "review" },
  { from: "review", to: "guard" },
  { from: "guard", to: "submit" },
];

const NODE_BY_ID = new Map(NODES.map(n => [n.id, n]));
export function nodeById(id: string): WorkflowNode | undefined {
  return NODE_BY_ID.get(id);
}
