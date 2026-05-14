// AO-main Inngest function registry.
//
// 链路:
//   REQUIREMENT_LOGGED → createJdAgent       → JD_GENERATED
//   RESUME_DOWNLOADED  → resumeParserAgent   → RESUME_PROCESSED
//   RESUME_PROCESSED   → matchResumeAgent    → RULE_CHECK_* / MATCH_*
//
// 简历缺字段补全:
//   AO matchResumeAgent emit RESUME_INFO_MISSING → partner HITL recruiter 表单
//   recruiter 填完 → partner 直接重发 RESUME_PROCESSED(带 enrichment_applied.parent_audit_id)
//   → matchResumeAgent 重跑(同一代码路径,无需 AO 端中间 handler)

import { createJdAgent } from "./agents/create-jd-agent";
import { matchResumeAgent } from "./agents/match-resume-agent";
import { resumeParserAgent } from "./agents/resume-parser-agent";

export const allFunctions = [
  resumeParserAgent,
  createJdAgent,
  matchResumeAgent,
];
