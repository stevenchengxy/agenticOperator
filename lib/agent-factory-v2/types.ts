import type { DomainOntology } from "@/lib/ontology-generator/ontology-source";
import type { ToolRegistry } from "@/lib/tools/registry";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

export type FacetKind = "actions" | "events" | "rules" | "objects";

export interface SkillSpec {
  name: string;
  purpose: string;
  promptFragment: string;
  tools: string[];
  decisionRule: string;
}

export interface FacetInsight {
  facet: FacetKind;
  /** human-readable analysis of this facet for the domain */
  summary: string;
  /** salient extracted points the planner/generators will use */
  highlights: string[];
  degraded: boolean; // true = produced by deterministic fallback
}

export interface DomainUnderstanding {
  domain: string;
  source: DomainOntology["source"];
  facets: FacetInsight[];
  /** integrated, cross-facet understanding of the domain */
  synthesis: string;
  counts: { actions: number; events: number; rules: number; objects: number };
}

export interface TargetAgentBrief {
  name: string;
  trigger: string[];
  emit: string[];
  objects: string[];
  ruleRefs: string[];
  rationale: string;
}

export interface BuildPlan {
  agents: TargetAgentBrief[];
  skills: { name: string; purpose: string }[];
}

export interface ToolSelection {
  tools: string[];
  retries: number;
}

export type BuildEvent =
  | { t: "build.start"; domain: string; source: string }
  | { t: "facet.start"; facet: FacetKind }
  | { t: "facet.analyzed"; facet: FacetKind; highlights: string[]; degraded: boolean }
  | { t: "llm"; builder: string; target: string | null; purpose: string; degraded: boolean; promptChars: number; responseChars: number; latencyMs: number;
      /** FULL transparency: the exact system prompt, user prompt, and response
       *  for this LLM call (generously capped). Lets the 推理 panel show the real
       *  input+output of every builder, not just char counts. Also persisted in
       *  the FactoryLlmCall ledger. */
      system: string; user: string; response: string; model: string | null }
  | { t: "understanding.ready"; synthesis: string; counts: DomainUnderstanding["counts"] }
  | { t: "log"; line: string }
  | { t: "build.done"; tokensUsed: number }
  | { t: "error"; message: string }
  | { t: "plan.ready"; agents: number; skills: number }
  | { t: "agent.start"; name: string }
  | { t: "prompt.critique"; name: string; score: number; approved: boolean }
  | { t: "agent.assembled"; name: string; tools: string[]; promptSource: string;
      /** Full generated spec so the UI can show the agent's code/spec on click. */
      spec: {
        slug: string; short: string; kind: string; nameZh: string;
        trigger: string[]; emit: string[]; objects: string[];
        retries: number; confidence: number;
        systemPrompt: string; userPrompt: string;
        steps: { name: string; tool: string | null }[];
      } }
  | { t: "repair.start"; agent: string; kind: "dangling" | "unreached" | "tool-error" }
  | { t: "repair.done"; agent: string; changed: boolean }
  | { t: "smoke.result"; passed: boolean; ran: number; repairs: number }
  | { t: "needs-human"; reason: string }
  | { t: "skill.built"; name: string; tools: string[] }
  | { t: "validation"; ok: boolean; issues: string[] }
  | { t: "replan"; attempt: number; reason: string }
  // ── ship + real run (the deploy bridge; only emitted when a Deployer is injected) ──
  | { t: "ship.start"; count: number }
  | { t: "ship.done"; versionLabel: string; deployed: string[]; appRegistered: boolean; error?: string }
  | { t: "run.fired"; events: string[] }
  | { t: "run.observed"; runs: { runId: string; status: string; fn: string }[]; events: string[]; reachedTerminal: boolean };

export type BuildEventSink = (e: BuildEvent) => void;

// ── Deploy bridge ──────────────────────────────────────────────────────────
// The conductor depends ONLY on this interface, never the concrete Inngest/Prisma
// implementation — so hermetic tests run with no deployer (in-process only) while
// the real build route injects `realDeployer` (lib/agent-factory-v2/deploy.ts) to
// actually persist → register → fire → observe on Inngest.

export interface ShipReport {
  versionLabel: string;
  /** slugs that became active AgentVersion rows */
  deployed: string[];
  appRegistered: boolean;
  error?: string;
  /** the per-domain Inngest app id the functions were served under */
  appId?: string;
  /** how many functions the Inngest dev server actually introspected after the
   *  sync (the verifiable count — 0 means nothing registered despite app online). */
  functionsRegistered?: number;
}

/** Per-test-case behavioral verdict: did the case reach the terminal its KIND
 *  expects? pass→a non-failure terminal, reject→a failure terminal, edge→tolerant.
 *  Turns the sandbox from "the chain runs" into "the chain decides correctly". */
export interface CaseResult {
  name: string;
  kind: string;                       // pass | reject | edge
  expectedOutcome: string;
  reachedTerminal: string | null;     // bare terminal event name it actually reached
  isFailureTerminal: boolean;
  ok: boolean;                        // verdict matched the kind's expectation
  detail: string;
}

export interface RunReport {
  /** namespaced entry events actually sent (e.g. "agents-generation/RESUME_DOWNLOADED") */
  fired: string[];
  /** real Inngest runs observed in the Postgres archive */
  runs: { runId: string; status: string; fn: string }[];
  /** namespaced events observed flowing through the chain (entry + emitted) */
  events: string[];
  /** true when a terminal (no-consumer) event of the chain was observed */
  reachedTerminal: boolean;
  /** the per-domain Inngest app the functions ran under (deploy proof) */
  appId?: string;
  /** functions the Inngest server actually had registered when we fired. 0 =
   *  the deploy didn't take — fired into the void; reported as a deploy failure
   *  distinct from "ran but didn't reach terminal". */
  functionsRegistered?: number;
  /** distinct agent functions that ACTUALLY executed (≤ functionsRegistered). A
   *  partial chain shows fewer than deployed — the honest "did the whole chain
   *  run" signal, so a 2-of-6 run can't read as a full success. */
  agentsRan?: number;
  /** agent slugs whose decision was a DEGRADED fallback (gateway down → emits[0]),
   *  not a real decision. A chain that only "progressed" on degraded fallbacks is
   *  NOT verified — the finish gate must reject it. */
  degradedAgents?: string[];
  /** ② per-case behavioral verdicts — each fired test case traced to its terminal
   *  and checked against its kind's expectation. */
  caseResults?: CaseResult[];
}

export interface Deployer {
  /** persist specs as deployable AgentVersion rows + register the domain Inngest app */
  ship(domain: string, specs: GeneratedAgentSpec[]): Promise<ShipReport>;
  /** fire the chain's entry events + observe the real run in the archive */
  observe(domain: string, specs: GeneratedAgentSpec[]): Promise<RunReport>;
}

export interface BuildBudget {
  maxTokens: number;   // hard ceiling across the whole build
  maxLlmCalls: number; // hard cap on LLM calls
}

export interface BuilderCtx {
  runId: string;
  domain: string;
  ontology: DomainOntology;
  /** Tool registry for this domain (resolved at build start). Optional for
   *  builders that don't need tools (facet-analyst, integrator, planner). */
  registry?: ToolRegistry;
  emit: BuildEventSink;
  budget: BuildBudget;
  spent: { tokens: number; calls: number };
}
