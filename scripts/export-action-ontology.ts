/**
 * Export Action + ActionStep ontology data from neo4j as a replayable cypher script.
 *
 * Usage:
 *   npx tsx scripts/export-action-ontology.ts
 *
 * Output: data/ontology-export.cypher (overwritten each run).
 *
 * Reads NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD / NEO4J_DATABASE from .env.local.
 *
 * What it dumps:
 *   - All (:Action)              nodes
 *   - All (:ActionStep)          nodes
 *   - All (:Action)-[:HAS_STEP]->(:ActionStep) edges
 *   - All (:Rule)-[:GOVERNS]->(:ActionStep) edges
 *
 * The exported cypher uses MERGE everywhere — re-running it on a target neo4j
 * is idempotent. Rule nodes referenced by GOVERNS edges are stubbed (MERGE
 * with id only); if the target also needs full Rule properties, run a
 * separate Rule export and replay it first.
 */

import { config } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import neo4j, { type Driver, type Record as Neo4jRecord, type Session } from "neo4j-driver";

// dotenv only auto-loads .env, not .env.local. Load explicitly.
// override:true so .env.local wins over any shell env vars that may have
// been set ambiently — we want .env.local to be the source of truth.
config({ path: path.resolve(process.cwd(), ".env.local"), override: true });
config({ path: path.resolve(process.cwd(), ".env"), override: false });

const URI = process.env.NEO4J_URI;
const USER = process.env.NEO4J_USERNAME;
const PASSWORD = process.env.NEO4J_PASSWORD;
const DATABASE = process.env.NEO4J_DATABASE || "neo4j";

if (!URI || !USER || !PASSWORD) {
  console.error(
    "✗ Missing neo4j config. Required env (in .env.local):\n" +
      "  NEO4J_URI       (e.g. bolt://localhost:7687)\n" +
      "  NEO4J_USERNAME  (e.g. neo4j)\n" +
      "  NEO4J_PASSWORD",
  );
  process.exit(1);
}

const OUTPUT_PATH = "data/ontology-export.cypher";

// ============================================================================
// Cypher value serialization
// ============================================================================

function cypherValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v); // wraps + escapes
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") return v.toString();
  if (neo4j.isInt(v)) return (v as unknown as { toString: () => string }).toString();
  if (Array.isArray(v)) return `[${v.map(cypherValue).join(", ")}]`;
  if (typeof v === "object") {
    // Plain map — emit as cypher map literal.
    const entries = Object.entries(v as Record<string, unknown>).map(
      ([k, x]) => `${quoteKeyIfNeeded(k)}: ${cypherValue(x)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  // Fallback — best-effort JSON.
  return JSON.stringify(v);
}

function quoteKeyIfNeeded(k: string): string {
  // Cypher map keys must be valid identifiers or wrapped in backticks if not.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `\`${k.replace(/`/g, "")}\``;
}

function propsToCypherMap(props: Record<string, unknown>): string {
  const entries = Object.entries(props).map(
    ([k, v]) => `${quoteKeyIfNeeded(k)}: ${cypherValue(v)}`,
  );
  return `{${entries.join(", ")}}`;
}

function pickKey(props: Record<string, unknown>, label: string): {
  key: string;
  value: unknown;
} {
  if ("id" in props && props.id !== null && props.id !== undefined)
    return { key: "id", value: props.id };
  if ("name" in props && typeof props.name === "string")
    return { key: "name", value: props.name };
  throw new Error(
    `${label} node missing 'id' and 'name' — cannot dedupe on target. Props: ${JSON.stringify(props)}`,
  );
}

// ============================================================================
// Queries
// ============================================================================

async function fetchNodes(
  session: Session,
  label: string,
): Promise<Record<string, unknown>[]> {
  const result = await session.run(`MATCH (n:${label}) RETURN n`);
  return result.records.map((r: Neo4jRecord) => ({ ...r.get("n").properties }));
}

interface RelRecord {
  from: Record<string, unknown>;
  rel: Record<string, unknown>;
  to: Record<string, unknown>;
}

