// Ontology source — fetch a domain's five-piece ontology BY DOMAIN ID.
//
// Per spec 2026-06-02: the generator reads the real ontology (objects / rules /
// actions / events / workflow) for an Allmeta domain id. It tries Allmeta Studio
// live first, and falls back to an in-repo snapshot (lib/ontology-generator/
// snapshots/<domainId>/) when live returns empty / errors. Either way the
// interface is "give me a domain id, get its ontology" — the backing store is an
// implementation detail.
//
// New Allmeta domains (baoxiao-v1 / nengyuandiaodu-v1) currently return empty
// `items` on the per-resource list endpoints even though the schema endpoint
// sees the nodes, so the snapshot is the de-facto source for the demo. Live is
// attempted best-effort and logged; it never throws the caller's request.

import fs from "node:fs";
import path from "node:path";

export type OntologyObject = {
  id: string; // label id, e.g. "Power_Station"
  name: string; // CJK display, e.g. "电站"
  description?: string;
  type?: string;
  primary_key?: string;
  properties?: Array<{ name: string; type?: string; description?: string }>;
};

export type OntologyAction = {
  id: string;
  name: string; // camelCase, e.g. "forecastOutput"
  description?: string;
  category?: string;
  actor: string[]; // ["Agent"] | ["Human"] | ...
  trigger: string[]; // consumed event names
  triggered_event: string[]; // emitted event names
  target_objects: string[];
  tool_use: string[];
  system_prompt: string;
  user_prompt: string;
  outputs?: Array<Record<string, unknown>>;
  side_effects?: Record<string, unknown>;
};

export type OntologyEvent = {
  name: string;
  description?: string;
  payload: {
    source_action: string | null;
    event_data: Array<{ name: string; type: string; target_object: string | null }>;
    state_mutations: Array<{
      target_object: string;
      mutation_type: string;
      impacted_properties: string[];
    }>;
  };
};

export type OntologyRule = Record<string, unknown>;
export type OntologyWorkflowItem = Record<string, unknown>;
/** A domain's workflow definitions. Modeled as a LIST (like objects/rules/
 *  actions/events) so it's counted by length, not by mere presence. */
export type OntologyWorkflow = OntologyWorkflowItem[];

export type DomainOntology = {
  domainId: string;
  objects: OntologyObject[];
  rules: OntologyRule[];
  actions: OntologyAction[];
  events: OntologyEvent[];
  workflow: OntologyWorkflow;
  source: "allmeta" | "snapshot";
};

const SNAPSHOT_ROOT = path.join(process.cwd(), "lib", "ontology-generator", "snapshots");

/** Pull the inner array out of either `{metadata, <key>:[...]}` or a bare array. */
function unwrapList<T = unknown>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj[key])) return obj[key] as T[];
    // fall back to the first array-valued property
    for (const v of Object.values(obj)) if (Array.isArray(v)) return v as T[];
  }
  return [];
}

/**
 * Action `name` is the ontology's de-facto primary key: events name their emitter
 * via `source_action`, and the analyzer keys each derived agent — its React list
 * key, AgentVersion slug, Inngest fn id and short name — off the action name. A
 * live domain export can still carry two nodes with the same name when a re-import
 * or schema migration leaves an old + a patched copy (招聘-v1 ships id:10 and
 * id:10-2, both named "matchResume"; the old copy parks its actor in an unread
 * `actor_json`, so it normalizes actor-less). Collapse same-named actions to one
 * so the name-as-PK invariant holds end-to-end — otherwise two identical React
 * keys crash the Ontology Generator and two identical slugs would collide on
 * deploy. On a name clash keep the more complete record (the one that actually
 * declares an `actor`); tie-break to the first seen. Map.set on an existing key
 * keeps that name's original position, so action order is preserved.
 */
export function dedupeActionsByName(actions: OntologyAction[]): OntologyAction[] {
  const byName = new Map<string, OntologyAction>();
  for (const a of actions) {
    const seen = byName.get(a.name);
    if (!seen || (seen.actor.length === 0 && a.actor.length > 0)) {
      byName.set(a.name, a);
    }
  }
  return [...byName.values()];
}

