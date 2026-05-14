// AO-main Inngest function registry.
//
// Generates a stub Inngest function for every business agent in AGENT_MAP so
// that test events (Send Test Event → REQUIREMENT_LOGGED etc.) produce real
// cascading activity visible in Overview / Fleet / Monitor / Events / Inbox.
//
// Each stub:
//   · registers on the agent's triggersEvents
//   · writes WorkflowRun + AgentActivity via agent-logger
//   · handles HITL (creates HumanTask, auto-resolves after STUB_HITL_DELAY_MS)
//   · emits the agent's next event(s) via em.publish with _runId propagated
//
// Env gates:
//   STUB_AGENTS=0        — disable stubs (e.g. when running real agent runtimes)
//   STUB_SUCCESS_RATE    — default 0.9  (90 % take the happy path)
//   STUB_HITL_DELAY_MS   — default 5000 (HITL auto-resolves after 5 s for demo)
//   STUB_RPA_OWNED=1     — include stubs for RPA-owned wsIds (default OFF)
//                          Use only in dev/testing isolation; in production the
//                          real resume-parser-agent handles these events.

import { AGENT_MAP } from "@/lib/agent-mapping";
import { createStubAgent } from "./agents/stub-factory";
import { monitorAgent } from "./agents/monitor-agent";
import { managerAgent } from "./agents/manager-agent";

// Real production agents (live in resume-parser-agent/). They're authored
// against RPA's own Inngest client instance (app id "agentic-operator"),
// but since we serve through AO-main's /api/inngest route, importing them
// here also exposes them to the Inngest dev server so all 24 functions
// (19 stub + 2 behavior + 3 real) show up in a single dashboard.
//
// IMPORTANT: when RPA is ALSO running as a separate process (port 3020),
// it serves the same function set under its own /api/inngest route. The
// Inngest dev server treats them as distinct apps, but both subscribe to
// the same event names. To avoid double-handling in that scenario, run
// only one side (or set STUB_AGENTS=0 + disable RPA serve). For local dev
// where RPA isn't running, this is the only way to see the real handlers.
import { resumeParserAgent } from "@/resume-parser-agent/lib/inngest/functions/resume-parser-agent";
import { createJdAgent } from "@/resume-parser-agent/lib/inngest/agents/create-jd-agent";
import { matchResumeAgent } from "@/resume-parser-agent/lib/inngest/agents/match-resume-agent";

// wsIds with real Inngest agents in resume-parser-agent (RPA).
// AO-main must NOT register stubs for these — doing so would cause both the
// stub AND the real agent to run on the same trigger event (race condition).
const RPA_OWNED_WSIDS = new Set(["4", "9-1", "10"]);

// Set STUB_RPA_OWNED=1 to re-enable stubs for these wsIds (dev/isolation testing).
const STUB_RPA_OWNED = process.env.STUB_RPA_OWNED === "1";

// Build a stub for every business agent that has at least one trigger event.
// Chatbot has triggersEvents=[] so it is naturally excluded.
// RPA-owned wsIds are skipped by default to avoid racing real agents.
const businessAgents = AGENT_MAP.filter((a) => {
  if (a.short === "Chatbot") return false;
  if (a.triggersEvents.length === 0) return false;
  if (!STUB_RPA_OWNED && RPA_OWNED_WSIDS.has(a.wsId)) return false;
  return true;
});

const stubFunctions = businessAgents
  .map(createStubAgent)
  .filter((fn): fn is NonNullable<typeof fn> => fn !== null);

// Behavior axis agents (Phase 1): Monitor Agent (cron) + Manager Agent (event-driven)
const behaviorFunctions = [monitorAgent, managerAgent];

// Real production agents from resume-parser-agent — the 3 functions that
// actually call RAAS / LLM / MinIO. Their wsIds (4, 9-1, 10) are excluded
// from stub generation above so they don't double-handle events.
const realFunctions = [resumeParserAgent, createJdAgent, matchResumeAgent];

export const allFunctions = [
  ...stubFunctions,
  ...behaviorFunctions,
  ...realFunctions,
];

// Server-side startup log so operators can confirm registration count.
if (typeof window === "undefined") {
  // eslint-disable-next-line no-console
  console.log(
    `[inngest] registered ${stubFunctions.length} stub + ${behaviorFunctions.length} behavior + ${realFunctions.length} real agents = ${allFunctions.length} total`,
  );
}
