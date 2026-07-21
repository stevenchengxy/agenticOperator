// Shared ontology-agent factory types.
//
// The energy + 费控 runnable packs both build their Inngest functions through
// the SAME factory (server/inngest/domains/energy/make-agent.ts). These types
// are the cross-domain contract — generic over the per-domain dataset `TData`
// so each domain keeps its own strongly-typed scenario data while sharing the
// gate / behavior / factory plumbing.

import type { Inngest } from "inngest";
import type { OntologyEvent } from "@/lib/ontology-generator/ontology-source";

/** A human's decision on a gate (verbs are domain-specific: 采纳/退回/否决 ·
 *  确认核准/降额/退回/驳回 · 放行/暂缓/上报). */
export type HumanDecision = {
  decision: string;
  edits?: string;
  reason?: string;
  operator?: string;
};

/** What a gate's `route(decision)` returns: which events to emit, the payload,
 *  and any once-per-case claims to release (forces a downstream re-run). */
export type GateRoute = {
  emitEvents: string[];
  payload: Record<string, unknown>;
  resetClaims?: string[];
};

/** A human-in-the-loop gate: the factory records a needs_human notification,
 *  suspends on `<ns>/HUMAN_DECISION` (matched by caseId + gateKey), then routes. */
export type GateRequest = {
  gateKey: string; // = action name, matched by the resume event's data.gate
  category: "agent" | "event";
  source: string;
  title: string;
  body: string;
  riskType?: string;
  riskLevel?: string;
  anchors: Record<string, string>;
  route: (d: HumanDecision) => GateRoute;
};

export type ComputeResult = {
  /** Payload to merge into emitted events: keyed by bare emit name, or "*". */
  payloadByEvent?: Record<string, Record<string, unknown>>;
  /** Override which events to emit (default = the action's triggered_event). */
  emitEvents?: string[];
  /** Emit nothing — this action no-ops for this case (e.g. wrong risk type). */
  skip?: boolean;
  skipReason?: string;
  /** Request a human gate (notify + waitForEvent + route). */
  gate?: GateRequest;
};

export type ComputeCtx<TData = unknown> = {
  caseId: string;
  /** Inngest function-run id: stable for technical retries, new for each
   * business re-execution of the same case/action. Used as the audit idempotency key. */
  runId: string;
  /** Case label (energy 调度令 DS号 / 费控 案件 FK号) — drawn from dataset.dsNo. */
  dsNo: string;
  scenario: string;
  dataset: TData | null;
  upstream: Record<string, unknown>;
  logger: { event: (kind: string, payload?: Record<string, unknown>) => void };
  step: { run: <T>(id: string, fn: () => Promise<T> | T) => Promise<T> };
};

/** A deterministic per-action behavior — runs instead of the LLM pass-through. */
export type Behavior<TData = unknown> = {
  /** Override the action's Inngest triggers (bare event names). */
  triggerOverride?: string[];
  /** Function-level retries for durable deterministic steps. Omitted keeps the
   * existing no-retry behavior for LLM and human-gate functions. */
  retries?: 0 | 1 | 2 | 3 | 4 | 5;
  compute: (ctx: ComputeCtx<TData>) => Promise<ComputeResult>;
};

export type AgentFactoryOpts<TData = unknown> = {
  domainId: string;
  eventNs: string;
  seedEvent: string;
  eventsByName: Map<string, OntologyEvent>;
  objectNameById: Map<string, string>;
  branchActions: Set<string>;
  /** Terminal action names (e.g. archiveCase). When one finishes, the run's
   *  WorkflowRun is marked completed. Empty/omitted → no completion transition. */
  terminalActions?: Set<string>;
  /** Per-action deterministic behaviors, keyed by action name. */
  behaviors: Record<string, Behavior<TData>>;
  /** Notification dedupe prefix for gates (default `${eventNs}_human_gate`).
   *  The human-decision route matches `<prefix>.<gate>.<caseId>`. */
  dedupeHintPrefix?: string;
  /** Compact one-line dataset summary for the LLM prompt (default ""). */
  datasetBrief?: (d: TData | null) => string;
  /** Default client when none is passed to makeOntologyAgent (per-domain apps
   *  pass their own). Kept here for documentation; the factory's 3rd arg wins. */
  client?: Inngest;
};

export type Envelope<TData = unknown> = {
  caseId?: string;
  domainId?: string;
  _depth?: number;
  enableBranches?: boolean;
  source_action?: string;
  payload?: Record<string, unknown>;
  dataset?: TData | null;
  scenario?: string;
  simulated?: boolean;
};
