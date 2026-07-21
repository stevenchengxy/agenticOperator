// Autonomous Harness Brain — shared types.
//
// The brain is a streaming ReAct loop: it reasons, calls tools, observes, loops.
// These are the streamed events (rendered live in the chatbot) + the tool
// contract (deterministic capabilities the brain orchestrates).

import type { DomainOntology } from "@/lib/ontology-generator/ontology-source";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import type { ToolRegistry } from "@/lib/tools/registry";

/** A generated agent, trimmed for the UI card. */
export type AgentCardLite = {
  slug: string;
  short: string;
  nameZh: string;
  trigger: string[];
  emit: string[];
  tools: string[];
  /** Tools the brain wanted but the pre-coded library doesn't have yet — shown
   *  as "待人工实现" so a human knows what to hand-code into the tools library. */
  unresolved?: string[];
};

/** One tool from the domain's library, trimmed for the UI + the brain to bind. */
export type ToolCardLite = {
  name: string;
  title: string;
  description: string;
  sideEffect: string;
  signature: string;
};

/** The LLM's authored design for one agent — surfaced in the chatbot as the
 *  per-agent "design reasoning" (collapsible), so the user sees the agent was
 *  genuinely reasoned out, not template-assembled. */
export type AgentDesignLite = {
  /** Why the LLM designed it this way (its reasoning for this agent). */
  reasoning: string;
  /** The system prompt the LLM authored for this agent. */
  systemPrompt: string;
  /** Why these tools were chosen. */
  toolRationale: string;
  /** Per-branch decision logic (what condition emits which event). */
  decisionLogic: string;
  /** A readable Inngest agent .ts rendering of this agent (specToAgentCode), so
   *  the chatbot can show the actual code — not just the spec — per agent. */
  code?: string;
  /** "ai" = the .ts was hand-written by the LLM (codegen_agent, TS-validated);
   *  "render" = deterministic specToAgentCode rendering. Shown as a badge. */
  codeSource?: "ai" | "render";
};

/** An explicit plan artifact the brain produces AFTER read_ontology and
 *  BEFORE per-agent design. Lets the brain decompose the problem once,
 *  reference the decomposition during design, and replan if validation
 *  / sandbox reveals the plan itself was wrong. */
export type BuildPlan = {
  /** 1-2 sentence summary of the approach. */
  summary: string;
  /** Per-agent plan entries in EXECUTION order (matches event chain). */
  agents: Array<{
    actionName: string;
    role: string;            // 1-line role description
    triggerEvents: string[]; // expected consumed events
    emitEvents: string[];    // expected produced events
    toolCandidates: string[]; // which library tools likely needed
    edgeCases: string[];     // explicit edge cases to handle
  }>;
  /** Cross-cutting concerns (shared edge cases, business rules, gotchas). */
  notes: string[];
  /** Plan version — incremented when create_plan is re-called after replanning. */
  version: number;
};

/** One revision attempt on a single agent. Stored in BrainCtx.attemptHistory
 *  so refine_agent can pass the prior spec + critique back to the LLM
 *  instead of blind-overwriting. */
export type RefineAttempt = {
  attemptNumber: number;
  ts: number;
  priorSpecSnapshot: {
    systemPrompt: string;
    tools: string[];
    decisionLogic?: string;
  };
  /** Why the prior was wrong (LLM-provided critique that triggered refine). */
  critique: string;
  /** What changes the LLM applied this round. */
  changes: string;
};

/** A reflection the brain wrote and persisted via analyze_failure. Loaded on
 *  next brain.start() for the same domain so the next run benefits. */
export type ReflectionLite = {
  kind: "failure" | "success" | "caveat";
  summary: string;
  rootCause?: string;
  lesson: string;
  createdAt: string;
};

/** A boundary event = an event some agent EMITS but no INTERNAL agent consumes.
 *  Instead of false-flagging it as a broken chain, the user classifies it (with the
 *  AI's suggestion): handed off to an EXTERNAL platform/service/team, a legitimate
 *  TERMINAL, or a real BREAK to fix. External handoffs carry a contract the downstream
 *  consumer can verify — that's the integration spec deploying onto Inngest needs. */
