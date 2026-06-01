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
export type OntologyWorkflow = Record<string, unknown> | null;

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

function readSnapshotFile(domainId: string, file: string): unknown {
  const p = path.join(SNAPSHOT_ROOT, domainId, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
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
    actions: unwrapList<OntologyAction>(actionsRaw, "actions"),
    events: unwrapList<OntologyEvent>(readSnapshotFile(domainId, "events.json"), "events"),
    workflow: (() => {
      const wf = readSnapshotFile(domainId, "workflow.json");
      return (wf as OntologyWorkflow) ?? null;
    })(),
    source: "snapshot",
  };
}

/** True when a snapshot dir exists for the domain. */
export function hasSnapshot(domainId: string): boolean {
  return fs.existsSync(path.join(SNAPSHOT_ROOT, domainId, "actions.json"));
}

// ── Allmeta live (best-effort) ──────────────────────────────────────────────
const ALLMETA_BASE = process.env.ALLMETA_BASE_URL ?? "";
const ALLMETA_KEY = process.env.ALLMETA_API_KEY ?? "";

async function allmetaList(resource: string, domainId: string, timeoutMs = 4000): Promise<unknown[]> {
  if (!ALLMETA_BASE) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${ALLMETA_BASE.replace(/\/+$/, "")}/api/v1/ontology/${resource}?domain=${encodeURIComponent(domainId)}&limit=500`;
    const res = await fetch(url, {
      headers: ALLMETA_KEY ? { Authorization: `Bearer ${ALLMETA_KEY}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: unknown[] };
    return Array.isArray(body.items) ? body.items : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a domain's ontology by domain id. Tries Allmeta live; if the core
 * resources (actions/events) come back empty, falls back to the in-repo
 * snapshot. Never throws for a known-snapshot domain.
 */
export async function fetchDomainOntology(domainId: string): Promise<DomainOntology> {
  const [actions, events] = await Promise.all([
    allmetaList("actions", domainId),
    allmetaList("events", domainId),
  ]);

  // Live is only usable when it actually returns the action graph. The new
  // domains return empty items today → snapshot wins.
  if (actions.length > 0 && events.length > 0) {
    const [objects, rules] = await Promise.all([
      allmetaList("objects", domainId),
      allmetaList("rules", domainId),
    ]);
    return {
      domainId,
      objects: objects as OntologyObject[],
      rules: rules as OntologyRule[],
      actions: actions as OntologyAction[],
      events: events as OntologyEvent[],
      workflow: null, // live workflow read not wired; analyzer only needs actions+events
      source: "allmeta",
    };
  }

  if (hasSnapshot(domainId)) return loadSnapshotOntology(domainId);

  // No live data and no snapshot → empty shell (generic/empty domain).
  return {
    domainId,
    objects: [],
    rules: [],
    actions: [],
    events: [],
    workflow: null,
    source: "snapshot",
  };
}
