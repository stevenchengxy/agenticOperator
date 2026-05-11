// AO-main Inngest function registry.
//
// p4 合并后(原 resume-parser-agent 端口 3020 合进主仓 3002),3 个 agent
// 直接挂在这里。Inngest dev server 自此只需要同步一个 SDK 端点。
//
// 链路:
//   REQUIREMENT_LOGGED → createJdAgent       → JD_GENERATED
//   RESUME_DOWNLOADED  → resumeParserAgent   → RESUME_PROCESSED
//   RESUME_PROCESSED   → matchResumeAgent    → (RULE_CHECK_* if gated) →
//                                              MATCH_PASSED_NEED_INTERVIEW

import { createJdAgent } from "./agents/create-jd-agent";
import { matchResumeAgent } from "./agents/match-resume-agent";
import { resumeParserAgent } from "./agents/resume-parser-agent";

export const allFunctions = [
  resumeParserAgent,
  createJdAgent,
  matchResumeAgent,
];