export type BoundaryEvent = {
  event: string;
  kind: "external" | "terminal" | "break";
  consumer?: string;        // external: which platform/service/team consumes it
  payloadContract?: string; // external: the payload the consumer should expect
  note?: string;
};

/** The AI's proposed classification for a dangling event, shown on the decision card
 *  for the user to confirm / adjust / supplement. */
export type BoundaryProposal = {
  event: string;
  suggestedKind: "external" | "terminal" | "break";
  why: string;
  producers: string[];      // which agents emit it
  consumer?: string;        // AI's guess at the external consumer (editable)
  payloadContract?: string; // AI's guess at the contract (editable)
};

/** A full-flow test case the brain authors (generate_test_cases) before the
 *  sandbox runs. Each case is a named scenario: an entry event + its payload that
 *  exercises ONE path of the event graph (happy / reject / edge), plus the
 *  outcome the brain expects. The user approves the set (执行) or asks for a
 *  re-roll (重新生成) before the sandbox fires them — so the sandbox proof shows
 *  real, reviewed inputs, not a hardcoded seed. */
export type TestCase = {
  id: string;
  name: string;
  /** 1-line human scenario, e.g. "资深 Java 候选人投递，应走到规则校验通过". */
  scenario: string;
  /** pass = happy path, reject = a rule/branch rejection, edge = missing/odd data. */
  kind: "pass" | "reject" | "edge";
  /** the entry event this case fires (bare name, no domain prefix). */
  entryEvent: string;
  /** the payload fired with the entry event (the input the chain reasons over). */
  payload: Record<string, unknown>;
  /** the terminal/outcome the brain expects this case to reach. */
  expectedOutcome: string;
};

/** ② One test case's behavioral verdict — did it reach the terminal its kind
 *  expects? Surfaced in the verification panel as a per-case ✓/✗. */
export type CaseResult = {
  name: string;
  kind: string;                   // pass | reject | edge
  expectedOutcome: string;
  reachedTerminal: string | null;
  isFailureTerminal: boolean;
  ok: boolean;
  detail: string;
};

/** One agent's REAL execution in a sandbox run, captured from the Postgres
 *  archive after settle — the input it consumed, what it did, what it emitted.
 *  This is the per-agent I/O the verification panel shows to prove a sandbox
 *  genuinely ran (real runId + real payloads, not a paper claim). */
export type AgentRunIO = {
  agentSlug: string;
  agentShort: string;
  status: string;            // Completed | Failed | …
  degraded: boolean;
  /** input: the event that triggered this agent + the payload it saw. */
  triggerEvent: string | null;
  inputPayload: Record<string, unknown> | null;
  /** what it did: the tools it called (names). */
  tools: string[];
  /** its decision: the event it emitted, why, and that event's payload. */
  outputEvent: string | null;
  reasoning: string;
  outputPayload: Record<string, unknown> | null;
  runId: string;
  url: string;
};