async function fetchRelationships(
  session: Session,
  fromLabel: string,
  type: string,
  toLabel: string,
): Promise<RelRecord[]> {
  const result = await session.run(
    `MATCH (a:${fromLabel})-[r:${type}]->(b:${toLabel}) RETURN a, r, b`,
  );
  return result.records.map((rec: Neo4jRecord) => ({
    from: { ...rec.get("a").properties },
    rel: { ...rec.get("r").properties },
    to: { ...rec.get("b").properties },
  }));
}

// ============================================================================
// Cypher emission
// ============================================================================

function emitNodeMerge(
  label: string,
  props: Record<string, unknown>,
): string {
  const { key, value } = pickKey(props, label);
  return `MERGE (n:${label} {${key}: ${cypherValue(value)}}) SET n = ${propsToCypherMap(props)};`;
}

function emitStubMerge(label: string, props: Record<string, unknown>): string {
  const { key, value } = pickKey(props, label);
  return `MERGE (n:${label} {${key}: ${cypherValue(value)}});`;
}

function emitRelMerge(
  fromLabel: string,
  fromProps: Record<string, unknown>,
  type: string,
  toLabel: string,
  toProps: Record<string, unknown>,
  relProps: Record<string, unknown>,
): string {
  const fk = pickKey(fromProps, fromLabel);
  const tk = pickKey(toProps, toLabel);
  const head = `MATCH (a:${fromLabel} {${fk.key}: ${cypherValue(fk.value)}}), (b:${toLabel} {${tk.key}: ${cypherValue(tk.value)}})`;
  const merge = `MERGE (a)-[r:${type}]->(b)`;
  const setClause =
    Object.keys(relProps).length > 0
      ? ` SET r = ${propsToCypherMap(relProps)}`
      : "";
  return `${head} ${merge}${setClause};`;
}

// ============================================================================
// main
// ============================================================================

async function probeDatabase(session: Session): Promise<void> {
  console.log("\n--- diagnostic probe ---");
  // 1. List all labels in this database.
  try {
    const labels = await session.run("CALL db.labels() YIELD label RETURN label ORDER BY label");
    const labelNames = labels.records.map((r) => r.get("label") as string);
    console.log(`labels in this DB (${labelNames.length}): ${labelNames.join(", ") || "(none)"}`);

    // 2. Count nodes per label.
    if (labelNames.length > 0) {
      console.log("node counts per label:");
      for (const label of labelNames) {
        const count = await session.run(
          `MATCH (n:\`${label}\`) RETURN count(n) AS c`,
        );
        const c = count.records[0]?.get("c");
        const num = neo4j.isInt(c) ? c.toNumber() : Number(c);
        console.log(`  :${label}  = ${num}`);
      }
    }

    // 3. List relationship types.
    const rels = await session.run(
      "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType",
    );
    const relNames = rels.records.map((r) => r.get("relationshipType") as string);
    console.log(`relationship types (${relNames.length}): ${relNames.join(", ") || "(none)"}`);
  } catch (err) {
    console.log(`(probe failed: ${(err as Error).message})`);
  }

  // 4. List databases (best-effort — needs admin privileges + neo4j 4.x+).
  try {
    const dbs = await session.run("SHOW DATABASES YIELD name, currentStatus");
    const dbList = dbs.records.map(
      (r) => `${r.get("name")} (${r.get("currentStatus")})`,
    );
    console.log(`available databases (${dbList.length}): ${dbList.join(", ")}`);
  } catch (err) {
    console.log(`(SHOW DATABASES skipped: ${(err as Error).message.slice(0, 100)})`);
  }
  console.log("--- end probe ---\n");
}

