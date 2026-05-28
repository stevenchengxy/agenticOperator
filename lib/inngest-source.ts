// Monitoring read-source resolver. Routes that read Inngest run/event/trace
// data import from here instead of lib/inngest-admin-client directly, so the
// data can come from the durable Postgres archive (resilient to an Inngest
// outage) while mutations + registry metadata still go live.
//
// MONITOR_READ_SOURCE:
//   live      — always the Inngest dev server (legacy behaviour)
//   postgres  — always the archive (errors if not yet archived)
//   auto      — (default) archive first; fall back to live when the archive is
//               empty / missing the row / throws. Covers fresh setups (empty
//               archive) and very recent runs not yet polled (≤ poll interval).
//
// listFunctions is registry metadata the archive does not mirror, so it (and
// the mutations) always go live. Pure helpers are re-exported unchanged.
import * as live from "./inngest-admin-client";
import * as archive from "./inngest-archive/reader";

type Source = "auto" | "postgres" | "live";

function source(): Source {
  const v = (process.env.MONITOR_READ_SOURCE ?? "auto").toLowerCase();
  return v === "postgres" || v === "live" ? v : "auto";
}

export async function listRecentRuns(
  ...args: Parameters<typeof live.listRecentRuns>
): ReturnType<typeof live.listRecentRuns> {
  const s = source();
  if (s === "live") return live.listRecentRuns(...args);
  try {
    const rows = await archive.listRecentRuns(...args);
    if (s === "postgres") return rows;
    if (rows.length > 0) return rows; // auto: archive has data → use it
  } catch (e) {
    if (s === "postgres") throw e;
  }
  return live.listRecentRuns(...args);
}

export async function getRunHistory(
  ...args: Parameters<typeof live.getRunHistory>
): ReturnType<typeof live.getRunHistory> {
  const s = source();
  if (s === "live") return live.getRunHistory(...args);
  try {
    const h = await archive.getRunHistory(...args);
    if (h) return h;
    if (s === "postgres") throw new Error(`Run not archived: ${args[0]}`);
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
  try {
    const rows = await archive.listRunsWithEvents(...args);
    if (s === "postgres") return rows;
    if (rows.length > 0) return rows;
  } catch (e) {
    if (s === "postgres") throw e;
  }
  return live.listRunsWithEvents(...args);
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