/** Streamed to the chatbot — the full live trace of the brain's reasoning + acts. */
export type BrainEvent =
  | { t: "think"; delta: string } // streamed reasoning token
  | { t: "tool.call"; id: string; name: string; reasoning: string; input: unknown }
  // #5: `output` carries the FULL tool output (capped generously) so the 活动日志 shows complete
  // I/O, not just the one-line summary. Optional — small tools may only set summary.
  | { t: "tool.result"; id: string; name: string; ok: boolean; summary: string; output?: string }
  | { t: "agent.created"; spec: AgentCardLite; design?: AgentDesignLite }
  | { t: "skill.created"; name: string; purpose: string }
  | { t: "tool.created"; name: string; description: string }
  | { t: "catalog"; tools: ToolCardLite[] } // the domain's tool library (from read_ontology)
  | { t: "web.result"; query: string; results: Array<{ title: string; url: string; snippet: string }> }
  | { t: "subagent.start"; task: string }
  | { t: "subagent.done"; task: string; summary: string }
  | { t: "validation"; ok: boolean; issues: string[]; agentIssueMap?: Record<string, unknown[]> }
  | { t: "sandbox"; ran: number; reachedTerminal: boolean; reachedSuccessTerminal?: boolean; agents: string[]; events: string[]; appId?: string; functionsRegistered?: number; deployed?: number; fullChainRan?: boolean; deployFailed?: boolean; degradedAgents?: string[]; missedAgents?: string[]; runUrls?: Array<{ runId: string; url: string; status: string; fn: string }>;
      /** Per-agent REAL input→output, captured from the archive after settle. The
       *  verification panel renders these to PROVE the sandbox ran (real I/O). */
      agentRuns?: AgentRunIO[];
      /** The use cases that were fired into this run (so the panel shows the input). */
      cases?: Array<{ name: string; entryEvent: string; payload: Record<string, unknown> }>;
      /** ② per-case behavioral verdicts (reached the terminal its kind expects?). */
      caseResults?: CaseResult[] }
  // Test cases the brain authored (generate_test_cases). When awaitingApproval is
  // true the conductor is PARKED waiting for the user's 执行/重新生成 decision.
  | { t: "test.cases"; cases: TestCase[]; awaitingApproval: boolean }
  // The user's decision on the proposed test cases (surfaced for the trace).
  | { t: "test.decision"; decision: "approve" | "regenerate"; note?: string }
  // #4 — ask_user HITL: the brain proactively asks the user a question (optionally with options)
  // mid-run and PARKS. awaitingAnswer=true → the conductor is parked; a follow-up event with the
  // same id + awaitingAnswer=false marks it resolved.
  | { t: "ask_user"; id: string; question: string; options?: Array<{ label: string; value: string }>; context?: string; awaitingAnswer: boolean }
  // Boundary events the brain proposes for the user to classify (external handoff /
  // terminal / break). awaitingDecision=true → the conductor is PARKED for the choice.
  | { t: "boundary.cases"; proposals: BoundaryProposal[]; awaitingDecision: boolean }
  // The classified boundary events after the user decided — surfaced as the recorded
  // external-event contracts + which (if any) are still real breaks to fix.
  | { t: "boundary.decided"; events: BoundaryEvent[] }
  | { t: "sandbox.progress"; phase: "deploying" | "deployed" | "firing" | "polling" | "settled"; detail?: string; eventsSoFar?: number; runsSoFar?: number }
  | { t: "gate"; reason: string }
  | { t: "plan"; plan: BuildPlan } // explicit plan artifact (P1-3)
  | { t: "refine"; actionName: string; attemptNumber: number; critique: string; diff?: { systemPromptChanged: boolean; toolsAdded: string[]; toolsRemoved: string[]; decisionLogicChanged: boolean } } // per-agent refinement (P0-3 + R2-4 diff)
  | { t: "inspect"; runId: string; agentSlug: string; status: string; degraded?: boolean; error?: string } // diagnostic finding (P0-1)
  | { t: "reflect"; kind: string; lesson: string } // persisted reflection (P1-4)
  | { t: "budget"; turn: number; maxTurns: number; tokens: number; maxTokens: number | null; specsBuilt: number; sandboxRuns?: number; level?: "ok" | "elevated" | "high"; costNote?: string } // R2-5 budget hint + COST METER (soft level, NOT a hard cap — user vetoed caps)
  | { t: "score.delta"; actionName: string; attemptNumber: number; priorTotal: number; newTotal: number; delta: number; regression: boolean; dimensions: { toolResolution: number; promptRichness: number; decisionCoverage: number; refineHealth: number }; priorDimensions: { toolResolution: number; promptRichness: number; decisionCoverage: number; refineHealth: number } } // R4-1
  | { t: "revert"; actionName: string; revertedToAttempt: number } // R4-2
  | { t: "message"; text: string } // the brain's narration / final answer
  // #2d — auto-compaction made VISIBLE: `summary` is the one-line notice, `state` is the full
  // folded snapshot (rendered behind an expand toggle so the user can see what was compacted).
  | { t: "compaction"; summary: string; state: string }
  // #7 — which model served this turn + the difficulty tier it was routed to (annotated per step
  // in the activity log). The router picks fast/default/hard from live context; config-driven.
  | { t: "model"; model: string; tier: string; turn: number }
  // `status` is the honest terminal verdict. Only "finished" (the brain called
  // finish and it PASSED the acceptance gate) is success; every other value is a
  // failed/incomplete run — the route maps them to a failed FactoryBrainRun so a
  // budget/turn-exhausted or errored run never reads as success.
  | { t: "done"; tokensUsed: number; turns: number; status: "finished" | "budget_exhausted" | "turns_exhausted" | "errored" | "incomplete" }
  | { t: "error"; message: string };

