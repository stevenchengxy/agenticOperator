// Prisma client singleton (P3 foundation).
// Server-only. Imported by Route Handlers and server-side modules.
//
// In dev, Next.js hot-reloads can otherwise create multiple PrismaClient
// instances; the global cache prevents that (and reuses the underlying
// connection pool across HMR cycles).
//
// 2026-05-28: dual-adapter. The store is now local Postgres (durable,
// concurrent-safe); the SQLite adapter is kept only so the one-time
// migration script (scripts/migrate-sqlite-to-pg.ts) can still open the
// legacy data/ao.db. Selection is by DATABASE_URL scheme:
//   postgresql:// | postgres://  → PrismaPg   (default, prod + dev)
//   file:                        → better-sqlite3 (legacy / migration only)
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

declare global {

  var __prismaClient: PrismaClient | undefined;
}

function isPostgresUrl(url: string): boolean {
  return url.startsWith("postgresql://") || url.startsWith("postgres://");
}

function makeAdapter(url: string) {
  if (isPostgresUrl(url)) {
    // PrismaPg manages its own pg.Pool from the connection string.
    return new PrismaPg(url);
  }
  // Legacy SQLite: strip the "file:" prefix for the better-sqlite3 driver.
  const dbPath = url.replace(/^file:/, "");
  return new PrismaBetterSqlite3({ url: dbPath });
}

// node/pg network-layer "can't connect" codes (business/SQL errors excluded).
const CONN_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ECONNRESET",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "EAI_AGAIN",
]);

/**
 * True when an error MESSAGE looks like a "can't reach the database" failure.
 * Best-effort only: in Next.js dev, Prisma's 'pretty' errorFormat replaces the
 * reason with a code frame, so the message that reaches the `error` LOG EVENT
 * omits this text entirely — which is exactly why we ALSO key off the error
 * code (see isDbUnreachableError) and a circuit breaker below.
 */
export function isDbUnreachableMessage(message: string): boolean {
  return (
    /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET|EHOSTDOWN|ENETUNREACH|ENETDOWN|EPIPE|EAI_AGAIN)\b/.test(
      message,
    ) ||
    /Can't reach database server|Connection terminated|connection timeout|timeout expired|\bP100[12]\b/i.test(
      message,
    )
  );
}

/**
 * True when a THROWN error is a connection failure rather than a real query
 * bug. Unlike the log-event message, a thrown error carries a CODE — Prisma's
 * P1001/P1002 ("Can't reach database server") or a node/pg conn code — which is
 * format-independent, so this is the reliable signal callers use in `catch`.
 */
export function isDbUnreachableError(err: unknown): boolean {
  const e = err as { code?: unknown; errorCode?: unknown; message?: unknown } | null;
  const code =
    typeof e?.code === "string"
      ? e.code
      : typeof e?.errorCode === "string"
        ? e.errorCode
        : "";
  if (code === "P1001" || code === "P1002" || CONN_CODES.has(code)) return true;
  return typeof e?.message === "string" && isDbUnreachableMessage(e.message);
}

// ── Flood control ─────────────────────────────────────────────────────────
// When Postgres is unreachable EVERY query fails. With string `log`, Prisma
// auto-prints a multi-line `prisma:error` per call; the 30s heartbeat plus the
// 4s /api/agents/health poll then flood the console endlessly. We route engine
// errors through an event handler instead and collapse the noise:
//
//   • Circuit breaker: a caught connection error (which HAS the P1001 code)
//     calls markDbUnreachable(); while the breaker is hot we emit ONE throttled
//     "[db] unreachable" notice and drop the per-query spam — this is what makes
//     it work under Next dev, whose event message lacks the reason text.
//   • Best-effort classify: when the message DOES carry the reason (most envs),
//     we collapse it without needing the breaker.
//   • Throttle fallback: anything else prints, but repeats of the same signature
//     are rate-limited so even an unclassified error can never flood.
const DB_DOWN_TTL_MS = 60_000;
const NOTICE_THROTTLE_MS = 60_000;
const ERR_THROTTLE_MS = 60_000;

let dbDownAt = 0;
let lastNoticeAt = 0;
const errLastAt = new Map<string, number>();

/** Prime the "database is unreachable" circuit breaker. Called from `catch`
 *  blocks that see a connection error — the reliable, format-independent path. */
export function markDbUnreachable(): void {
  dbDownAt = Date.now();
}

function dbProbablyDown(): boolean {
  return dbDownAt > 0 && Date.now() - dbDownAt < DB_DOWN_TTL_MS;
}

function emitUnreachableNotice(target: string): void {
  const now = Date.now();
  if (now - lastNoticeAt < NOTICE_THROTTLE_MS) return;
  lastNoticeAt = now;
  console.warn(
    `[db] Postgres unreachable (${target}) — DB-backed features are inert until it's up. Start it with \`npm run pg:up\`.`,
  );
}

/** Handle one Prisma `error` log event. Exported so the Next-dev message shape
 *  (no reason text) can be unit-tested directly. */
export function handlePrismaError(message: string, target = "database"): void {
  if (dbProbablyDown() || isDbUnreachableMessage(message)) {
    markDbUnreachable(); // keep the breaker hot while the outage continues
    emitUnreachableNotice(target);
    return;
  }
  // Not a known outage and not classifiable → print, but rate-limit repeats of
  // the same failing query so nothing can flood (the volatile file:line tail is
  // dropped from the key so identical failures collapse).
  const key = (message.split("invocation")[0] || message.slice(0, 120)).trim();
  const now = Date.now();
  if (now - (errLastAt.get(key) ?? 0) < ERR_THROTTLE_MS) return;
  if (errLastAt.size > 200) errLastAt.clear();
  errLastAt.set(key, now);
  console.error(`prisma:error ${message}`);
}

/** Test-only: reset module-level flood-control state. */
export function __resetFloodStateForTest(): void {
  dbDownAt = 0;
  lastNoticeAt = 0;
  errLastAt.clear();
}

function redactTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "database";
  }
}

function makeClient(): PrismaClient {
  // Default to local Postgres; the old SQLite default is gone now that the
  // store has migrated. A bare default keeps a fresh clone from crashing
  // before .env.local is filled in.
  const url =
    process.env.DATABASE_URL ?? "postgresql://ao:ao_local_pw@localhost:5433/ao";
  const target = redactTarget(url);
  const client = new PrismaClient({
    adapter: makeAdapter(url),
    // Emit (don't auto-print) so the handler below controls the noise.
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
  });
  client.$on("error", (e) => handlePrismaError(e.message, target));
  // Match the old behavior: warnings only surface in dev.
  if (process.env.NODE_ENV === "development") {
    client.$on("warn", (e) => {
      console.warn(`prisma:warn ${e.message}`);
    });
  }
  return client;
}

export const prisma: PrismaClient =
  globalThis.__prismaClient ?? makeClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prismaClient = prisma;
}
