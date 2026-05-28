// Pure transforms: Inngest dev-server shapes (lib/inngest-admin-client) →
// Prisma archive row shapes (InngestEventArchive / InngestRunArchive /
// InngestStepArchive). No DB / no network here so these are unit-testable.
//
// Relative imports (not @/) so the archiver script can import this under tsx,
// which doesn't resolve the tsconfig path alias.
import {
  deriveFlowId,
  type InngestEvent,
  type RunStepDetail,
} from "../inngest-admin-client";

const TERMINAL = new Set(["Completed", "Failed", "Cancelled"]);

export function isTerminalStatus(status: string | undefined | null): boolean {
  return !!status && TERMINAL.has(status);
}

/** ISO string or epoch-ms number → Date; null/invalid → null. */
export function toDate(v: string | number | null | undefined): Date | null {
  if (v == null || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** JSON.stringify, but undefined → null and already-string passes through. */
export function safeJson(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function durationMs(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  const s = toDate(start);
  const e = toDate(end);
  if (!s || !e) return null;
  return e.getTime() - s.getTime();
}

// ── Events ───────────────────────────────────────────────────────────
export type EventRow = {
  id: string;
  internalId: string | null;
  name: string;
  data: string; // required column — JSON "null" when the event had no data
  ts: Date | null;
  receivedAt: Date | null;
};

export function eventToRow(ev: InngestEvent): EventRow {
  return {
    id: ev.id,
    internalId: ev.internal_id ?? null,
    name: ev.name,
    data: safeJson(ev.data) ?? "null",
    ts: toDate(ev.ts),
    receivedAt: toDate(ev.received_at),
  };
}

// ── Runs ─────────────────────────────────────────────────────────────
export type RecentRun = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  function: { name: string; slug: string };
  eventName?: string;
  eventId?: string;
};

export type RunCreate = {
  runId: string;
  functionSlug: string;
  functionName: string | null;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  durationMs: number | null;
  eventName: string | null;
  triggerEventIds: string | null;
};

export function runToCreate(run: RecentRun): RunCreate {
  return {
    runId: run.id,
    functionSlug: run.function?.slug ?? "",
    functionName: run.function?.name ?? null,
    status: run.status,
    startedAt: toDate(run.startedAt),
    endedAt: toDate(run.finishedAt),
    durationMs: durationMs(run.startedAt, run.finishedAt),
    eventName: run.eventName ?? null,
    triggerEventIds: run.eventId ? JSON.stringify([run.eventId]) : null,
  };
}

/** Mutable fields only — status / timing change as a run progresses. */
export function runToUpdate(run: RecentRun): {
  status: string;
  endedAt: Date | null;
  durationMs: number | null;
  eventName: string | null;
} {
  return {
    status: run.status,
    endedAt: toDate(run.finishedAt),
    durationMs: durationMs(run.startedAt, run.finishedAt),
    eventName: run.eventName ?? null,
  };
}

// ── Run trace (steps + run-level output/payload) ─────────────────────
export type RunHistory = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  output?: unknown;
  function: { name: string; slug: string };
  event?: { id: string; name: string; payload: string; createdAt: string };
  steps: RunStepDetail[];
};

export type StepRow = {
  id: string;
  runId: string;
  spanId: string;
  name: string;
  stepOp: string | null;
  status: string | null;
  attempts: number | null;
  durationMs: number | null;
  queuedAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  input: string | null;
  output: string | null;
  error: string | null;
};

export function historyToStepRows(runId: string, history: RunHistory): StepRow[] {
  return (history.steps ?? []).map((s, i) => ({
    // Index-based stable id; the writer replaces all step rows for a run on
    // each trace fetch, so ordering need only be stable within one fetch.
    id: `${runId}#${i}`,
    runId,
    spanId: s.stepID ?? s.name ?? String(i),
    name: s.name,
    stepOp: s.stepOp ?? null,
    status: s.status ?? null,
    attempts: s.attempts ?? null,
    durationMs: s.durationMs ?? null,
    queuedAt: null, // getRunHistory does not expose queuedAt
    startedAt: toDate(s.startedAt),
    endedAt: toDate(s.endedAt),
    input: safeJson(s.input),
    output: safeJson(s.output),
    error: s.error ? safeJson(s.error) : null,
  }));
}

/** Run-level fields set once the full trace is fetched. */
export function runTraceFields(runId: string, history: RunHistory): {
  output: string | null;
  eventPayload: string | null;
  eventName: string | null;
  flowId: string;
  status: string;
  endedAt: Date | null;
  traceFetched: true;
} {
  let parsedPayload: Record<string, unknown> | null = null;
  if (history.event?.payload) {
    try {
      parsedPayload = JSON.parse(history.event.payload) as Record<string, unknown>;
    } catch {
      parsedPayload = null;
    }
  }
  return {
    output: safeJson(history.output),
    eventPayload: history.event?.payload ?? null,
    eventName: history.event?.name ?? null,
    flowId: deriveFlowId(parsedPayload, history.event?.id ?? runId),
    status: history.status,
    endedAt: toDate(history.finishedAt),
    traceFetched: true,
  };
}
