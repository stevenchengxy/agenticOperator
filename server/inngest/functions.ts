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

import { AGENT_MAP } from "@/lib/agent-mapping";
import { createStubAgent } from "./agents/stub-factory";
import { monitorAgent } from "./agents/monitor-agent";
import { managerAgent } from "./agents/manager-agent";

// Build a stub for every business agent that has at least one trigger event.
// Chatbot has triggersEvents=[] so it is naturally excluded.
const businessAgents = AGENT_MAP.filter(
  (a) => a.short !== "Chatbot" && a.triggersEvents.length > 0,
);

const stubFunctions = businessAgents
  .map(createStubAgent)
  .filter((fn): fn is NonNullable<typeof fn> => fn !== null);

// Behavior axis agents (Phase 1): Monitor Agent (cron) + Manager Agent (event-driven)
export const allFunctions = [...stubFunctions, monitorAgent, managerAgent];

// Server-side startup log so operators can confirm registration count.
if (typeof window === "undefined") {
  // eslint-disable-next-line no-console
  console.log(
    `[inngest] registered ${stubFunctions.length} stub agent functions + 2 behavior agents (monitor + manager)`,
  );
}
