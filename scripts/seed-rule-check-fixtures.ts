/**
 * Seed all 14 rule-check test scenarios into the Ontology API.
 *
 * Usage:
 *   npx tsx scripts/seed-rule-check-fixtures.ts
 *   npx tsx scripts/seed-rule-check-fixtures.ts --dry-run   # only print schemas
 *   npx tsx scripts/seed-rule-check-fixtures.ts --verbose
 *
 * Reads ONTOLOGY_API_BASE / ONTOLOGY_API_TOKEN from .env.local.
 * See docs/ontology/action_object_prompt/match-resume-data-preparation-design.md
 * for the full data design.
 */

import { config } from "dotenv";
import path from "node:path";
import {
  DOMAIN,
  LINK_SPECS,
  SCENARIOS,
  SHARED_JDS,
  type LinkEntityRole,
  type LinkSpec,
  type ScenarioFixture,
} from "./rule-check-test-suite/fixtures";

config({ path: path.resolve(process.cwd(), ".env.local"), override: true });
config({ path: path.resolve(process.cwd(), ".env"), override: false });

const API_BASE = process.env.ONTOLOGY_API_BASE?.replace(/\/+$/, "");
const TOKEN = process.env.ONTOLOGY_API_TOKEN;
if (!API_BASE || !TOKEN) {
  console.error("✗ Missing ONTOLOGY_API_BASE or ONTOLOGY_API_TOKEN in .env.local");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const VERBOSE = args.has("--verbose");

// ============================================================================
// HTTP helpers
// ============================================================================

async function apiGet<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  if (VERBOSE) console.log(`  GET  ${url}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status}. Body: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  if (VERBOSE) console.log(`  POST ${url} ${JSON.stringify(body).slice(0, 200)}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `POST ${path} → ${res.status}. Body: ${errBody.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

// ============================================================================
// Schema fetch + property whitelist
// ============================================================================

interface SchemaProperty {
  name: string;
  type?: string; // "string" | "integer" | "boolean" | "date" | "List<JSON>" | ...
  is_required?: boolean;
}

interface ObjectSchema {
  id: string;
  primary_key?: string;
  properties?: SchemaProperty[];
}

interface LinkInstance {
  type: string;
  fromId?: string;
  toId?: string;
  fromLabel?: string;
  toLabel?: string;
}

interface Stats {
  schemas: number;
  jds: number;
  candidates: number;
  resumes: number;
  blacklists: number;
  applications: number;
  links: number;
  failures: string[];
}

const SCHEMAS_NEEDED = [
  "Candidate",
  "Resume",
  "Job_Requisition",
  "Application",
  "Blacklist",
];

/**
 * The Ontology API returns `properties` as a JSON-stringified array of
 * property objects (not an actual array), and uses capitalized type names
 * ("String", "Integer", "Date", "Timestamp", "Boolean"). Normalize both so
 * the rest of the script can treat the schema as plain JS.
 */
function normalizeSchema(raw: unknown): ObjectSchema | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  let properties: SchemaProperty[] | undefined;
  const rawProps = r.properties;
  if (typeof rawProps === "string") {
    try {
      const parsed = JSON.parse(rawProps);
      if (Array.isArray(parsed)) properties = parsed as SchemaProperty[];
    } catch {
      // Leave undefined — caller falls back to "send props verbatim".
    }
  } else if (Array.isArray(rawProps)) {
    properties = rawProps as SchemaProperty[];
  }
  if (properties) {
    properties = properties.map((p) => ({
      ...p,
      type: typeof p.type === "string" ? p.type.toLowerCase() : p.type,
    }));
  }
  return {
    id: typeof r.id === "string" ? r.id : "",
    primary_key:
      typeof r.primary_key === "string" ? r.primary_key : undefined,
    properties,
  };
}

async function fetchObjectSchema(label: string): Promise<ObjectSchema | null> {
  try {
    const raw = await apiGet<unknown>(
      `/api/v1/ontology/objects/${encodeURIComponent(label)}?domain=${DOMAIN}`,
    );
    return normalizeSchema(raw);
  } catch (err) {
    console.warn(`  ⚠ Could not fetch schema for ${label}: ${(err as Error).message}`);
    return null;
  }
}

interface LinkSchemaObservation {
  fromSchema: string; // DataObject id, e.g. "Candidate" — these ARE the labels
  toSchema: string;
  type: string;
  sampleCount: number;
}

/**
 * Fetch link schema definitions. In this ontology, the link schema is stored
 * as edges between :DataObject nodes — i.e. each entry's fromId / toId is the
 * DataObject's id (which IS the label name like "Candidate"). The literal
 * fromLabel / toLabel are always "DataObject", which is useless for our
 * purposes; we read fromId/toId instead.
 */
async function fetchExistingLinkTypes(): Promise<{
  allTypes: Set<string>;
  observations: LinkSchemaObservation[];
}> {
  try {
    const res = await apiGet<{ items?: LinkInstance[] }>(
      `/api/v1/ontology/links?domain=${DOMAIN}&limit=1000`,
    );
    const items = res.items ?? [];
    const allTypes = new Set(items.map((l) => l.type));

    // Group by (fromId, toId, type) — fromId/toId are DataObject names.
    const counts = new Map<string, LinkSchemaObservation>();
    for (const l of items) {
      if (!l.fromId || !l.toId) continue;
      const key = `${l.fromId}|${l.toId}|${l.type}`;
      const existing = counts.get(key);
      if (existing) existing.sampleCount += 1;
      else
        counts.set(key, {
          fromSchema: l.fromId,
          toSchema: l.toId,
          type: l.type,
          sampleCount: 1,
        });
    }
    return { allTypes, observations: [...counts.values()] };
  } catch (err) {
    console.warn(`  ⚠ Could not list existing links: ${(err as Error).message}`);
    return { allTypes: new Set(), observations: [] };
  }
}

function filterToSchema(
  schema: ObjectSchema | null,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema?.properties) {
    if (VERBOSE)
      console.log(`    (no schema for filtering, sending all props verbatim)`);
    return payload;
  }
  const declared = new Set(schema.properties.map((p) => p.name));
  const accepted: Record<string, unknown> = { domainId: payload.domainId };
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (k === "domainId") continue;
    if (declared.has(k)) accepted[k] = v;
    else dropped.push(k);
  }
  if (dropped.length > 0 && VERBOSE) {
    console.log(`    (dropped props not in ${schema.id} schema: ${dropped.join(", ")})`);
  }
  return accepted;
}

/**
 * Some schemas store complex objects as serialized JSON strings (type: "string"
 * or "List<JSON>"). We try to send native objects/arrays, and the server's
 * own type-coercion handles it; this is best-effort.
 */
function maybeStringify(value: unknown, propertyType?: string): unknown {
  if (
    propertyType === "string" &&
    (Array.isArray(value) || (typeof value === "object" && value !== null))
  ) {
    return JSON.stringify(value);
  }
  return value;
}

function shapeForSchema(
  schema: ObjectSchema | null,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const filtered = filterToSchema(schema, payload);
  if (!schema?.properties) return filtered;
  // Coerce nested objects/arrays into JSON strings when the property is typed string.
  const propTypes = new Map(schema.properties.map((p) => [p.name, p.type]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filtered)) {
    out[k] = maybeStringify(v, propTypes.get(k));
  }
  return out;
}

// ============================================================================
// Per-label POST helpers
// ============================================================================

const schemas = new Map<string, ObjectSchema | null>();

async function upsertInstance(
  label: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const shaped = shapeForSchema(schemas.get(label) ?? null, payload);
  // Server requires ?domain=... on POST too (not just on body's domainId).
  await apiPost(
    `/api/v1/ontology/instances/${encodeURIComponent(label)}?domain=${DOMAIN}`,
    {
      ...shaped,
      domainId: DOMAIN,
    },
  );
}

/** Maps a LinkEntityRole to the neo4j label used in the instance-links body. */
const ROLE_TO_LABEL: Record<LinkEntityRole, string> = {
  candidate: "Candidate",
  resume: "Resume",
  blacklist: "Blacklist",
  application: "Application",
  job_requisition: "Job_Requisition",
};

async function upsertInstanceLink(
  linkName: string,
  fromRole: LinkEntityRole,
  fromPk: string,
  toRole: LinkEntityRole,
  toPk: string,
  properties: Record<string, unknown> = {},
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  try {
    await apiPost(`/api/v1/ontology/instance-links?domain=${DOMAIN}`, {
      linkName,
      from: { label: ROLE_TO_LABEL[fromRole], pk: fromPk },
      to: { label: ROLE_TO_LABEL[toRole], pk: toPk },
      properties,
    });
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message;
    // Idempotent re-run: server may return a "duplicate / already exists / link-exists"
    // pattern on the second POST. Treat as success-skip rather than failure.
    if (/already.exists|duplicate|link[- _]exists|conflict/i.test(msg)) {
      return { ok: true, skipped: true };
    }
    return { ok: false, error: msg };
  }
}

// ============================================================================
// Seeding logic
// ============================================================================

async function seedJds(stats: Stats): Promise<void> {
  for (const jd of SHARED_JDS) {
    try {
      await upsertInstance("Job_Requisition", { ...jd });
      stats.jds++;
    } catch (err) {
      stats.failures.push(
        `Job_Requisition ${jd.job_requisition_id}: ${(err as Error).message.slice(0, 120)}`,
      );
    }
  }
  console.log(`  ✓ ${stats.jds}/${SHARED_JDS.length} JDs`);
}

async function seedScenarios(stats: Stats): Promise<void> {
  for (const sc of SCENARIOS) {
    await seedOneScenario(sc, stats);
  }
  console.log(
    `  ✓ ${stats.candidates}/${SCENARIOS.length} candidates · ` +
      `${stats.resumes}/${SCENARIOS.length} resumes · ` +
      `${stats.blacklists} blacklists · ${stats.applications} applications`,
  );
}

async function seedOneScenario(
  sc: ScenarioFixture,
  stats: Stats,
): Promise<void> {
  if (VERBOSE) console.log(`\n[${sc.id}] ${sc.name}`);

  // Candidate
  try {
    await upsertInstance("Candidate", {
      candidate_id: sc.candidate_id,
      ...sc.candidate,
    });
    stats.candidates++;
  } catch (err) {
    stats.failures.push(`${sc.id} Candidate: ${(err as Error).message.slice(0, 120)}`);
    return; // can't link anything without the candidate
  }

  // Resume (carries candidate_id property — required for listInstances filter)
  try {
    await upsertInstance("Resume", {
      resume_id: sc.resume_id,
      candidate_id: sc.candidate_id,
      ...sc.resume,
    });
    stats.resumes++;
  } catch (err) {
    stats.failures.push(`${sc.id} Resume: ${(err as Error).message.slice(0, 120)}`);
  }

  // Blacklist instance (link comes from LINK_SPECS-driven pass below)
  if (sc.blacklist) {
    try {
      await upsertInstance("Blacklist", {
        blacklist_id: sc.blacklist.blacklist_id,
        candidate_id: sc.candidate_id,
        lock_reason: sc.blacklist.lock_reason,
        lock_duration: sc.blacklist.lock_duration,
      });
      stats.blacklists++;
    } catch (err) {
      stats.failures.push(`${sc.id} Blacklist: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  // Application instances (links from LINK_SPECS-driven pass below)
  if (sc.applications) {
    for (const app of sc.applications) {
      try {
        await upsertInstance("Application", {
          application_id: app.application_id,
          candidate_id: sc.candidate_id,
          job_requisition_id: app.job_requisition_id,
          status: app.status,
          push_timestamp: app.push_timestamp,
        });
        stats.applications++;
      } catch (err) {
        stats.failures.push(
          `${sc.id} Application: ${(err as Error).message.slice(0, 120)}`,
        );
      }
    }
  }

  // Links — driven entirely off LINK_SPECS (no hardcoded type names).
  await seedLinksForScenario(sc, stats);
}

/**
 * Resolve an entity role → array of IDs that exist for this scenario.
 * Applications are 0..N; Blacklist is 0..1; others are always 1.
 */
function resolveEntityIds(
  sc: ScenarioFixture,
  role: LinkEntityRole,
): string[] {
  switch (role) {
    case "candidate":
      return [sc.candidate_id];
    case "resume":
      return [sc.resume_id];
    case "blacklist":
      return sc.blacklist ? [sc.blacklist.blacklist_id] : [];
    case "application":
      return (sc.applications ?? []).map((a) => a.application_id);
    case "job_requisition":
      // For application↔JD links we use the application's target JR, not
      // necessarily sc.job_requisition_id. Resolved per-application below.
      return [sc.job_requisition_id];
  }
}

async function seedLinksForScenario(
  sc: ScenarioFixture,
  stats: Stats,
): Promise<void> {
  for (const spec of LINK_SPECS) {
    const fromPks = resolveEntityIds(sc, spec.fromEntity);
    const toPks = resolveEntityIds(sc, spec.toEntity);
    if (fromPks.length === 0 || toPks.length === 0) {
      // Scenario lacks the entity for this spec — silently skip.
      continue;
    }
    // Special-case Application↔Job_Requisition: the JD pk comes from the
    // application's job_requisition_id, not sc.job_requisition_id.
    if (spec.fromEntity === "application" && spec.toEntity === "job_requisition") {
      for (const app of sc.applications ?? []) {
        await maybeCreateInstanceLink(
          spec.type,
          spec.fromEntity,
          app.application_id,
          spec.toEntity,
          app.job_requisition_id,
          stats,
          sc.id,
        );
      }
      continue;
    }
    if (spec.fromEntity === "job_requisition" && spec.toEntity === "application") {
      for (const app of sc.applications ?? []) {
        await maybeCreateInstanceLink(
          spec.type,
          spec.fromEntity,
          app.job_requisition_id,
          spec.toEntity,
          app.application_id,
          stats,
          sc.id,
        );
      }
      continue;
    }
    // General case: cartesian (usually 1×1 except when an entity is a list).
    for (const fromPk of fromPks) {
      for (const toPk of toPks) {
        await maybeCreateInstanceLink(
          spec.type,
          spec.fromEntity,
          fromPk,
          spec.toEntity,
          toPk,
          stats,
          sc.id,
        );
      }
    }
  }
}

async function maybeCreateInstanceLink(
  linkName: string,
  fromRole: LinkEntityRole,
  fromPk: string,
  toRole: LinkEntityRole,
  toPk: string,
  stats: Stats,
  scenarioId: string,
): Promise<void> {
  const result = await upsertInstanceLink(linkName, fromRole, fromPk, toRole, toPk);
  if (result.ok) {
    if (!result.skipped) stats.links++;
    if (result.skipped && VERBOSE) {
      console.log(
        `    ⊙ link ${linkName} ${fromPk}→${toPk}: already exists (kept)`,
      );
    }
  } else {
    stats.failures.push(
      `${scenarioId} link ${linkName} ${fromPk}→${toPk}: ${result.error?.slice(0, 160)}`,
    );
    if (VERBOSE)
      console.log(`    ✗ link ${linkName}: ${result.error?.slice(0, 160)}`);
  }
}


// ============================================================================
// main
// ============================================================================

async function main(): Promise<void> {
  console.log(`→ ONTOLOGY_API_BASE = ${API_BASE}`);
  console.log(`→ domain            = ${DOMAIN}`);
  console.log(`→ dry-run           = ${DRY_RUN}`);
  console.log("");

  // 1. Fetch object schemas
  console.log("── Step 1/4: Fetching object schemas ──");
  for (const label of SCHEMAS_NEEDED) {
    const schema = await fetchObjectSchema(label);
    schemas.set(label, schema);
    if (schema?.properties) {
      const names = schema.properties.map((p) => p.name);
      console.log(`  ${label}: pk=${schema.primary_key ?? "?"}, ${names.length} props`);
      console.log(`    properties: ${names.join(", ")}`);
    } else {
      console.log(`  ${label}: (no schema — will send props verbatim)`);
    }
  }
  console.log("");

  // 2. Probe link schema (read from DataObject-level edges)
  console.log("── Step 2/4: Probing existing link schema ──");
  const { allTypes, observations } = await fetchExistingLinkTypes();
  console.log(
    `  Total schema edges: ${observations.length} distinct (fromSchema, toSchema, type) triples`,
  );

  const RELEVANT_LABELS = new Set([
    "Candidate",
    "Resume",
    "Blacklist",
    "Application",
    "Job_Requisition",
  ]);
  const relevant = observations.filter(
    (o) => RELEVANT_LABELS.has(o.fromSchema) || RELEVANT_LABELS.has(o.toSchema),
  );

  console.log("");
  console.log(
    `  Edges touching the 5 labels we care about (${RELEVANT_LABELS.size}: ${[...RELEVANT_LABELS].join(", ")}):`,
  );
  if (relevant.length === 0) {
    console.log("    (none found)");
  } else {
    const sorted = [...relevant].sort((a, b) =>
      `${a.fromSchema}|${a.toSchema}|${a.type}`.localeCompare(
        `${b.fromSchema}|${b.toSchema}|${b.type}`,
      ),
    );
    for (const o of sorted) {
      console.log(
        `    (:${o.fromSchema})-[:${o.type}]->(:${o.toSchema})`,
      );
    }
  }
  void allTypes;

  console.log("");
  console.log("  Configured LINK_SPECS in fixtures.ts:");
  if (LINK_SPECS.length === 0) {
    console.log("    (none — no links will be created; only property writes)");
  } else {
    for (const s of LINK_SPECS) {
      console.log(
        `    type=${s.type}  from=${s.fromEntity}  to=${s.toEntity}`,
      );
    }
  }
  console.log("");

  if (DRY_RUN) {
    console.log("── Dry run — exiting before any writes ──");
    return;
  }

  // 3-4. Write data
  const stats: Stats = {
    schemas: schemas.size,
    jds: 0,
    candidates: 0,
    resumes: 0,
    blacklists: 0,
    applications: 0,
    links: 0,
    failures: [],
  };

  console.log("── Step 3/4: Seeding shared base data ──");
  await seedJds(stats);
  console.log("");

  console.log("── Step 4/4: Seeding 14 scenarios ──");
  void allTypes;
  await seedScenarios(stats);
  console.log("");

  console.log("── Summary ──");
  console.log(
    `  ${stats.candidates} candidates · ${stats.resumes} resumes · ` +
      `${stats.jds} JDs · ` +
      `${stats.blacklists} blacklists · ${stats.applications} applications`,
  );
  console.log(`  ${stats.links} links written`);
  if (stats.failures.length > 0) {
    console.log(`\n  ✗ ${stats.failures.length} failures:`);
    for (const f of stats.failures) console.log(`    - ${f}`);
  } else {
    console.log("  ✓ no failures");
  }
}

main().catch((err) => {
  console.error("✗ seed failed:", err);
  process.exit(1);
});
