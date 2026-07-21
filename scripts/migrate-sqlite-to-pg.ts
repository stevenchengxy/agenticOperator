// One-time migration: copy all rows from the legacy SQLite db (data/ao.db)
// into the new local Postgres (DATABASE_URL). Idempotent — safe to re-run
// (uses createMany skipDuplicates). The Prisma client is now Postgres-only,
// so the SQLite side is read with raw better-sqlite3; rows are coerced to
// JS types (DateTime ISO-string→Date, Boolean 0/1→bool) using the Postgres
// client's DMMF, then bulk-inserted via Prisma.
//
//   npm run db:migrate-from-sqlite               # additive copy
//   npm run db:migrate-from-sqlite -- --wipe     # truncate PG tables first
//
// Source path override: SQLITE_SOURCE (default ./data/ao.db).
// See docs/superpowers/specs/2026-05-28-local-postgres-inngest-archive-design.md

import Database from "better-sqlite3";
import { Prisma } from "@prisma/client";
import { prisma } from "../server/db/index";

const SQLITE_SOURCE = process.env.SQLITE_SOURCE ?? "./data/ao.db";
const WIPE = process.argv.includes("--wipe");
const CHUNK = 200;

// Child models hold a FK to a parent → must be inserted AFTER their parent.
// (Only 6 relations in the schema; the rest are FK-free.) Postgres enforces
// FKs and Prisma's default constraints are not deferrable, so we insert
// non-children first, then children.
const CHILD_MODELS = new Set([
  "WorkflowStep",
  "AgentActivity",
  "AgentConfigHistory",
  "JobDescription",
  "RuleCheckFlag",
  "RuleCheckScenarioResult",
  "InngestStepArchive",
]);

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function coerce(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "DateTime":
      return value instanceof Date ? value : new Date(value as string | number);
    case "Boolean":
      return value === 1 || value === true || value === "1" || value === "true";
    case "Int":
      return typeof value === "number" ? value : Number(value);
    case "Float":
      return typeof value === "number" ? value : Number(value);
    case "BigInt":
      return BigInt(value as string | number);
    default:
      return value; // String / Json-as-text — pass through
  }
}

async function main() {
  const db = new Database(SQLITE_SOURCE, { readonly: true });
  const sqliteTables = new Set(
    (
      db
        .prepare(
          "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '_prisma%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );

  const models = Prisma.dmmf.datamodel.models;
  // Ordered: parents (non-children) first, then children.
  const ordered = [
    ...models.filter((m) => !CHILD_MODELS.has(m.name)),
    ...models.filter((m) => CHILD_MODELS.has(m.name)),
  ];

  if (WIPE) {
    // Truncate in reverse order (children first) with CASCADE for safety.
    console.log("[migrate] --wipe: truncating Postgres tables…");
    const tableNames = models.map((m) => `"${m.dbName ?? m.name}"`);
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tableNames.join(", ")} RESTART IDENTITY CASCADE`,
    );
  }

  let grandTotal = 0;
  for (const model of ordered) {
    const sqliteTable = model.dbName ?? model.name;
    if (!sqliteTables.has(sqliteTable)) {
      // e.g. new inngest_* archive tables don't exist in the old SQLite file.
      continue;
    }
    const scalarFields = model.fields.filter((f) => f.kind !== "object");
    const rows = db.prepare(`SELECT * FROM "${sqliteTable}"`).all() as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) continue;

    const delegate = (prisma as Record<string, any>)[lowerFirst(model.name)];
    if (!delegate?.createMany) {
      console.warn(`[migrate] no delegate for ${model.name}, skipping`);
      continue;
    }

    const data = rows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (const f of scalarFields) {
        const col = f.dbName ?? f.name;
        if (!(col in row)) continue;
        obj[f.name] = coerce(row[col], f.type);
      }
      return obj;
    });

    let inserted = 0;
    for (let i = 0; i < data.length; i += CHUNK) {
      const chunk = data.slice(i, i + CHUNK);
      const res = await delegate.createMany({ data: chunk, skipDuplicates: true });
      inserted += res.count;
    }
    grandTotal += inserted;
    console.log(
      `[migrate] ${model.name}: ${inserted}/${rows.length} inserted` +
        (inserted < rows.length ? ` (${rows.length - inserted} dup/skipped)` : ""),
    );
  }

  db.close();
  await prisma.$disconnect();
  console.log(`[migrate] done — ${grandTotal} rows copied into Postgres.`);
}

main().catch(async (e) => {
  console.error("[migrate] FAILED:", e);
  await prisma.$disconnect();
  process.exit(1);
});
