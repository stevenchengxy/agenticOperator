import type { IcName } from '@/components/shared/Ic';

// ─── Graph mirrors real AGENT_MAP topology ────────────────────────────────────
//
// 22 nodes (23 AGENT_MAP entries minus Chatbot which is system-meta) plus a
// single synthetic `trig` node representing the external system trigger.
// HITL fallback agents are placed below/offset from their parent nodes.
// Edges carry eventName so /api/monitor/overview/route.ts needs no local lookup.
//
// ViewBox: 1920×720 — extra canvas gives breathing room for HITL branches.
//
// Layout overview (left-to-right main path, fallbacks below/offset):
//
//   Row A (y=100): trig → reqSync → reqAnalyzer → clarifier → jdGenerator
//                 → jdReviewer → taskAssigner → publisher → resumeCollector
//                 → resumeParser → matcher
//
//   Row B (y=280): matcher branches →
//                 interviewInviter → aiInterviewer → evaluator → resumeRefiner
//                 → packageBuilder → packageReviewer → portalSubmitter
//
//   HITL offsets:
//     manualEntry    (x=540,  y=520) — fallback for Clarifier
//     manualPublish  (x=1180, y=280) — fallback for Publisher
//     resumeFixer    (x=1500, y=280) — fallback for ResumeParser
//     matchReviewer  (x=1660, y=460) — terminal fallback for Matcher MATCH_FAILED
//     packageFiller  (x=760,  y=460) — fallback for PackageBuilder
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
   * Only set when the display `title` differs from the agent's registered short.
   * Falls back to `title` when absent.
   */
  agentName?: string;
};

export type WorkflowEdge = {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  /** Inngest event name flowing along this edge. Populated for all non-dashed edges
   *  and most dashed edges. Empty string = no specific event (e.g., guard → submit). */
  eventName?: string;
};

// 1920×720 viewBox — expanded for 22-agent layout with HITL branches.
export const GRAPH_VIEWBOX = '0 0 1920 720' as const;
export const GRAPH_WIDTH = 1920 as const;
export const GRAPH_HEIGHT = 720 as const;

// ── NODES ─────────────────────────────────────────────────────────────────────
// Row A (y=100): main success path left-to-right
// Row B (y=300): post-matching path (interview → eval → refine → package → submit)
// HITL nodes: offset below/aside their parent