export type BrainEmit = (e: BrainEvent) => void;

export interface BrainToolResult {
  ok: boolean;
  /** one-line result the model sees + the UI shows */
  summary: string;
  /** structured payload fed back to the model as the tool result */
  output?: unknown;
}

export interface BrainCtx {
  domain: string;
  goal: string;
  emit: BrainEmit;
  /** accumulated generated specs (write_agent appends here) */
  specs: GeneratedAgentSpec[];
  /** cached after read_ontology */
  ontology: DomainOntology | null;
  registry: ToolRegistry | null;
  /** skills the brain authored this run (woven into generated agents) */
  createdSkills: Array<{ name: string; purpose: string; promptFragment: string; tools: string[]; decisionRule: string }>;
  /** facts the brain gathered via web_search (fed into agent prompts as grounding) */
  research: Array<{ query: string; findings: string }>;
  budget: { maxTokens: number | null; maxTurns: number };
  /** P1-2 (audit MAJOR): sandboxRuns is the REAL global churn budget — the cost
   *  blows up on sandbox deploys + tokens, not turn count. MAX_TURNS alone makes the
   *  worst case a timeout, not convergence. */
  spent: { tokens: number; turns: number; sandboxRuns: number };

  // ── upgraded intelligence state ─────────────────────────────────────────
  /** Explicit BuildPlan artifact (P1-3). Set by create_plan; read by
   *  design_agent / refine_agent for cross-agent consistency; can be
   *  re-written if validation/sandbox reveals the plan itself was wrong. */
  currentPlan: BuildPlan | null;
  /** Per-action refinement history (P0-3). Each time refine_agent is called,
   *  the prior spec snapshot + LLM critique go here, so the next refine pass
   *  sees the FULL improvement trajectory, not just the current spec. */
  attemptHistory: Record<string, RefineAttempt[]>;
  /** Last sandbox_run's deployed version + ran-agent slugs. inspect_run uses
   *  this to know which Inngest runs to query without the brain having to
   *  remember runIds across turns. */
  lastSandboxRunIds: string[];
  lastSandboxVersionLabel: string | null;
  /** RANK-1 (verifier-in-the-loop): the OUTCOME of the last sandbox_run, kept as a
   *  first-class result so the finish gate can REQUIRE a real end-to-end run
   *  (not just static graph closure). `specsFingerprint` ties the evidence to the
   *  exact specs that ran — design/refine/revert clear this so a changed spec
   *  can't finish on stale-green evidence. */
  lastSandbox: {
    specsFingerprint: string; // hash of specs' slug+trigger+emit+codeSource at run time
    deployed: number;         // functions registered
    agentsRan: number;        // distinct agent functions that actually executed
    ranAgents: string[];
    reachedTerminal: boolean;
    /** reached a SUCCESS terminal (a non-failure workflow leaf) — not just any
     *  terminal. fullChainRan now requires THIS (don't equate terminal w/ success). */
    reachedSuccessTerminal: boolean;
    fullChainRan: boolean;    // !partial && reachedSuccessTerminal && no degraded
    partial: boolean;
    /** agents whose decision was a degraded fallback (gateway down) — a chain that
     *  only advanced on these is NOT verified; the finish gate rejects it. */
    degradedAgents: string[];
    ts: number;
  } | null;
  /** RANK-5 (human-in-the-loop): authoritative directives a human injected mid-run.
   *  Surfaced in buildStateSummary so they survive compaction. */
  humanDirectives: string[];
  /** Last validate_graph result with agent backref. refine_agent reads
   *  agentIssueMap[slug] to know what to fix. */
  lastValidation: { agentIssueMap: Record<string, unknown[]>; ok: boolean } | null;
  /** Reflections loaded on brain.start from prior runs of this domain.
   *  Injected into the system prompt as "lessons from prior runs". */
  priorReflections: ReflectionLite[];
  /** R4-3: per-agent-action relevance-matched rules from read_ontology. Used
   *  by design_agent / refine_agent to weave mandatory rules into the deployed
   *  agent's runtime prompt. Map<actionName, rules[]>. */
  rulesByAction: Record<string, Array<{ id: string; name: string; rule: string; enforcement: string; failurePolicy: string }>>;
  /** Fix #2: per-action catalog tools pre-matched from the real library
   *  (suggestToolsForAction). Surfaced to the brain in read_ontology as
   *  `suggested_tools`, and used by design_agent / refine_agent as a FLOOR so a
   *  generated agent binds real tools even when the LLM invents names that don't
   *  resolve. Map<actionName, toolName[]>. */
  suggestedToolsByAction: Record<string, string[]>;
  /** Sandbox deploy lifecycle: the DEDICATED sandbox domain (→ Inngest app
   *  `agentic-operator-sandbox-<domain>`) whose agents are currently deployed for
   *  testing. sandbox_run deploys there (NOT to the real domain's app) and sets
   *  this; the functions stay live + visible through the whole session; the
   *  conductor TEARS DOWN the sandbox app once the session ends. The real
   *  domain's Fleet drafts are separate + untouched. */
  pendingSandboxDomain?: string | null;
  /** P2 (audit): the run id + abort signal, so long tools (sandbox_run) can peek the
   *  mailbox to bail early, and spawn_subagent can forward the abort signal so a
   *  client disconnect cascades to sub-brains instead of leaving them running. */
  runId?: string;
  signal?: AbortSignal;
  /** Feature 2 (test-case verification): the brain-authored use cases for the
   *  NEXT sandbox_run. generate_test_cases writes them; sandbox_run fires them
   *  (instead of a hardcoded seed). Survives compaction (plain JSON on ctx). */
  testCases?: TestCase[];
  /** True while the conductor is PARKED waiting for the user's 执行/重新生成
   *  decision on the proposed test cases. The loop polls the mailbox instead of
   *  streaming a turn until a `[测试用例决策…]` message arrives. */
  awaitingApproval?: boolean;
  /** Boundary-event handling: events with no internal consumer that the user has
   *  CLASSIFIED (external handoff / terminal / break). validateSpecs / the finish gate
   *  honor external + terminal ones so they're not false-flagged as broken chains. */
  boundaryEvents?: BoundaryEvent[];
  /** True while the conductor is PARKED for the user's boundary-event decision
   *  (a `[边界事件决策…]` message). */
  awaitingBoundary?: boolean;
  /** The proposals currently awaiting decision — kept so a park TIMEOUT can
   *  auto-apply them with the AI's suggested kinds. Cleared on decision/timeout. */
  boundaryProposals?: BoundaryProposal[];
  /** #4 (ask_user HITL): true while the conductor is PARKED waiting for the user's answer to a
   *  brain-posed question; pendingAsk holds it so a park timeout / resume can proceed. */
  awaitingAsk?: boolean;
  pendingAsk?: { id: string; question: string; options?: Array<{ label: string; value: string }> };
}

export interface BrainTool {
  name: string;
  description: string;
  /** JSON schema for the args. MUST include a `reasoning` string so the model
   *  articulates WHY before acting (gemini emits no content before tool calls,
   *  so this is how the chatbot shows visible reasoning). */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: BrainCtx): Promise<BrainToolResult>;
}
