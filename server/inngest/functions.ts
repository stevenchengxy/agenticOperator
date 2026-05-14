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
export const allFunctions = [...stubFunctions, monitorAgent, managerAgent];

// Server-side startup log so operators can confirm registration count.
if (typeof window === "undefined") {
  // eslint-disable-next-line no-console
  console.log(
    `[inngest] registered ${stubFunctions.length} stub agent functions (${RPA_OWNED_WSIDS.size} RPA-owned wsIds skipped) + 2 behavior agents (monitor + manager)`,
  );
}