async function main(): Promise<void> {
  console.log(`→ resolved config:`);
  console.log(`    NEO4J_URI      = ${URI}`);
  console.log(`    NEO4J_USERNAME = ${USER}`);
  console.log(`    NEO4J_PASSWORD = ${PASSWORD ? "***set***" : "(empty)"}`);
  console.log(`    NEO4J_DATABASE = ${DATABASE}`);
  console.log(`→ connecting to ${URI}`);
  const driver: Driver = neo4j.driver(URI!, neo4j.auth.basic(USER!, PASSWORD!));
  const session: Session = driver.session({ database: DATABASE });

  const lines: string[] = [];
  lines.push("// ===========================================================================");
  lines.push("// Action + ActionStep ontology export");
  lines.push(`// Source:    ${URI} (database=${DATABASE})`);
  lines.push(`// Generated: ${new Date().toISOString()}`);
  lines.push("// ");
  lines.push("// Replay on a target neo4j to import the same data:");
  lines.push("//   cat ontology-export.cypher | cypher-shell -u neo4j -p <pwd>");
  lines.push("// or paste into neo4j Browser.");
  lines.push("// ");
  lines.push("// All statements use MERGE — re-running is idempotent.");
  lines.push("// Rule nodes referenced by GOVERNS edges are stubbed (id only); run a");
  lines.push("// separate Rule export if you need full Rule properties on the target.");
  lines.push("// ===========================================================================");
  lines.push("");

  // --- Action nodes ---
  const actions = await fetchNodes(session, "Action");
  lines.push(`// ${actions.length} Action nodes`);
  for (const a of actions) {
    lines.push(emitNodeMerge("Action", a));
  }
  lines.push("");

  // --- ActionStep nodes ---
  const steps = await fetchNodes(session, "ActionStep");
  lines.push(`// ${steps.length} ActionStep nodes`);
  for (const s of steps) {
    lines.push(emitNodeMerge("ActionStep", s));
  }
  lines.push("");

  // --- HAS_STEP relationships ---
  const hasSteps = await fetchRelationships(session, "Action", "HAS_STEP", "ActionStep");
  lines.push(`// ${hasSteps.length} HAS_STEP relationships`);
  for (const { from, rel, to } of hasSteps) {
    lines.push(emitRelMerge("Action", from, "HAS_STEP", "ActionStep", to, rel));
  }
  lines.push("");

  // --- GOVERNS relationships (Rule → ActionStep) + Rule stubs ---
  const governs = await fetchRelationships(session, "Rule", "GOVERNS", "ActionStep");
  // Dedupe Rule stubs by their key. Rule is the FROM side, so we look at .from.
  const ruleStubKeys = new Set<string>();
  const ruleStubLines: string[] = [];
  for (const { from } of governs) {
    const stub = emitStubMerge("Rule", from);
    if (!ruleStubKeys.has(stub)) {
      ruleStubKeys.add(stub);
      ruleStubLines.push(stub);
    }
  }
  lines.push(`// ${ruleStubLines.length} Rule stubs (referenced by GOVERNS)`);
  for (const stub of ruleStubLines) lines.push(stub);
  lines.push("");
  lines.push(`// ${governs.length} GOVERNS relationships (Rule)-[:GOVERNS]->(ActionStep)`);
  for (const { from, rel, to } of governs) {
    lines.push(emitRelMerge("Rule", from, "GOVERNS", "ActionStep", to, rel));
  }
  lines.push("");

  // --- Write file ---
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, lines.join("\n"), "utf8");

  console.log(
    `✓ wrote ${OUTPUT_PATH}\n` +
      `  ${actions.length} Action · ${steps.length} ActionStep · ${hasSteps.length} HAS_STEP · ${governs.length} GOVERNS (+ ${ruleStubLines.length} Rule stubs)`,
  );

  // If everything was empty, probe what's actually in the DB so the user can
  // see whether they're connected to the wrong database or whether the labels
  // are different on this deployment.
  if (
    actions.length === 0 &&
    steps.length === 0 &&
    hasSteps.length === 0 &&
    governs.length === 0
  ) {
    console.log(
      "\n⚠ Nothing was found. Probing the database so you can see what's actually there:",
    );
    await probeDatabase(session);
    console.log(
      "Common causes:\n" +
        `  1. Wrong database — current is "${DATABASE}". Try setting NEO4J_DATABASE in .env.local.\n` +
        "  2. Label name mismatch — the data may use different labels (case-sensitive).\n" +
        "  3. Empty database — the data isn't loaded yet.\n",
    );
  }

  await session.close();
  await driver.close();
}

main().catch(async (err) => {
  console.error("✗ export failed:", err);
  process.exit(1);
});
