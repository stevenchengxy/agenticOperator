// Declarative agent spec produced by the factory. Maps 1:1 onto the runtime
// `DerivedAgent` consumed by makeOntologyAgent — but is the factory's own,
// richer artifact (carries tool bindings, steps, validation-relevant fields).

export interface GeneratedStep {
  name: string;
  description: string;
  /** registry tool this step calls, if any */
  tool?: string;
}

// "ontology" = action carried a system_prompt; "ontology-desc" = seeded from the
// action's rich `description` (live actions have description, not system_prompt).
export type PromptSource = "llm" | "ontology" | "ontology-desc" | "fallback";

// ── Agent-Loop (reflexion) refinement records ─────────────────────────────────
// The factory drafts a prompt, then a critic LLM scores it against the ontology
// grounding and a reviser rewrites it — a small bounded generate→critique→revise
// loop. These types capture that self-improvement so it can be streamed + stored.
export interface PromptIssue {
  severity: "high" | "med" | "low";
  /** which rubric dimension the issue belongs to */
  dim: "coverage" | "tools" | "events" | "json" | "rules" | "role";
  what: string;
  fix: string;
}
export interface PromptCritique {
  score: number; // 0..1
  issues: PromptIssue[];
}
export interface RefinementRound {
  iteration: number; // 1-based
  score: number; // critic score of the draft entering this round
  issues: PromptIssue[];
  revised: boolean; // whether a non-empty rewrite was applied
}
export interface PromptRefinement {
  iterations: number; // critique→revise rounds actually run (0 = skipped)
  finalScore: number; // best score observed (0..1); 0 when no critic ran
  issuesFixed: number; // sum of actionable issues across rounds that triggered a rewrite
  converged: boolean; // stopped because score≥threshold or no new issues
  skipped: boolean; // loop didn't run (gateway down / empty critique / non-llm draft)
  history: RefinementRound[];
}

/** A declarative human-in-the-loop gate descriptor, attached to specs derived
 *  from Human-actor actions (mirrors the energy domain's GateRequest, but
 *  serializable). The executor pauses on `decisionEvent` instead of auto-deciding. */
export interface HitlGate {
  gateKey: string;
  eventNs: string;
  decisionEvent: string; // `<ns>/HUMAN_DECISION`
  emitOnDecision: Record<string, string>; // decision verb -> emit event (optional map)
  defaultEmit?: string;
  title: string;
  body: string;
}

/** How the executor sequences this agent's tools.
 *  - "parallel": run all tool-bound steps up-front, then decide once (default).
 *  - "sequential-react": reason→pick one tool→observe→repeat→emit (ReAct), for
 *    agents whose tool ordering is data-dependent. */
export type ToolFlow = "parallel" | "sequential-react";

export interface GeneratedAgentSpec {
  /** stable selection id = ontology action name (PK) */
  key: string;
  actionName: string;
  /** `${domainPrefix}-${kebab(actionName)}` — Inngest fn id + AgentVersion.slug */
  slug: string;
  /** `${Pascal(actionName)}Agent` */
  short: string;
  domainId: string;
  nameZh: string;
  kind: "llm" | "simulated-human";
  /** consumed events */
  trigger: string[];
  /** emitted events */
  emit: string[];
  /** registry tool names — the generation-time scoped toolbox */
  tools: string[];
  /** tool_use[] entries that didn't resolve to a registry tool (human review) */
  unresolvedTools: string[];
  /** target_objects */
  objects: string[];
  systemPrompt: string;
  userPrompt: string;
  /** the brain's design reasoning + tool rationale + per-branch decision logic it
   *  authored in design_agent. Stored on the spec so later re-emits (codegen /
   *  refine / revert) can show the REAL content instead of a placeholder. */
  designReasoning?: string;
  toolRationale?: string;
  decisionLogic?: string;
  steps: GeneratedStep[];
  ruleRefs: string[];
  retries: number;
  hitl: boolean;
  confidence: number;
  promptSource: PromptSource;
  /** present only when the reflexion loop ran (useLlm + reachable gateway) */
  refinement?: PromptRefinement;
  /** present only for HITL (Human-actor) actions — the gate the executor waits on */
  hitlGate?: HitlGate;
  /** tool sequencing strategy for the executor (default "parallel") */
  toolFlow?: ToolFlow;
  /** P4 — true when this spec is a last-resort DEGRADED shell auto-synthesized to
   *  satisfy the coverage invariant after the brain exhausted its retries on the
   *  action. It is a placeholder (template prompt + floored tools), surfaced as a
   *  blocking warning — never a clean pass. The operator must complete it. */
  degraded?: boolean;
  /** A readable Inngest agent .ts rendering of this spec (specToAgentCode) —
   *  native imports + embedded prompt + step/emit scaffold — so the user can
   *  see + own + edit each generated agent as code, not just a spec. */
  generatedCode?: string;
  /** AI-authored input schema — the trigger event payload fields this agent
   *  consumes, grounded in the ontology DataObjects' properties. */
  inputSchema?: IoField[];
  /** AI-authored output schema — the outcome event payload fields it emits. */
  outputSchema?: IoField[];
  /** how `generatedCode` was produced: "ai" = the LLM wrote the .ts (codegen_agent);
   *  "render" = deterministic specToAgentCode rendering of the spec. */
  codeSource?: "ai" | "render";
}

