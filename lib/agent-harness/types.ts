// Multi-harness architecture — shared types (blueprint Tier 0 + Tier 1).
//
// The whole "harness of harnesses" rests on ONE idea: every agent — whether it was
// AI-GENERATED (factory) or HAND-WRITTEN (preset library) — looks identical to the
// orchestrator: a node with an ontology event signature (trigger → emit). The
// RegistryAgent below is that uniform node descriptor. The Agent Registry collects
// both sources into one catalog; the Selection Harness matches a sub-goal against
// it; the Meta-Orchestrator decides build-vs-reuse from it.

import type { IoField } from "@/lib/agent-factory-gen/types";

/** Where a registered agent came from. To the orchestrator this is just a badge —
 *  it does NOT change how the node is scheduled. */
export type AgentSource = "generated" | "handwritten";

/** The THREE kinds of agent in the system, unified behind one descriptor:
 *  · builder  — internal helper (Tool-Smith / Agent-Builder / Verifier / …), produces
 *               artifacts, ephemeral, runs in-process.
 *  · product  — a deployed business agent (the factory's output), event-triggered,
 *               persistent, runs on Inngest.
 *  · harness  — an agent that spawns sub-agents at runtime (a capability flag, not a
 *               third entity — builders/products can have spawns:true). */
export type AgentKind = "builder" | "product" | "harness";

/** How the Runner actually RUNS a node — the ONLY place the two substrates differ.
 *  Everything else (descriptor, invoke, spawn) is uniform. */
export type AgentExec =
  | { substrate: "in-process"; goalHint?: string }   // spawn a ReAct sub-brain
  | { substrate: "inngest"; fnId: string }           // emit its trigger event + observe the run
  | { substrate: "tool"; toolRef: string };          // call a single tool

/** The uniform node descriptor — the lingua franca of the multi-harness system.
 *  (Was RegistryAgent; kind/spawns/exec make it the full AgentNode — all optional so
 *  existing registry/selection/orchestrator code that omits them keeps working; the
 *  Runner derives sensible defaults via asAgentNode().) */
export interface RegistryAgent {
  /** stable id (Inngest fn id for handwritten; AgentVersion id/slug for generated) */
  id: string;
  /** human/short name */
  name: string;
  source: AgentSource;
  /** business domain (recruitment / energy / …). A SOFT filter — the event
   *  signature is the real cross-harness contract. */
  domain: string;
  /** one-line "what it does" — used for capability/semantic matching */
  capability: string;
  /** the event contract — what it consumes / produces. THE matching key. */
  triggerEvents: string[];
  emitEvents: string[];
  /** AI-authored I/O field schemas when known (generated agents). */
  inputSchema?: IoField[];
  outputSchema?: IoField[];
  /** bound tool names. */
  tools: string[];
  /** where the code lives: a module path (handwritten) or AgentVersion id (generated). */
  codeRef: string;
  version?: string;
  /** draft | active | offline | archived | preset */
  status: string;
  /** true when a sandbox run proved it executes (generated agents that passed the
   *  behavioral gate). Handwritten agents are assumed proven (they ship in prod). */
  sandboxProven: boolean;
  /** ── unified interface (optional; asAgentNode() derives when absent) ── */
  /** what kind of agent — defaults to "product" (registry agents are deployable). */
  kind?: AgentKind;
  /** can it spawn sub-agents at runtime? defaults false (products don't). */
  spawns?: boolean;
  /** how the Runner runs it — defaults to {substrate:"inngest", fnId:id} for products. */
  exec?: AgentExec;
}

/** A fully-resolved node: a RegistryAgent guaranteed to carry kind/spawns/exec.
 *  Produced by asAgentNode(); what the Runner consumes. */
export type AgentNode = RegistryAgent & { kind: AgentKind; spawns: boolean; exec: AgentExec };

/** A unified event the Runner streams, regardless of substrate — one renderer for
 *  builder sub-brains, product Inngest runs, and tool calls. */
export type AgentInvokeEvent =
  | { t: "invoke.start"; nodeId: string; substrate: AgentExec["substrate"] }
  | { t: "invoke.delta"; text: string }                       // streamed reasoning (in-process)
  | { t: "invoke.tool"; name: string; ok: boolean }           // a tool the sub-agent called
  | { t: "invoke.done"; ok: boolean; summary: string; output?: unknown }
  | { t: "invoke.error"; message: string };

/** What the Selection Harness is asked to satisfy — one sub-goal as a node need. */
export interface SelectionRequest {
  /** events the needed node should consume (≥1). The primary matching key. */
  triggerEvents: string[];
  /** events it should produce (optional — narrows the match). */
  emitEvents?: string[];
  /** free-text capability the node should have (optional — semantic tie-break). */
  capability?: string;
  /** soft domain filter (optional). */
  domain?: string;
}

/** A registry agent scored against a SelectionRequest. */
export interface ScoredAgent {
  agent: RegistryAgent;
  score: number;          // 0..1
  signatureMatch: "exact" | "trigger" | "partial" | "none";
  why: string;
}

/** The Selection Harness verdict: reuse an existing node, or tell the orchestrator
 *  to generate a new one. */
export interface SelectionResult {
  decision: "reuse" | "generate";
  best: RegistryAgent | null;
  candidates: ScoredAgent[];
  reason: string;
}
