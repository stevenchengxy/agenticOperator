// Inngest archiver — standalone long-lived poller that mirrors the Inngest
// dev server (events / runs / step-traces) into local Postgres, so monitoring
// survives an Inngest crash or volume wipe.
//
// Why a standalone process (not an Inngest cron): durability is the whole
// point — if Inngest's own scheduler is degraded, a cron archiver would stop
// too. This process is decoupled from both Inngest's scheduler and Next.js.
//
//   npm run archive
//
// Env (see .env.local §1b):
//   ARCHIVE_ENABLED            1 (default) | 0 to no-op
//   ARCHIVE_INTERVAL_MS        poll period (default 30000)
//   ARCHIVE_WINDOW_HOURS       rolling run window to scan (default 168)
//   ARCHIVE_EVENT_LIMIT        events per poll (default 1000)
//   ARCHIVE_RUN_LIMIT          runs per poll (default 1000)
//   ARCHIVE_TRACE_CONCURRENCY  parallel trace fetches (default 4)
//   INNGEST_BASE_URL           Inngest dev server (reused from app config)
//
// See docs/superpowers/specs/2026-05-28-local-postgres-inngest-archive-design.md
import { listEvents, listRecentRuns, getRunHistory } from "../lib/inngest-admin-client";
import { isTerminalStatus } from "../lib/inngest-archive/mappers";
import {
  archiveEvents,
  readRunSyncState,
  upsertRun,
  archiveRunTrace,
  updateCursor,
} from "../lib/inngest-archive/writer";
import { prisma } from "../server/db";

const ENABLED = process.env.ARCHIVE_ENABLED !== "0";
const INTERVAL_MS = numEnv("ARCHIVE_INTERVAL_MS", 30000);
const WINDOW_HOURS = numEnv("ARCHIVE_WINDOW_HOURS", 168);
const EVENT_LIMIT = numEnv("ARCHIVE_EVENT_LIMIT", 1000);
const RUN_LIMIT = numEnv("ARCHIVE_RUN_LIMIT", 1000);
const TRACE_CONCURRENCY = numEnv("ARCHIVE_TRACE_CONCURRENCY", 4);

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Concurrency-limited map. Returns the summed numeric results. */
async function mapLimitSum<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<number>,
): Promise<number> {
  let total = 0;
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = items[idx++];
      total += await fn(cur);
    }
  });
  await Promise.all(workers);
  return total;
}

async function tick(): Promise<{ events: number; runs: number; steps: number }> {
  // 1. Events (immutable — insert-new-only).
  const events = await archiveEvents(await listEvents(EVENT_LIMIT));

  // 2. Runs — upsert only new / status-changed ones.
  const recent = await listRecentRuns({ limit: RUN_LIMIT, sinceHours: WINDOW_HOURS });
  const state = await readRunSyncState();
  const toFetchTrace: string[] = [];
  let runs = 0;
  for (const r of recent) {
    const prev = state.get(r.id);
    const isNew = !prev;
    const statusChanged = !!prev && prev.status !== r.status;
    if (isNew || statusChanged) {
      await upsertRun(r);
      runs++;
    }
    // Fetch the (expensive) trace for any terminal run we haven't captured
    // yet. Deliberately NOT gated on (isNew || statusChanged): if the archiver
    // died between upsertRun (terminal status persisted) and archiveRunTrace,
    // or a getRunHistory call failed transiently (soft catch below), the next
    // tick must retry — otherwise traceFetched=false rows are stuck forever
    // and the monitor serves an empty step trace for that run. Retry cost is
    // bounded by the rolling run window. (2026-06-10 audit fix.)
    const needTrace = isTerminalStatus(r.status) && !prev?.traceFetched;
    if (needTrace) toFetchTrace.push(r.id);
  }

  // 3. Step traces (concurrency-capped; per-run failure is soft).
  const steps = await mapLimitSum(toFetchTrace, TRACE_CONCURRENCY, async (runId) => {
    try {
      const history = await getRunHistory(runId);
      return await archiveRunTrace(runId, history);
    } catch (e) {
      console.warn(`[archive] trace fetch failed for ${runId}: ${(e as Error).message}`);
      return 0;
    }
  });

  await updateCursor({ events, runs, steps });
  return { events, runs, steps };
}

let stopping = false;
// In-flight tick — shutdown awaits it so SIGTERM mid-tick can't strand a run
// between upsertRun (terminal status written) and archiveRunTrace. Paired with
// the needTrace recovery above this is belt-and-braces, but it also protects
// the event/cursor writes from being cut off halfway.
let inFlightTick: Promise<unknown> | null = null;

async function loop(): Promise<void> {
  console.log(
    `[archive] starting — interval=${INTERVAL_MS}ms window=${WINDOW_HOURS}h ` +
      `eventLimit=${EVENT_LIMIT} runLimit=${RUN_LIMIT} traceConc=${TRACE_CONCURRENCY} ` +
      `inngest=${process.env.INNGEST_BASE_URL ?? "(default)"}`,
  );
  while (!stopping) {
    const t0 = Date.now();
    try {
      inFlightTick = tick();
      const s = (await inFlightTick) as Awaited<ReturnType<typeof tick>>;
      console.log(
        `[archive] tick ok — events+${s.events} runs±${s.runs} steps+${s.steps} ` +
          `(${Date.now() - t0}ms)`,
      );
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.error(`[archive] tick FAILED: ${msg}`);
      try {
        await updateCursor({ events: 0, runs: 0, steps: 0, error: msg });
      } catch {
        /* cursor write best-effort */
      }
    } finally {
      inFlightTick = null;
    }
    if (stopping) break;
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)));
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[archive] ${signal} — shutting down (waiting for in-flight tick)…`);
  stopping = true;
  if (inFlightTick) await Promise.race([inFlightTick.catch(() => {}), sleep(15_000)]);
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

if (!ENABLED) {
  console.log("[archive] ARCHIVE_ENABLED=0 — archiver disabled, exiting.");
  process.exit(0);
}

loop().catch(async (e) => {
  console.error("[archive] fatal:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