function readSnapshotFile(domainId: string, file: string): unknown {
  const p = path.join(SNAPSHOT_ROOT, domainId, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Load + unwrap a domain's workflow definitions from its in-repo snapshot.
 * Handles both the `{metadata, workflows:[...]}` envelope and a bare array;
 * returns [] when the domain has no workflow.json. Exported so the live
 * (Allmeta) path can backfill workflows it doesn't itself serve.
 */
export function loadSnapshotWorkflow(domainId: string): OntologyWorkflow {
  return unwrapList<OntologyWorkflowItem>(readSnapshotFile(domainId, "workflow.json"), "workflows");
}

/** Load a domain's ontology from the in-repo snapshot. Throws if absent. */
export function loadSnapshotOntology(domainId: string): DomainOntology {
  const objectsRaw = readSnapshotFile(domainId, "objects.json");
  const actionsRaw = readSnapshotFile(domainId, "actions.json");
  if (objectsRaw === null && actionsRaw === null) {
    throw new Error(
      `No ontology snapshot for domain "${domainId}" (expected ${path.join(SNAPSHOT_ROOT, domainId)}).`,
    );
  }
  return {
    domainId,
    objects: unwrapList<OntologyObject>(objectsRaw, "objects"),
    rules: unwrapList<OntologyRule>(readSnapshotFile(domainId, "rules.json"), "rules"),
    actions: dedupeActionsByName(unwrapList<OntologyAction>(actionsRaw, "actions")),
    events: unwrapList<OntologyEvent>(readSnapshotFile(domainId, "events.json"), "events"),
    workflow: loadSnapshotWorkflow(domainId),
    source: "snapshot",
  };
}

/** True when a snapshot dir exists for the domain. */
export function hasSnapshot(domainId: string): boolean {
  return fs.existsSync(path.join(SNAPSHOT_ROOT, domainId, "actions.json"));
}

// ── Allmeta live (the real Neo4j read) ──────────────────────────────────────
//
// Allmeta stores ontology data as graph NODES whose shape differs from the
// five-piece snapshot JSON: stringified `*_json` fields, `uid`/`action_id`
// instead of `id`, `trigger_events` (consumed) on the action and NO emitted
// field (emitted events are derived from each event's `source_action`). These
// normalizers map an Allmeta node back to our OntologyObject/Event/Action shape
// so the analyzer/infer work identically on live data and on snapshots.
const ALLMETA_BASE = process.env.ALLMETA_BASE_URL ?? "";
const ALLMETA_KEY = process.env.ALLMETA_API_KEY ?? "";
const ALLMETA_TIMEOUT_MS = 8000; // > Studio first-hit lazy-compile

type Node = Record<string, unknown>;

function parseJsonField<T>(v: unknown, fallback: T): T {
  let parsed: unknown;
  if (v == null) return fallback;
  if (typeof v === "object") parsed = v;
  else if (typeof v === "string") {
    try {
      parsed = JSON.parse(v);
    } catch {
      return fallback;
    }
  } else return fallback;
  // Type-guard against shape mismatch: if the caller expects an array (its
  // fallback is `[]`) but Allmeta returned a plain object, use the fallback so
  // downstream `.map()`/`.length` never crash.
  if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
  return parsed as T;
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
}

async function allmetaList(resource: string, domainId: string): Promise<Node[]> {
  if (!ALLMETA_BASE) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALLMETA_TIMEOUT_MS);
  try {
    const url = `${ALLMETA_BASE.replace(/\/+$/, "")}/api/v1/ontology/${resource}?domain=${encodeURIComponent(domainId)}&limit=1000`;
    const res = await fetch(url, {
      headers: ALLMETA_KEY ? { Authorization: `Bearer ${ALLMETA_KEY}` } : {},
      signal: controller.signal,
      // 每次都拿 Neo4j 当前值,绝不走 Next 的 fetch data-cache(总览轮询要实时反映改动)。
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: unknown[] };
    return Array.isArray(body.items) ? (body.items as Node[]) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAllmetaObject(n: Node): OntologyObject {
  return {
    id: String(n.uid ?? n.id ?? ""),
    name: String(n.name ?? n.uid ?? ""),
    description: typeof n.description === "string" ? n.description : undefined,
    type: typeof n.type === "string" ? n.type : undefined,
    primary_key: typeof n.primary_key === "string" ? n.primary_key : undefined,
    properties: parseJsonField(n.properties_json, [] as OntologyObject["properties"]),
  };
}

function normalizeAllmetaEvent(n: Node): OntologyEvent {
  return {
    name: String(n.name ?? ""),
    description: typeof n.description === "string" ? n.description : undefined,
    payload: {
      source_action: typeof n.source_action === "string" ? n.source_action : null,
      event_data: parseJsonField(n.event_data_json, [] as OntologyEvent["payload"]["event_data"]),
      state_mutations: parseJsonField(n.mutations_json, [] as OntologyEvent["payload"]["state_mutations"]),
    },
  };
}

function normalizeAllmetaAction(n: Node, emitByAction: Map<string, string[]>): OntologyAction {
  const name = String(n.name ?? "");
  return {
    id: String(n.action_id ?? n.id ?? ""),
    name,
    description: typeof n.description === "string" ? n.description : undefined,
    category: typeof n.category === "string" ? n.category : undefined,
    actor: asArray(n.actor),
    trigger: asArray(n.trigger_events), // Allmeta: trigger_events = consumed
    triggered_event: emitByAction.get(name) ?? [], // derived from events' source_action
    target_objects: asArray(n.target_objects),
    // Allmeta deployment doesn't carry prompts/tools/side-effects on the node;
    // they're only needed to RUN an agent (snapshot path), not to display/infer.
    tool_use: asArray(n.tool_use),
    system_prompt: typeof n.system_prompt === "string" ? n.system_prompt : "",
    user_prompt: typeof n.user_prompt === "string" ? n.user_prompt : "",
    outputs: parseJsonField(n.outputs_json, [] as OntologyAction["outputs"]),
    side_effects: parseJsonField(n.side_effects_json, {} as OntologyAction["side_effects"]),
  };
}

/** Fetch + normalize a domain's ontology from Allmeta (the live Neo4j read). */
async function fetchAllmetaOntology(domainId: string): Promise<DomainOntology | null> {
  const [actionsRaw, eventsRaw] = await Promise.all([
    allmetaList("actions", domainId),
    allmetaList("events", domainId),
  ]);
  if (actionsRaw.length === 0) return null; // not served / domain empty → caller falls back

  const [objectsRaw, rulesRaw] = await Promise.all([
    allmetaList("objects", domainId),
    allmetaList("rules", domainId),
  ]);

  const events = eventsRaw.map(normalizeAllmetaEvent);
  // action name → emitted event names (an event names the action that emits it).
  const emitByAction = new Map<string, string[]>();
  for (const e of events) {
    const sa = e.payload.source_action;
    if (sa) {
      const arr = emitByAction.get(sa) ?? [];
      arr.push(e.name);
      emitByAction.set(sa, arr);
    }
  }

  return {
    domainId,
    objects: objectsRaw.map(normalizeAllmetaObject),
    rules: rulesRaw as OntologyRule[],
    actions: dedupeActionsByName(actionsRaw.map((n) => normalizeAllmetaAction(n, emitByAction))),
    events,
    workflow: [], // Allmeta has no workflow resource; backfilled from snapshot in fetchDomainOntology
    source: "allmeta",
  };
}

/**
 * Fetch a domain's ontology by domain id — the REAL Neo4j read.
 * Priority: live Allmeta (normalized) → in-repo snapshot (offline/runnable) →
 * empty shell. So selecting any deployed Allmeta domain shows ITS real ontology;
 * the snapshot is the offline fallback + the complete (prompt-carrying) source
 * the runnable packs load directly.
 */
export async function fetchDomainOntology(domainId: string): Promise<DomainOntology> {
  const live = await fetchAllmetaOntology(domainId);
  if (live) {
    // Allmeta exposes no workflow resource, so a live read carries no
    // workflow. Backfill the domain's workflow definitions from the in-repo
    // snapshot when one exists — so the workflow count is correct whether the
    // domain is served live (Allmeta) or offline (snapshot).
    if (live.workflow.length === 0) {
      const snapWf = loadSnapshotWorkflow(domainId);
      if (snapWf.length) live.workflow = snapWf;
    }
    return live;
  }
  if (hasSnapshot(domainId)) return loadSnapshotOntology(domainId);
  return {
    domainId,
    objects: [],
    rules: [],
    actions: [],
    events: [],
    workflow: [],
    source: "snapshot",
  };
}

/**
 * Ontology source for the RUNNABLE-PACK surfaces (Ontology Generator infer +
 * Workflow canvas + agent derivation). A domain that ships an in-repo snapshot
 * IS a runnable pack, and that snapshot is authoritative: the registered Inngest
 * functions (server/inngest/domains/*), the curated Chinese workflow labels, and
 * the rule-check executor are all built from it. Live Allmeta can carry a richer
 * but NON-runnable design — e.g. 费控 ships a 14-action runnable snapshot while
 * Allmeta holds a 25-action draft with no registered functions. Reading live on
 * these surfaces is what made the canvas show English (labels keyed to snapshot
 * names) and the generator emit 0 agents (infer's live keys never matched the
 * snapshot-derived generate step). So: snapshot-shipping domain → snapshot;
 * everything else → live Allmeta (`fetchDomainOntology`).
 */
export async function fetchRunnableOntology(domainId: string): Promise<DomainOntology> {
  if (hasSnapshot(domainId)) return loadSnapshotOntology(domainId);
  return fetchDomainOntology(domainId);
}