/** One AI-authored I/O field, grounded in a DataObject property where possible. */
export interface IoField {
  field: string;
  type: string;
  description?: string;
  /** the DataObject.property this field maps to (e.g. "Candidate.candidate_id"). */
  source?: string;
}

export interface ValidationReport {
  ok: boolean;
  /** emitted by some agent but consumed by none and not a declared terminal */
  danglingEmits: string[];
  /** consumed by some agent but produced by none and not a declared entry */
  orphanTriggers: string[];
  /** tools referenced that aren't in the registry (hallucinated) */
  hallucinatedTools: string[];
  /** unresolved tool_use[] entries across all agents */
  unresolvedTools: string[];
  /** agents that ended up with zero bound tools (would do no work) */
  emptyToolAgents: string[];
  /** agents with empty system prompts */
  emptyPrompts: string[];
  /** duplicate slugs */
  slugCollisions: string[];
  notes: string[];
}

export interface GenerateResult {
  domainId: string;
  source: "allmeta" | "snapshot";
  specs: GeneratedAgentSpec[];
  validation: ValidationReport;
  log: string[];
  /** how many actions used a live LLM prompt vs deterministic template */
  llmUsedCount: number;
}

/** Streamed generation events — the factory's internal reasoning surfaced live.
 *  Emitted in order as the pipeline runs; consumed by the SSE route + UI. */
export type GenEvent =
  | { t: "ontology"; domain: string; source: string; actions: number; events: number; agentActions: number }
  | { t: "log"; line: string }
  | { t: "agent-start"; actionName: string; index: number; total: number }
  | { t: "tools"; actionName: string; tools: string[]; unresolved: string[] }
  | { t: "prompt-mode"; actionName: string; useLlm: boolean }
  /** the exact meta-prompt the factory sends to the LLM to author this agent's prompt */
  | { t: "llm-request"; actionName: string; prompt: string }
  /** the exact LLM response (or degradation note) */
  | { t: "llm-response"; actionName: string; text: string; source: PromptSource }
  /** a bounded reflexion round: the critic's score + issues for this agent's prompt */
  | { t: "prompt-critique"; actionName: string; iteration: number; score: number; issues: PromptIssue[] }
  /** the reviser's outcome for this round */
  | { t: "prompt-revise"; actionName: string; iteration: number; changed: boolean; source: PromptSource }
  /** a Human-actor action became a HITL gate instead of being dropped */
  | { t: "hitl"; actionName: string; gateKey: string }
  | { t: "agent-done"; spec: GeneratedAgentSpec }
  | { t: "validation"; report: ValidationReport }
  /** per-spec LLM prompt-quality judge result (streamed as each completes) */
  | { t: "judge"; slug: string; available: boolean; promptScore: number | null; perCriterion?: Array<{ key: string; score: number; justification: string }> }
  | {
      t: "score";
      scored: boolean;
      /** headline = blend(real-source structural, prompt-judge) when available */
      headline: number;
      /** old snapshot-vs-snapshot agreement, demoted to a secondary signal */
      structuralMatch: number;
      /** golden parsed from the REAL running agents (server/inngest/agents/*) */
      realSource: { overall: number; matchedCount: number; perAgent: Array<{ logical: string; matched: boolean; realScore: number }> };
      /** LLM prompt-quality judge aggregate */
      promptJudge: { available: number; overall: number | null; perAgent: Array<{ slug: string; promptScore: number | null }> };
    }
  | { t: "persist"; persisted: string[]; skipped: string[]; errors: Array<{ slug: string; error: string }>; versionLabel: string }
  | { t: "done"; scored: boolean }
  | { t: "error"; message: string };

export type GenEventSink = (e: GenEvent) => void;
