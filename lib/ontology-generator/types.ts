// Ontology Generator — shared types.
//
// The page reads a business domain's ontology (rules / data objects / actions /
// events / workflow), infers which agents the domain is missing, lets the
// operator pick them, then "generates" the selection as draft AgentVersion rows.
//
// Backing model (per spec 2026-06-01): real ontology read + curated results.
// `infer.ts` runs real "dangling event" gap analysis over the live event
// catalog; the per-domain candidates + display copy live in `profiles.ts`.

export type OntologyCounts = {
  rules: number;
  dataObjects: number;
  actions: number;
  events: number;
  workflow: number;
};

export function totalElements(c: OntologyCounts): number {
  return c.rules + c.dataObjects + c.actions + c.events + c.workflow;
}

/** One inferred agent the domain is missing. */
export type InferredAgentCandidate = {
  /** Stable id for selection state. */
  key: string;
  /** AGENT_MAP short code — written to AgentVersion.short (persistable domains). */
  short: string;
  /** Inngest function id — written to AgentVersion.slug. */
  slug: string;
  nameZh: string;
  nameEn: string;
  /** Monospace display id shown next to the name, e.g. "MatchResumeAgent". */
  agentId: string;
  descZh: string;
  descEn: string;
  /** Event-transition badges: triggerEvent → emitEvent. */
  triggerEvent: string;
  emitEvent: string;
  /** 「本体依据」 — the ontology gap that motivates this agent. */
  rationaleZh: string;
  rationaleEn: string;
  /** 0..100 confidence shown in the ring gauge. */
  confidence: number;
  /** Card avatar chip. */
  iconChar: string;
  iconColor: string;
  /** Set by infer.ts when triggerEvent exists in the live event catalog. */
  ontologyGrounded?: boolean;
};

export type DomainProfile = {
  id: string;
  nameZh: string;
  nameEn: string;
  /** Domain chip avatar (top-right). */
  iconChar: string;
  iconColor: string;
  counts: OntologyCounts;
  candidates: InferredAgentCandidate[];
};

/** Response of POST /api/ontology-generator/infer. */
export type InferResult = {
  domainId: string;
  counts: OntologyCounts;
  candidates: InferredAgentCandidate[];
  /** Real dangling-event signals found in the live catalog (publishers, no subscribers). */
  danglingEvents: string[];
};

/** A generated agent shown on the deploy screen. */
export type GeneratedDraft = {
  key: string;
  short: string;
  slug: string;
  domain: string;
  nameZh: string;
  nameEn: string;
  agentId: string;
  triggerEvent: string;
  emitEvent: string;
  confidence: number;
  iconChar: string;
  iconColor: string;
  status: "draft";
  versionLabel: string;
  /** true when an AgentVersion row was actually written. */
  persisted: boolean;
};

/** Response of POST /api/ontology-generator/generate. */
export type GenerateResult = {
  domainId: string;
  drafts: GeneratedDraft[];
};

// ── Draft store / agent lifecycle (Fleet「部署智能体」) ───────────────────────
//
// Ontology-generated agents are sandboxed SHELLS: their slugs never collide
// with the real Inngest functions, so deploying / onlining / offlining a shell
// can never affect the real production agents. Their whole lifecycle lives on
// the AgentVersion.status column (draft → active → offline → draft).

export type DraftLifecycle = "draft" | "active" | "offline" | "archived";

/** Whether a managed agent is an ontology-generated shell or a real production
 *  agent (AGENT_MAP) carrying a lifecycle override. */
export type AgentDraftKind = "shell" | "real";

/** Display fields stashed in AgentVersion.configJson for shell agents. */
export type ShellCardData = {
  nameZh: string;
  nameEn: string;
  agentId: string;
  descZh: string;
  descEn: string;
  triggerEvent: string;
  emitEvent: string;
  confidence: number;
  iconChar: string;
  iconColor: string;
};

/** One managed agent row in the Fleet drafts store (shell or real agent). */
export type AgentDraftRow = ShellCardData & {
  id: string; // AgentVersion.id, or a synthetic "real:<domain>:<short>" id
  short: string;
  slug: string;
  domain: string;
  versionLabel: string;
  status: DraftLifecycle;
  createdAt: string;
  /** 'shell' (ontology-generated) or 'real' (production agent override). */
  kind?: AgentDraftKind;
  /** Set when soft-deleted into the recycle bin. */
  archivedAt?: string | null;
};

/** Response of GET /api/agent-drafts (optionally ?domain=X). */
export type AgentDraftsResponse = {
  /** All ontology-generated shells (filtered by domain when the param is given). */
  rows: AgentDraftRow[];
};