export const NODES: WorkflowNode[] = [
  // ── Trigger (synthetic) ──────────────────────────────────────────────────
  { id: "trig",           kind: "trigger", x: 60,   y: 100, title: "定时同步 / Webhook",  sub: "SCHEDULED_SYNC · 客户 RMS",                           icon: "bolt"    },

  // ── Row A: main path ─────────────────────────────────────────────────────
  { id: "reqSync",        kind: "agent",   x: 220,  y: 100, title: "ReqSync",             sub: "需求同步 → REQUIREMENT_SYNCED",                        icon: "db"      },
  { id: "reqAnalyzer",    kind: "agent",   x: 400,  y: 100, title: "ReqAnalyzer",         sub: "需求分析 → ANALYSIS_COMPLETED",                        icon: "sparkle" },
  { id: "clarifier",      kind: "agent",   x: 580,  y: 100, title: "Clarifier",           sub: "需求澄清 → CLARIFICATION_READY",                       icon: "sparkle" },
  { id: "jdGenerator",    kind: "agent",   x: 760,  y: 100, title: "JDGenerator",         sub: "JD 生成 → JD_GENERATED",                               icon: "sparkle" },
  { id: "jdReviewer",     kind: "hitl",    x: 940,  y: 100, title: "JDReviewer",          sub: "JD 审批 → JD_APPROVED / JD_REJECTED",                  icon: "shield"  },
  { id: "taskAssigner",   kind: "agent",   x: 1120, y: 100, title: "TaskAssigner",        sub: "任务分配 → TASK_ASSIGNED",                             icon: "cpu"     },
  { id: "publisher",      kind: "agent",   x: 1300, y: 100, title: "Publisher",           sub: "多渠道发布 → CHANNEL_PUBLISHED",                       icon: "plug"    },
  { id: "resumeCollector",kind: "agent",   x: 1500, y: 100, title: "ResumeCollector",     sub: "简历采集 → RESUME_DOWNLOADED",                         icon: "db"      },
  { id: "resumeParser",   kind: "agent",   x: 1700, y: 100, title: "ResumeParser",        sub: "简历解析 → RESUME_PROCESSED",                          icon: "cpu"     },
  { id: "matcher",        kind: "agent",   x: 1860, y: 100, title: "Matcher",             sub: "人岗匹配 → MATCH_PASSED / MATCH_FAILED",               icon: "sparkle" },

  // ── HITL fallbacks (row between A and B) ─────────────────────────────────
  { id: "manualPublish",  kind: "hitl",    x: 1300, y: 280, title: "ManualPublish",       sub: "手动发布 → CHANNEL_PUBLISHED",                         icon: "user"    },
  { id: "resumeFixer",    kind: "hitl",    x: 1700, y: 280, title: "ResumeFixer",         sub: "手动修复 → RESUME_PROCESSED",                          icon: "user"    },

  // ── Row B: post-matching path ─────────────────────────────────────────────
  { id: "interviewInviter",kind:"agent",   x: 1860, y: 300, title: "InterviewInviter",    sub: "面试邀约 → INTERVIEW_INVITATION_SENT",                  icon: "mail"    },
  { id: "aiInterviewer",  kind: "agent",   x: 1680, y: 460, title: "AIInterviewer",       sub: "AI 面试 → AI_INTERVIEW_COMPLETED",                     icon: "sparkle" },
  { id: "evaluator",      kind: "agent",   x: 1500, y: 460, title: "Evaluator",           sub: "面试评估 → EVALUATION_PASSED / FAILED",                icon: "cpu"     },
  { id: "resumeRefiner",  kind: "agent",   x: 1300, y: 460, title: "ResumeRefiner",       sub: "简历优化 → RESUME_OPTIMIZED",                          icon: "sparkle" },
  { id: "packageBuilder", kind: "agent",   x: 1100, y: 460, title: "PackageBuilder",      sub: "推荐包生成 → PACKAGE_GENERATED",                       icon: "book"    },
  { id: "packageReviewer",kind: "hitl",    x: 900,  y: 460, title: "PackageReviewer",     sub: "推荐包审核 → PACKAGE_APPROVED",                        icon: "shield"  },
  { id: "portalSubmitter",kind: "agent",   x: 700,  y: 460, title: "PortalSubmitter",     sub: "客户端提交 → APPLICATION_SUBMITTED",                   icon: "mail"    },

  // ── HITL fallbacks (below B) ──────────────────────────────────────────────
  { id: "manualEntry",    kind: "hitl",    x: 580,  y: 580, title: "ManualEntry",         sub: "手工录入 → REQUIREMENT_LOGGED",                        icon: "user"    },
  { id: "matchReviewer",  kind: "hitl",    x: 1860, y: 580, title: "MatchReviewer",       sub: "匹配复审 (HITL)",                                      icon: "user"    },
  { id: "packageFiller",  kind: "hitl",    x: 1100, y: 620, title: "PackageFiller",       sub: "推荐包补全 → PACKAGE_GENERATED",                       icon: "user"    },
];

// ── EDGES ─────────────────────────────────────────────────────────────────────
// eventName = the Inngest event that flows along this edge.
// dashed = exception / fallback path.

