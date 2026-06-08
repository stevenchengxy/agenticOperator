// Monitoring read-source resolver. Routes that read Inngest run/event/trace
// data import from here instead of lib/inngest-admin-client directly, so the
// data can come from the durable Postgres archive (resilient to an Inngest
// outage) while mutations + registry metadata still go live.
//
// MONITOR_READ_SOURCE:
//   live      — always the Inngest dev server (legacy behaviour)
//   postgres  — always the archive (errors if not yet archived)
//   auto      — (default) for LIST reads, merge live ∪ archive (live wins on
//               conflict, archive is the durable superset); for single-run
//               reads, archive-first with live fallback for the row / trace.
//
// Why merge the lists rather than archive-first: the archive trails live by up
// to one poll (ARCHIVE_INTERVAL_MS). Energy/费控 runs are ~all <30s, so they
// start-and-finish inside a single poll gap — an archive-only list never sees
// their in-progress phase ("only shows up after completion"). Merging makes the
// live (real-time) row authoritative while keeping the archive as the offline
// fallback + the source for history that aged out of live's window.
//
// listFunctions is registry metadata the archive does not mirror, so it (and
// the mutations) always go live. Pure helpers are re-exported unchanged.
import * as live from "./inngest-admin-client";
import * as archive from "./inngest-archive/reader";
import { isTerminalStatus } from "./inngest-archive/mappers";

type Source = "auto" | "postgres" | "live";

function source(): Source {
  const v = (process.env.MONITOR_READ_SOURCE ?? "auto").toLowerCase();
  return v === "postgres" || v === "live" ? v : "auto";
}

const startedMs = (s: string | null | undefined): number => {
  // No / unparseable timestamp → sort to the top (treat as "just now") so a
  // fresh in-progress run is never hidden below older completed ones.
  if (!s) return Infinity;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? Infinity : t;
};

/**
 * auto-mode LIST resolver. live = real-time truth (wins on conflict), archive =
 * durable superset. Live unreachable → archive only (the durability goal);
 * archive unreachable → live only; both down → surface live's error. `slice`
 * keeps the newest `limit` across the union.
 */
async function mergeLists<T>(
  liveCall: Promise<T[]>,
  archiveCall: Promise<T[]>,
  keyOf: (r: T) => string,
  timeOf: (r: T) => number,
  limit: number,
): Promise<T[]> {
  const [liveRes, archiveRes] = await Promise.allSettled([liveCall, archiveCall]);
  const liveRows = liveRes.status === "fulfilled" ? liveRes.value : null;
  const archiveRows = archiveRes.status === "fulfilled" ? archiveRes.value : null;
  if (liveRows === null && archiveRows === null) {
    throw (liveRes as PromiseRejectedResult).reason; // both down → surface live's error
  }
  if (liveRows === null) return archiveRows!; // Inngest down → durable archive
  if (archiveRows === null) return liveRows; // archive down → live
  const byKey = new Map<string, T>();
  for (const r of archiveRows) byKey.set(keyOf(r), r);
  for (const r of liveRows) byKey.set(keyOf(r), r); // live overwrites → live wins
  return [...byKey.values()].sort((a, b) => timeOf(b) - timeOf(a)).slice(0, limit);
}

export async function listRecentRuns(
  ...args: Parameters<typeof live.listRecentRuns>
): ReturnType<typeof live.listRecentRuns> {
  const s = source();
  if (s === "live") return live.listRecentRuns(...args);
  if (s === "postgres") return archive.listRecentRuns(...args);
  return mergeLists(
    live.listRecentRuns(...args),
    archive.listRecentRuns(...args),
    (r) => r.id,
    (r) => startedMs(r.startedAt),
    args[0]?.limit ?? 50,
  );
}

export async function getRunHistory(
  ...args: Parameters<typeof live.getRunHistory>
): ReturnType<typeof live.getRunHistory> {
  const s = source();
  if (s === "live") return live.getRunHistory(...args);
  try {
    const h = await archive.getRunHistory(...args);
    // The archive only captures a run's step trace once it reaches a terminal
    // state, so a non-terminal archived run has an empty trace — go live for
    // the in-progress steps. (postgres mode stays archive-only by contract.)
    if (h && (s === "postgres" || isTerminalStatus(h.status))) return h;
    if (s === "postgres") {
      if (h) return h;
      throw new Error(`Run not archived: ${args[0]}`);
    }
  } catch (e) {
    if (s === "postgres") throw e;
  }
  return live.getRunHistory(...args);
}

export async function getRunStepOutputs(
  ...args: Parameters<typeof live.getRunStepOutputs>
): ReturnType<typeof live.getRunStepOutputs> {
  const s = source();
  if (s === "live") return live.getRunStepOutputs(...args);
  try {
    const out = await archive.getRunStepOutputs(...args);
    if (out) return out; // null = not archived → fall back (auto/postgres alike)
    if (s === "postgres") return [];
  } catch (e) {
    if (s === "postgres") throw e;
  }
  return live.getRunStepOutputs(...args);
}

export async function listRunsWithEvents(
  ...args: Parameters<typeof live.listRunsWithEvents>
): ReturnType<typeof live.listRunsWithEvents> {
  const s = source();
  if (s === "live") return live.listRunsWithEvents(...args);
  if (s === "postgres") return archive.listRunsWithEvents(...args);
  return mergeLists(
    live.listRunsWithEvents(...args),
    archive.listRunsWithEvents(...args),
    (r) => r.runId,
    (r) => startedMs(r.startedAt),
    args[1]?.limit ?? 100,
  );
}

// ── Always live: registry metadata + mutations ───────────────────────
export const listFunctions = live.listFunctions;
export const listEvents = live.listEvents;
export const getEventRuns = live.getEventRuns;
export const replayEvent = live.replayEvent;
export const sendEvent = live.sendEvent;

// ── Pure helpers (no I/O) — re-exported unchanged ────────────────────
export const deriveFlowId = live.deriveFlowId;
export const flowLabel = live.flowLabel;
export const groupRunsByFlow = live.groupRunsByFlow;

export type {
  InngestEvent,
  InngestRun,
  InngestFunction,
  RunStepDetail,
  RunStepOutput,
  FlowGroupKey,
} from "./inngest-admin-client";
