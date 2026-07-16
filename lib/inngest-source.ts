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
import { inferEventDomain, inferRunDomain } from "./events/domain-scope";

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

export type PagedRead<T> = archive.PageResult<T> & { source: "postgres" | "live" };

/**
 * Stable numbered pagination is Postgres-first. The write-through middleware
 * persists run start/finish synchronously, so the archive is current while its
 * count/offset semantics stay deterministic. `auto` falls back to the live
 * Inngest window only when Postgres is unavailable.
 */
export async function listRecentRunsPage(
  opts: archive.RecentRunsPageOptions = {},
): Promise<PagedRead<Awaited<ReturnType<typeof live.listRecentRuns>>[number]>> {
  const s = source();
  if (s !== "live") {
    try {
      return { ...(await archive.listRecentRunsPage(opts)), source: "postgres" };
    } catch (error) {
      if (s === "postgres") throw error;
    }
  }

  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Math.floor(opts.pageSize ?? 50)));
  const needed = Math.min(1000, page * pageSize);
  const rows = await live.listRecentRuns({
    limit: needed,
    functionSlug: opts.functionSlug,
    // Preserve the archive API's all-history default as far as the live store
    // allows; this branch is degraded fallback only.
    sinceHours: opts.sinceHours ?? 24 * 365 * 100,
  });
  const filtered = rows.filter((row) => {
    if (opts.status?.length && !opts.status.includes(row.status)) return false;
    if (opts.eventName && row.eventName !== opts.eventName) return false;
    if (
      opts.domain &&
      inferRunDomain({
        appId: row.function.appID,
        functionSlug: row.function.slug,
        eventName: row.eventName,
      }) !== opts.domain
    ) return false;
    return true;
  });
  const items = filtered.slice((page - 1) * pageSize, page * pageSize);
  return {
    items,
    page,
    pageSize,
    total: filtered.length,
    totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    source: "live",
  };
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

// Event recency for the merge sort. received_at is the natural timeline; fall
// back to ts (epoch ms). Unlike runs, an archived event with no timestamp is
// OLD captured data (not a fresh in-progress row), so unknown → 0 (sort last).
const eventMs = (e: { received_at?: string; ts?: number }): number => {
  if (e.received_at) {
    const t = new Date(e.received_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return typeof e.ts === "number" ? e.ts : 0;
};

/**
 * Events list, durable like the runs list. The live Inngest /v1/events buffer is
 * lossy/ephemeral — empty after quiet periods or an Inngest restart — so in auto
 * mode we merge it with the Postgres archive (live wins on id; archive is the
 * durable superset of history that aged out of the live buffer). This is why the
 * /events page + overview "live event stream" no longer go blank when the live
 * buffer is empty.
 */
export async function listEvents(
  limit = 50,
  name?: string,
): ReturnType<typeof live.listEvents> {
  const s = source();
  if (s === "live") return live.listEvents(limit, name);
  if (s === "postgres") return archive.listEvents(limit, name);
  return mergeLists(
    live.listEvents(limit, name),
    archive.listEvents(limit, name),
    (e) => e.id,
    (e) => eventMs(e),
    limit,
  );
}

/** Postgres-counted event pages with live fallback when the archive is down. */
export async function listEventsPage(
  opts: archive.EventsPageOptions = {},
): Promise<PagedRead<Awaited<ReturnType<typeof live.listEvents>>[number]>> {
  const s = source();
  if (s !== "live") {
    try {
      return { ...(await archive.listEventsPage(opts)), source: "postgres" };
    } catch (error) {
      if (s === "postgres") throw error;
    }
  }

  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Math.floor(opts.pageSize ?? 50)));
  const needed = Math.min(1000, page * pageSize);
  const fromMs =
    opts.since && Number.isFinite(opts.since.getTime())
      ? opts.since.getTime()
      : typeof opts.sinceHours === "number" && opts.sinceHours > 0
      ? Date.now() - opts.sinceHours * 3600_000
      : null;
  const rows = await live.listEvents(needed, opts.name);
  const filtered = rows.filter((row) => {
    if (opts.domain && inferEventDomain(row) !== opts.domain) return false;
    if (fromMs !== null && eventMs(row) < fromMs) return false;
    return true;
  });
  const items = filtered.slice((page - 1) * pageSize, page * pageSize);
  return {
    items,
    page,
    pageSize,
    total: filtered.length,
    totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    source: "live",
  };
}

/**
 * Replay = re-emit the trigger event (the send itself is always a live
 * mutation). Payload lookup is live-first — but the dev server's event buffer
 * is lossy/ephemeral, so any event older than the buffer window (e.g. every
 * historical failed run after an Inngest restart) can only be replayed from
 * the durable Postgres archive. Without this fallback the 监控页「重跑」and
 * 事件页「重发」buttons fail with "event not found" on all history.
 */
export async function replayEvent(
  eventId: string,
): ReturnType<typeof live.replayEvent> {
  const s = source();
  if (s === "live") return live.replayEvent(eventId);
  let liveError: unknown = null;
  if (s === "auto") {
    try {
      return await live.replayEvent(eventId);
    } catch (e) {
      liveError = e;
    }
  }
  const archived = await archive.getEventById(eventId).catch(() => null);
  // Event archive can have gaps the run archive doesn't (the archiver polls
  // the lossy live buffer) — a run row's eventName+eventPayload is the
  // last-resort copy of its trigger event.
  const replayable =
    archived ?? (await archive.getTriggerEventFromRuns(eventId).catch(() => null));
  if (!replayable) {
    if (liveError) throw liveError;
    throw new Error(`event ${eventId} not archived`);
  }
  const sent = await live.sendEvent(replayable.name, replayable.data, { replayOf: eventId });
  return { newEventId: sent.id };
}

/**
 * Runs triggered by one event. Live answers [] (not an error) for ids outside
 * its buffer, so in auto mode we merge live ∪ archive — same durability story
 * as the runs/events lists (the /events log modal stays useful on history).
 */
export async function getEventRuns(
  eventId: string,
): ReturnType<typeof live.getEventRuns> {
  const s = source();
  if (s === "live") return live.getEventRuns(eventId);
  if (s === "postgres") return archive.listRunsByTriggerEvent(eventId);
  const [liveRes, archiveRes] = await Promise.allSettled([
    live.getEventRuns(eventId),
    archive.listRunsByTriggerEvent(eventId),
  ]);
  const liveRows = liveRes.status === "fulfilled" ? liveRes.value : null;
  const archiveRows = archiveRes.status === "fulfilled" ? archiveRes.value : null;
  if (liveRows === null && archiveRows === null) {
    throw (liveRes as PromiseRejectedResult).reason;
  }
  const byId = new Map<string, live.InngestRun>();
  for (const r of archiveRows ?? []) byId.set(r.run_id, r);
  for (const r of liveRows ?? []) byId.set(r.run_id, r); // live wins
  return [...byId.values()].sort(
    (a, b) => startedMs(b.run_started_at) - startedMs(a.run_started_at),
  );
}

// ── Always live: registry metadata + mutations ───────────────────────
export const listFunctions = live.listFunctions;
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
