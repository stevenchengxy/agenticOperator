/**
 * Import an on-disk ontology snapshot into Allmeta / Neo4j (:7688) so the domain
 * is served LIVE — exactly like "Agents-generation". The Agent Factory's domain
 * picker sends `energy` / `feikong`, but those domains had no live Neo4j data and
 * the snapshot folders are named `能源调度-v1` / `费控-v1`, so reads returned 0.
 * This loads the snapshot into Neo4j under the UI's domain id, closing the gap.
 *
 * Usage:
 *   tsx --env-file=.env.local scripts/import-ontology-to-allmeta.ts            # all mappings
 *   tsx --env-file=.env.local scripts/import-ontology-to-allmeta.ts energy     # one domain
 *
 * Reads ALLMETA_BASE_URL + ALLMETA_API_KEY from the env file. Idempotent: the
 * Allmeta write upserts by node id, so re-running replaces rather than dupes.
 */

import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.ALLMETA_BASE_URL ?? "http://localhost:3500").replace(/\/+$/, "");
const KEY = process.env.ALLMETA_API_KEY ?? "";
const SNAP_ROOT = path.join(process.cwd(), "lib/ontology-generator/snapshots");

// snapshot folder → live domain id the UI's factory picker sends.
const MAPPINGS: Array<{ folder: string; domainId: string; label: string }> = [
  { folder: "能源调度-v1", domainId: "energy", label: "能源调度" },
  { folder: "费控-v1", domainId: "feikong", label: "费控" },
];

type Dict = Record<string, unknown>;

/** Snapshot resource files are either a bare list or `{ <key>: [...] }`. */
function readList(folder: string, file: string, key: string): Dict[] {
  const p = path.join(SNAP_ROOT, folder, file);
  if (!fs.existsSync(p)) return [];
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw[key])) return raw[key];
    if (Array.isArray(raw.items)) return raw.items;
    for (const v of Object.values(raw)) if (Array.isArray(v)) return v;
  }
  return [];
}

const J = (v: unknown) => JSON.stringify(v ?? null);

/** Invert AO's normalizer: complex/list fields → stringified `*_json` props
 *  (Neo4j can't store nested objects as properties), matching the live shape. */
function toActionNode(a: Dict, domainId: string): Dict {
  return {
    id: String(a.id ?? a.name),
    name: a.name,
    description: a.description ?? "",
    submission_criteria: a.submission_criteria ?? "",
    category: a.category ?? "",
    object_type: "action",
    actor_json: J(a.actor ?? []),
    trigger_json: J(a.trigger ?? []),
    triggered_event_json: J(a.triggered_event ?? []),
    target_objects_json: J(a.target_objects ?? []),
    inputs_json: J(a.inputs ?? []),
    outputs_json: J(a.outputs ?? []),
    side_effects_json: J(a.side_effects ?? {}),
    tool_use_json: J(a.tool_use ?? []),
    domainId,
  };
}
function toObjectNode(o: Dict, domainId: string): Dict {
  return {
    id: String(o.id ?? o.name),
    name: o.name,
    description: o.description ?? "",
    type: o.type ?? "",
    relationship_description: o.relationship_description ?? "",
    primary_key: o.primary_key ?? "",
    properties: J(o.properties ?? []),
    domainId,
  };
}
function toEventNode(e: Dict, domainId: string): Dict {
  const payload = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Dict;
  return {
    id: String(e.id ?? `evt-${e.name}`),
    name: e.name,
    description: e.description ?? "",
    source_action: (payload.source_action as string) ?? null,
    payload: J(payload),
    domainId,
  };
}
function toRuleNode(r: Dict, domainId: string): Dict {
  // Rules pass through raw in AO's normalizer (relatedEntities is a string[],
  // which Neo4j stores natively) — just stamp the domain + ensure an id.
  return { ...r, id: String(r.id ?? r.businessLogicRuleName ?? Math.random().toString(36).slice(2)), domainId };
}

async function bulkPost(resource: string, domainId: string, items: Dict[]): Promise<void> {
  if (!items.length) { console.log(`  ${resource}: 0 (skip)`); return; }
  const url = `${BASE}/api/v1/ontology/${resource}?domain=${encodeURIComponent(domainId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ domainId, items }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${resource} → ${res.status}: ${body.slice(0, 300)}`);
  }
  console.log(`  ${resource}: wrote ${items.length} → ${res.status}`);
}

async function importDomain(m: { folder: string; domainId: string; label: string }): Promise<void> {
  console.log(`\n=== ${m.label} (${m.folder} → domain "${m.domainId}") ===`);
  const actions = readList(m.folder, "actions.json", "actions").map((a) => toActionNode(a, m.domainId));
  const objects = readList(m.folder, "objects.json", "objects").map((o) => toObjectNode(o, m.domainId));
  const events = readList(m.folder, "events.json", "events").map((e) => toEventNode(e, m.domainId));
  const rules = readList(m.folder, "rules.json", "rules").map((r) => toRuleNode(r, m.domainId));
  await bulkPost("objects", m.domainId, objects);
  await bulkPost("events", m.domainId, events);
  await bulkPost("rules", m.domainId, rules);
  await bulkPost("actions", m.domainId, actions); // actions last — they reference the rest
}

async function main(): Promise<void> {
  if (!KEY) throw new Error("ALLMETA_API_KEY not set (run with --env-file=.env.local)");
  const only = process.argv[2];
  const targets = only ? MAPPINGS.filter((m) => m.domainId === only || m.folder === only) : MAPPINGS;
  if (!targets.length) throw new Error(`no mapping matches "${only}"`);
  for (const m of targets) await importDomain(m);
  console.log("\n✓ import complete");
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
