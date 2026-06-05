#!/usr/bin/env node
// Idempotent first-run setup for `npm run dev`.
//
// Goal: a fresh `git clone` + `npm install` + `npm run dev` boots the app,
// regardless of what's missing on the partner's machine.
//
// Steps (each one is no-op when already satisfied):
//   1. Create `.env.local` from `.env.example` if missing.
//   2. Provision the local Postgres (docker-compose.postgres.yml) and sync the
//      Prisma schema. Soft-fail if Docker is down so `next dev` still launches.
//   3. Best-effort start the Inngest dev container (soft-fail).
//   4. Best-effort start the Inngest archiver in the background (dedup-guarded,
//      soft-fail) so the durable mirror keeps filling while you develop.

import { existsSync, copyFileSync, mkdirSync, openSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const log = (m) => console.log(`[bootstrap] ${m}`);
const warn = (m) => console.warn(`[bootstrap] ⚠ ${m}`);

// 1. .env.local
const envLocal = resolve(ROOT, ".env.local");
const envExample = resolve(ROOT, ".env.example");
if (!existsSync(envLocal)) {
  if (existsSync(envExample)) {
    copyFileSync(envExample, envLocal);
    log("created .env.local from .env.example — fill in API keys as needed");
  } else {
    warn(".env.example missing; cannot scaffold .env.local");
  }
}

const dockerUp = (() => {
  try {
    execSync("docker info", { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// 2. Local Postgres + schema sync
let pgReady = false;
if (dockerUp) {
  try {
    log("starting local Postgres (docker-compose.postgres.yml)…");
    // --wait blocks until the healthcheck passes; idempotent when already up.
    execSync("docker compose -f docker-compose.postgres.yml up -d --wait", {
      cwd: ROOT,
      stdio: "inherit",
    });
    log("syncing Prisma schema (`prisma db push`)…");
    // No forced DATABASE_URL — prisma.config.ts loads .env.local (Postgres).
    execSync("npx prisma db push", { cwd: ROOT, stdio: "inherit" });
    pgReady = true;
  } catch (e) {
    warn(`Postgres provisioning failed: ${e.message}`);
    warn("app will boot but DB-backed routes will throw until Postgres is up.");
    warn("manual: `npm run pg:up && npx prisma db push`");
  }
} else {
  warn("Docker daemon unreachable — skipping Postgres provisioning.");
  warn("start Docker, then run `npm run pg:up && npx prisma db push`.");
}

// 3. Inngest event bus (soft-fail) — prefer Docker, fall back to local CLI hint
const localInngestCli = resolve(ROOT, "node_modules/.bin/inngest-cli");
const hasLocalCli = existsSync(localInngestCli);

if (!dockerUp) {
  if (hasLocalCli) {
    warn("fallback: run `npm run inngest:dev` in another terminal (local CLI, no Docker)");
  } else {
    warn("no local inngest-cli — run `npm install`, then `npm run inngest:dev`");
  }
  warn("UI will load; event stream / agent runs are inert until Inngest is up");
} else {
  try {
    execSync("docker compose -f docker-compose.inngest.yml up -d", {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch (e) {
    warn(`Inngest container start failed: ${e.message}`);
    if (hasLocalCli) {
      warn("fallback: run `npm run inngest:dev` in another terminal (local CLI, no Docker)");
    }
    warn("continuing without Inngest container");
  }
}

// 4. Inngest archiver (durable mirror) — background, dedup-guarded, soft-fail.
if (pgReady && process.env.ARCHIVE_ENABLED !== "0") {
  let alreadyRunning = false;
  try {
    execSync("pgrep -f scripts/inngest-archiver", { cwd: ROOT, stdio: "ignore" });
    alreadyRunning = true;
  } catch {
    alreadyRunning = false; // pgrep exits non-zero when no match
  }
  if (alreadyRunning) {
    log("archiver already running — leaving it.");
  } else {
    try {
      mkdirSync(resolve(ROOT, "logs"), { recursive: true });
      const out = openSync(resolve(ROOT, "logs/inngest-archiver.log"), "a");
      const child = spawn("npm", ["run", "archive"], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      log("started Inngest archiver in background → logs/inngest-archiver.log");
    } catch (e) {
      warn(`could not start archiver: ${e.message}`);
      warn("manual: run `npm run archive` in another terminal");
    }
  }
} else if (!pgReady) {
  warn("skipping archiver (Postgres not ready). Start it later with `npm run archive`.");
}

// 5. Monitor sweeper (deterministic health/SLA/cost/error monitors) — background,
//    dedup-guarded, soft-fail. Off-Inngest; reads the archive, writes Notification.
if (pgReady && process.env.MONITOR_SWEEP !== "0") {
  let alreadyRunning = false;
  try {
    execSync("pgrep -f scripts/monitor-sweeper", { cwd: ROOT, stdio: "ignore" });
    alreadyRunning = true;
  } catch {
    alreadyRunning = false; // pgrep exits non-zero when no match
  }
  if (alreadyRunning) {
    log("monitor sweeper already running — leaving it.");
  } else {
    try {
      mkdirSync(resolve(ROOT, "logs"), { recursive: true });
      const out = openSync(resolve(ROOT, "logs/monitor-sweeper.log"), "a");
      const child = spawn("npm", ["run", "monitor:sweep"], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      log("started monitor sweeper in background → logs/monitor-sweeper.log");
    } catch (e) {
      warn(`could not start monitor sweeper: ${e.message}`);
      warn("manual: run `npm run monitor:sweep` in another terminal");
    }
  }
} else if (!pgReady) {
  warn("skipping monitor sweeper (Postgres not ready). Start it later with `npm run monitor:sweep`.");
}

log("ready");