export const EDGES: WorkflowEdge[] = [
  // System trigger → ReqSync
  { from: "trig",            to: "reqSync",          eventName: "SCHEDULED_SYNC"              },

  // ReqSync → ReqAnalyzer
  { from: "reqSync",         to: "reqAnalyzer",       eventName: "REQUIREMENT_SYNCED"          },

  // ManualEntry → ReqAnalyzer (HITL re-entry)
  { from: "manualEntry",     to: "reqAnalyzer",       eventName: "REQUIREMENT_LOGGED",          dashed: true },

  // ReqAnalyzer → Clarifier
  { from: "reqAnalyzer",     to: "clarifier",         eventName: "ANALYSIS_COMPLETED"          },

  // Clarifier → ManualEntry (info missing → HITL)
  { from: "clarifier",       to: "manualEntry",       eventName: "CLARIFICATION_INCOMPLETE",    dashed: true, label: "缺失" },

  // Clarifier → JDGenerator (happy path)
  { from: "clarifier",       to: "jdGenerator",       eventName: "CLARIFICATION_READY"         },

  // JDGenerator → JDReviewer
  { from: "jdGenerator",     to: "jdReviewer",        eventName: "JD_GENERATED"                },

  // JDReviewer → JDGenerator (rejected — regenerate)
  { from: "jdReviewer",      to: "jdGenerator",       eventName: "JD_REJECTED",                 dashed: true, label: "重写" },

  // JDReviewer → TaskAssigner (approved)
  { from: "jdReviewer",      to: "taskAssigner",      eventName: "JD_APPROVED"                 },

  // TaskAssigner → Publisher
  { from: "taskAssigner",    to: "publisher",         eventName: "TASK_ASSIGNED"               },

  // Publisher → ResumeCollector (success)
  { from: "publisher",       to: "resumeCollector",   eventName: "CHANNEL_PUBLISHED"           },

  // Publisher → ManualPublish (publish failed)
  { from: "publisher",       to: "manualPublish",     eventName: "CHANNEL_PUBLISHED_FAILED",    dashed: true, label: "发布失败" },

  // ManualPublish → ResumeCollector (manual recovery)
  { from: "manualPublish",   to: "resumeCollector",   eventName: "CHANNEL_PUBLISHED",           dashed: true },

  // ResumeCollector → ResumeParser
  { from: "resumeCollector", to: "resumeParser",      eventName: "RESUME_DOWNLOADED"           },

  // ResumeParser → Matcher (success)
  { from: "resumeParser",    to: "matcher",           eventName: "RESUME_PROCESSED"            },

  // ResumeParser → ResumeFixer (parse failed)
  { from: "resumeParser",    to: "resumeFixer",       eventName: "RESUME_PARSE_ERROR",          dashed: true, label: "解析失败" },

  // ResumeFixer → Matcher (manual recovery)
  { from: "resumeFixer",     to: "matcher",           eventName: "RESUME_PROCESSED",            dashed: true },

  // Matcher → InterviewInviter (needs interview)
  { from: "matcher",         to: "interviewInviter",  eventName: "MATCH_PASSED_NEED_INTERVIEW", label: "需面试" },

  // Matcher → ResumeRefiner (no interview needed)
  { from: "matcher",         to: "resumeRefiner",     eventName: "MATCH_PASSED_NO_INTERVIEW",   label: "免面" },

  // Matcher → MatchReviewer (failed match — HITL review)
  { from: "matcher",         to: "matchReviewer",     eventName: "MATCH_FAILED",                dashed: true, label: "不符" },

  // InterviewInviter → AIInterviewer
  { from: "interviewInviter",to: "aiInterviewer",     eventName: "INTERVIEW_INVITATION_SENT"   },

  // AIInterviewer → Evaluator
  { from: "aiInterviewer",   to: "evaluator",         eventName: "AI_INTERVIEW_COMPLETED"      },

  // Evaluator → ResumeRefiner (passed)
  { from: "evaluator",       to: "resumeRefiner",     eventName: "EVALUATION_PASSED"           },

  // ResumeRefiner → PackageBuilder
  { from: "resumeRefiner",   to: "packageBuilder",    eventName: "RESUME_OPTIMIZED"            },

  // PackageBuilder → PackageFiller (missing info)
  { from: "packageBuilder",  to: "packageFiller",     eventName: "PACKAGE_MISSING_INFO",        dashed: true },

  // PackageFiller → PackageReviewer (filled, re-join)
  { from: "packageFiller",   to: "packageReviewer",   eventName: "PACKAGE_GENERATED",           dashed: true },

  // PackageBuilder → PackageReviewer (complete)
  { from: "packageBuilder",  to: "packageReviewer",   eventName: "PACKAGE_GENERATED"           },

  // PackageReviewer → PortalSubmitter
  { from: "packageReviewer", to: "portalSubmitter",   eventName: "PACKAGE_APPROVED"            },
];

const NODE_BY_ID = new Map(NODES.map(n => [n.id, n]));
export function nodeById(id: string): WorkflowNode | undefined {
  return NODE_BY_ID.get(id);
}
