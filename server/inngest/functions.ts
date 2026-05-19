// AO-main Inngest function registry.
//
// p4 merge (kenny/steven 2026-05): 原 resume-parser-agent (port 3020) 的
// 3 个 agent 文件被搬进 server/inngest/agents/。Inngest dev server 至此
// 只同步一个 SDK 端点，所有 functions 在一个 dashboard 里看见。
//
// 主链路（real production agents 4 个）:
//   REQUIREMENT_LOGGED   → createJdAgent       → JD_GENERATED
//   RESUME_DOWNLOADED    → resumeParserAgent   → RESUME_PROCESSED
//   RESUME_PROCESSED     → matchResumeAgent (1st) → RULE_CHECK_REQUESTED
//   RULE_CHECK_REQUESTED → ruleCheckAgent   → RULE_CHECK_PASSED / RULE_CHECK_FAILED
//   RULE_CHECK_PASSED    → matchResumeAgent (2nd) → MATCH_PASSED_NEED_INTERVIEW
//
// 演示用 stub agent（19 个，可选）—— 给 fleet / workflow 可视化页面提供
// 模拟数据流。Stub 收事件 → 写 AgentActivity → sleep → emit 下游事件 →
// HITL 节点 5s 后自动 resolve。default OFF for v0_1_010；要开演示设
// STUB_AGENTS=1。
//
// Behavior 轴（2 个）—— Monitor Agent cron 检测异常 + Manager Agent 决策
// 响应。default OFF for v0_1_010；要开设 BEHAVIOR_AGENTS=1。
//
// Env gates:
//   STUB_AGENTS=1        — 开启 19 个 stub agents（默认 0，只跑 3 real）
//   STUB_SUCCESS_RATE    — default 0.9（90% take happy path）
//   STUB_HITL_DELAY_MS   — default 5000ms（HITL auto-resolve delay）
//   STUB_RPA_OWNED=1     — 让 stub-factory 也为 wsId 4/9-1/10 生成 stub
//                          （会跟 real agent 抢同名事件，仅 dev 隔离测试用）
//   BEHAVIOR_AGENTS=1    — 开启 Monitor + Manager Agent（默认 0）

import { AGENT_MAP } from "@/lib/agent-mapping";
import { createStubAgent } from "./agents/stub-factory";
import { monitorAgent } from "./agents/monitor-agent";
import { managerAgent } from "./agents/manager-agent";

// Real production agents — 3 functions that actually call RAAS / LLM /
// MinIO. Live in server/inngest/agents/ after kenny/steven's RPA merge.
import { resumeParserAgent } from "./agents/resume-parser-agent";
import { createJdAgent } from "./agents/create-jd-agent";
import { matchResumeAgent } from "./agents/match-resume-agent";
import { ruleCheckAgent } from "./agents/rule-check-agent";  // NEW PR-4

// wsIds owned by the real agents above. Stub-factory MUST skip these to
// avoid double-handling of trigger events (race condition).
const RPA_OWNED_WSIDS = new Set(["4", "9-1", "10"]);

// Set STUB_RPA_OWNED=1 to re-enable stubs for these wsIds (dev/isolation).
const STUB_RPA_OWNED = process.env.STUB_RPA_OWNED === "1";

// ★ v0_1_010 defaults: only the 3 real agents register. To restore the
// fleet / workflow demo flows, set STUB_AGENTS=1 (and BEHAVIOR_AGENTS=1
// for Monitor + Manager cron / decision agents).
const STUB_AGENTS_ENABLED = process.env.STUB_AGENTS === "1";
const BEHAVIOR_AGENTS_ENABLED = process.env.BEHAVIOR_AGENTS === "1";

// Build a stub per business agent with at least one trigger event.
// Chatbot has triggersEvents=[] so it is naturally excluded.
const businessAgents = AGENT_MAP.filter((a) => {
  if (a.short === "Chatbot") return false;
  if (a.triggersEvents.length === 0) return false;
  if (!STUB_RPA_OWNED && RPA_OWNED_WSIDS.has(a.wsId)) return false;
  return true;
});

const stubFunctions = STUB_AGENTS_ENABLED
  ? businessAgents
      .map(createStubAgent)
      .filter((fn): fn is NonNullable<typeof fn> => fn !== null)
  : [];

const behaviorFunctions = BEHAVIOR_AGENTS_ENABLED
  ? [monitorAgent, managerAgent]
  : [];

const realFunctions = [resumeParserAgent, createJdAgent, matchResumeAgent, ruleCheckAgent];

export const allFunctions = [
  ...realFunctions,
  ...stubFunctions,
  ...behaviorFunctions,
];

// Server-side startup log so operators can confirm registration count.
if (typeof window === "undefined") {
  // eslint-disable-next-line no-console
  console.log(
    `[inngest] registered ${realFunctions.length} real + ${stubFunctions.length} stub + ${behaviorFunctions.length} behavior = ${allFunctions.length} total ` +
      `(STUB_AGENTS=${STUB_AGENTS_ENABLED ? "1" : "0"} BEHAVIOR_AGENTS=${BEHAVIOR_AGENTS_ENABLED ? "1" : "0"})`,
  );
}
