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

function makeClient(): PrismaClient {
  // Default to local Postgres; the old SQLite default is gone now that the
  // store has migrated. A bare default keeps a fresh clone from crashing
  // before .env.local is filled in.
  const url =
    process.env.DATABASE_URL ?? "postgresql://ao:ao_local_pw@localhost:5433/ao";
  return new PrismaClient({
    adapter: makeAdapter(url),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma: PrismaClient =
  globalThis.__prismaClient ?? makeClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prismaClient = prisma;
}
