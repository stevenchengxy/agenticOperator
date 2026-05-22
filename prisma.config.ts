// `dotenv/config` ONLY loads `.env` — but Next.js's runtime loads `.env.local`
// first (and `.env` second). If we used `import "dotenv/config"` here,
// `prisma db push` would silently push to a DIFFERENT db than the running
// app, since DATABASE_URL would resolve from .env (or fall back to default)
// while Next.js opens whatever .env.local says. Load .env.local FIRST so
// Prisma sees the same DATABASE_URL Next.js does.
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { defineConfig } from "prisma/config";

loadEnv({ path: path.resolve(process.cwd(), ".env.local") });
loadEnv({ path: path.resolve(process.cwd(), ".env") });

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  // Direct connection from URL env var; works for both SQLite and Postgres.
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./data/ao.db",
  },
});
