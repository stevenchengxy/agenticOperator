// Meta-Orchestrator Brain — the "conductor of conductors", a streaming ReAct loop.
//
// Where the factory brain reasons about ONE domain's agents, THIS brain reasons about
// the whole build-vs-reuse problem: it inspects a domain, plans which slots to reuse
// vs generate, DRIVES the factory brain to generate the novel ones, validates the
// composed chain, and — when a gap appears — REASONS about whether to fill it with a
// fresh generation or remap an upstream event. Nothing is scripted: the brain thinks,
// calls a tool, observes, and decides the next step. It also grades its result
// against the 招聘-v1 gold standard.

import type { RegistryAgent } from "../types";
import type { NodeNeed, OrchestrationNode } from "../orchestrator";
import type { GoldStandardAgent, StandardComparison } from "../gold-standard";

/** Streamed trace of the meta-brain's reasoning + orchestration acts. Reuses the
 *  factory brain's common variants (think, tool.call, tool.result, message, done,
 *  error) so the same SSE renderer can show it, plus meta-level events. */
export type MetaEvent =
  | { t: "think"; delta: string }
  | { t: "tool.call"; id: string; name: string; reasoning: string; input: unknown }
  | { t: "tool.result"; id: string; name: string; ok: boolean; summary: string }
  | { t: "inspect"; domain: string; slots: number; reusable: number; standardActions: number }
  | { t: "plan"; nodes: Array<{ action: string; decision: "reuse" | "generate"; agent: string | null }>; reuseCount: number; generateCount: number }
  | { t: "generate.start"; actions: string[] }
  | { t: "generate.done"; built: Array<{ action: string; name: string; trigger: string[]; emit: string[] }> }
  | { t: "validate"; chainOk: boolean; gaps: Array<{ event: string; neededBy: string; hint: string }> }
  | { t: "resolve"; event: string; neededBy: string; decision: "generate" | "remap"; detail: string }
  | { t: "compare"; meanTotal: number; uncovered: string[]; scores: Array<{ action: string; total: number; signatureMatch: number; branchCoverage: number; toolCoverage: number | null; matchedGenerated: string | null; notes: string[] }> }
  | { t: "message"; text: string }
  | { t: "done"; status: "complete" | "incomplete" | "turns_exhausted" | "errored"; turns: number; complete: boolean }
  | { t: "error"; message: string };

export type MetaEmit = (e: MetaEvent) => void;

export interface MetaToolResult {
  ok: boolean;
  summary: string;
  output?: unknown;
}

/** A node-slot in the composed plan, plus its live binding. */
export interface SlotState {
  need: NodeNeed;
  decision: "reuse" | "generate" | "open";
  /** the bound agent (reused from registry OR freshly generated). null when open. */
  agent: RegistryAgent | null;
  reason: string;
}

export interface MetaCtx {
  domain: string;
  goal: string;
  emit: MetaEmit;
  /** the domain's required node-slots = ontology agent-actions. Set by inspect_domain. */
  slots: SlotState[];
  /** reuse candidates from the unified registry. Set by inspect_domain. */
  registry: RegistryAgent[];
  /** the 招聘-v1 gold standard for this domain's actions. Set by inspect_domain. */
  goldStandard: GoldStandardAgent[];
  /** event remaps the brain applied to close gaps: an upstream emit republished as
   *  the expected trigger (an adapter the orchestrator injects at deploy). */
  remaps: Array<{ from: string; to: string; reason: string }>;
  /** INTERNAL events = what the domain's agents produce (ontology agent-action
   *  outputs). An unproduced internal event is a real gap; everything else a node
   *  consumes is an EXTERNAL platform/human entry (independent agents, not gaps). */
  internalEvents: string[];
  /** EXTERNAL entry events (consumed but no agent produces) — shown to the brain so
   *  it recognises independent / externally-triggered agents and doesn't "fix" them. */
  entryEvents: string[];
  /** last validate_chain result. */
  lastGaps: Array<{ event: string; neededBy: string; hint: string }>;
  /** last compare_to_standard result. */
  lastComparison: StandardComparison | null;
  spent: { turns: number };
}

export interface MetaTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: MetaCtx): Promise<MetaToolResult>;
}

/** the build-vs-reuse plan node, re-exported for the route/UI. */
export type { OrchestrationNode };
