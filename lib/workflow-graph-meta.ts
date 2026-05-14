import type { IcName } from '@/components/shared/Ic';

// ─── Audit: Graph NODES vs AGENT_MAP ─────────────────────────────────────────
//
// The graph canvas has 18 NODES (see below). lib/agent-mapping.ts AGENT_MAP has
// 23 entries. This mismatch is INTENTIONAL — the graph is a simplified conceptual
// workflow view, not a 1:1 deployment registry.
//
// Non-agent control nodes (4 nodes that have no AGENT_MAP entry):
//   id="trig"    kind=trigger  — conceptual trigger node (SCHEDULED_SYNC / Webhook)
//   id="clarify" kind=branch   — decision diamond: "信息完整?" (branch, not an agent)
//   id="match"   kind=branch   — decision diamond: "人岗匹配" (Matcher handles logic)
//   id="reject"  kind=done     — terminal sink: MATCH_FAILED archive (not an agent)
//
// AGENT_MAP entries NOT represented on the graph (intentionally merged / omitted):
//   ManualEntry      (wsId=1-2)  — merged into the clarify HITL "ask" node conceptually
//   Clarifier        (wsId=3)    — modelled as the "clarify" branch node; its logic is
//                                  the branch condition, not a distinct canvas node
//   JDReviewer       (wsId=5)    — merged into graph "jdappr" HITL node (title "HSM 审批 JD")
//   TaskAssigner     (wsId=6)    — omitted; sits between JD_APPROVED and Publisher;
//                                  not prominent enough for a top-level canvas node
//   ManualPublish    (wsId=7-2)  — omitted; fallback HITL for publisher failures;
//                                  shown as Publisher's sub (terminal:true path)
//   ResumeFixer      (wsId=9-2)  — omitted; HITL fallback when ResumeParser fails
//   MatchReviewer    (wsId=10-HITL) — omitted; HITL for MATCH_FAILED review
//   InterviewInviter (wsId=11-1) — omitted; its role is implied by AIInterviewer entering
//   ResumeRefiner    (wsId=13)   — omitted; sits between Evaluator and PackageBuilder;
//                                  conceptually part of the package preparation lane
//   PackageFiller    (wsId=14-2) — omitted; HITL fallback for PackageBuilder
//   PackageReviewer  (wsId=15)   — merged into graph "review" HITL node
//   Chatbot          (wsId=system-chatbot) — system-level meta agent; deliberately
//                                  not part of the business workflow canvas
//
// agentName fallback mapping (for DB lookups when title ≠ AGENT_MAP.short):
//   id="parse"  → agentName="ResumeParser"  (title is "ResumeParser + DupeCheck")
//   All other agent-kind nodes: no agentName override; title IS the canonical short.
//   Non-agent nodes (trig/clarify/match/reject/ask/jdappr/review/guard) have no
//   AGENT_MAP entry; lookups gracefully return null.
//
// ─────────────────────────────────────────────────────────────────────────────

export type NodeKind = 'trigger' | 'agent' | 'branch' | 'hitl' | 'guard' | 'done';

export type WorkflowNode = {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  title: string;
  sub: string;
  icon: IcName;
  /**
   * Canonical agent short name as it appears in AgentActivity.agentName.
   * Use this for DB lookups when the display `title` differs from the agent's
   * registered short (e.g. id=`parse` has title "ResumeParser + DupeCheck"
   * but canonical agentName is "ResumeParser"). Falls back to `title` when
   * absent.
   */
  agentName?: string;
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

// NOTE: `title` and `sub` use Chinese copy. WorkflowContent.tsx previously
// localized some `sub` values via `t("agent_*")`. After extraction, those
// values are inlined as zh-CN because this module is pure data (no React
// context, no useApp). The trade-off is acceptable per CLAUDE.md: agent
// names, customer names, and other mock-domain copy stay hardcoded;
// only true UI chrome goes through t(). Language toggle no longer
// translates these strings — that's by design.

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
  { id: "parse", kind: "agent", x: 1280, y: 240, title: "ResumeParser + DupeCheck", agentName: "ResumeParser", sub: "RESUME_PROCESSED / LOCKED_CONFLICT", icon: "cpu" },
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
