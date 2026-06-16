// Inngest dev server admin client.
//
// Talks to the local Inngest dev server (default :8288). Used by /api/inngest/*
// proxy routes for the monitoring UI to:
//   - list registered functions
//   - list recent runs (filterable by function)
//   - look up a single run's history (step trace)
//   - list events
//   - retry a failed run
//   - pause / resume a function (where supported)
//
// In prod this would point at Inngest Cloud's REST API instead; the env var
// `INNGEST_BASE_URL` controls the base URL.

import { getInngestUrl } from './inngest-url';
const BASE = getInngestUrl();

// ★ Monitoring scope filter:
//   AO 的监控页面关心所有 AO app —— 主招聘 app (agentic-operator-main) +
//   每个业务域自己的 per-domain app (agentic-operator-能源调度-v1 /
//   agentic-operator-费控-v1 / …)。只排除 raas-backend / 其他第三方 app
//   (他们由各自团队负责)。所以前缀是 `agentic-operator-`(不是 `-main`),
//   否则域 agent 的 run 记录(能源/费控)永远不会出现在监控/归档里。
//
//   过滤在 listFunctions / listRecentRuns 等核心 client 函数里统一应用,
//   所有下游 API endpoint(functions / runs / dlq / flows / agents/[slug])
//   自然继承这个 scope。运维 / 调试可设 `MONITORED_APP_PREFIX=` 关闭过滤。
const MONITORED_APP_PREFIX =
  process.env.MONITORED_APP_PREFIX ?? 'agentic-operator-';

function isMonitoredSlug(slug: string | undefined): boolean {
  if (!MONITORED_APP_PREFIX) return true; // empty prefix = monitor all
  if (!slug) return false;
  return slug.startsWith(MONITORED_APP_PREFIX);
}

function isMonitoredAppName(name: string | undefined): boolean {
  if (!MONITORED_APP_PREFIX) return true; // empty prefix = monitor all
  if (!name) return false;
  return name.startsWith(MONITORED_APP_PREFIX);
}

// ─────────────────────────────────────────────────────────────
// REST: events
// ─────────────────────────────────────────────────────────────

export type InngestEvent = {
  id: string;
  internal_id?: string;
  name: string;
  data: unknown;
  ts?: number;
  received_at?: string;
};

export type InngestRun = {
  run_id: string;
  run_started_at?: string;
  ended_at?: string | null;
  status: 'Running' | 'Completed' | 'Failed' | 'Cancelled';
  output?: unknown;
  function_id?: string;
  event_id?: string;
};

/**
 * Fail-fast timeout for any call to the Inngest dev server. When the dev
 * server is unhealthy (GraphQL endpoint hangs even though /health is fine)
 * we want callers — especially polling-driven UI like /monitor — to see a
 * concrete error within seconds, not hang forever in "Loading…" state.
 */
const INNGEST_FETCH_TIMEOUT_MS = 5000;

function timeoutSignal(parent?: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Inngest dev server timeout after ${INNGEST_FETCH_TIMEOUT_MS}ms`)), INNGEST_FETCH_TIMEOUT_MS);
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
    else parent.addEventListener('abort', () => ctrl.abort(parent.reason), { once: true });
  }
  // Best-effort timer cleanup when caller aborts first
  ctrl.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

async function restGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { signal: timeoutSignal(signal) });
  if (!res.ok) {
    throw new Error(`Inngest REST ${res.status} ${path}`);
  }
  return res.json() as Promise<T>;
}

export async function listEvents(limit = 50, name?: string): Promise<InngestEvent[]> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (name) qs.set("name", name); // Inngest dev /v1/events filters on ?name=
  const body = await restGet<{ data: InngestEvent[] }>(`/v1/events?${qs.toString()}`);
  return body.data ?? [];
}

export async function getEventRuns(eventId: string): Promise<InngestRun[]> {
  const body = await restGet<{ data: InngestRun[] }>(`/v1/events/${encodeURIComponent(eventId)}/runs`);
  return body.data ?? [];
}

// ─────────────────────────────────────────────────────────────
// GraphQL: function list + run history (only available on /v0/gql)
// ─────────────────────────────────────────────────────────────

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}/v0/gql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: timeoutSignal(),
  });
  const body = await res.json();
  if (body.errors) {
    throw new Error(`Inngest GraphQL: ${JSON.stringify(body.errors)}`);
  }
  return body.data as T;
}

export type InngestFunction = {
  id: string;
  name: string;
  slug: string;
  concurrency?: number;
  triggers: Array<{ type: string; value: string }>;
  url?: string;
  appID?: string;
};

export type InngestApp = {
  name: string;
  url?: string | null;
  error?: string | null;
  connected: boolean;
  functionCount: number;
  sdkVersion: string;
  framework?: string | null;
};

export async function listApps(): Promise<InngestApp[]> {
  const data = await gql<{ apps: InngestApp[] }>(`
    { apps { name url error connected functionCount sdkVersion framework } }
  `);
  return (data.apps ?? []).filter((a) => isMonitoredAppName(a.name));
}

export async function listFunctions(): Promise<InngestFunction[]> {
  const data = await gql<{ apps: Array<{ name?: string; functions: InngestFunction[] }> }>(`
    { apps { name functions { id name slug concurrency triggers { type value } url appID } } }
  `);
  const all = data.apps?.flatMap((a) => a.functions ?? []) ?? [];
  // ★ Filter to monitored app prefix only (default: agentic-operator-main).
  return all.filter((f) => isMonitoredSlug(f.slug));
}

export async function listRecentRuns(opts: { limit?: number; functionSlug?: string; sinceHours?: number } = {}): Promise<
  Array<{
    id: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    function: { name: string; slug: string };
    eventName?: string;
    /** Triggering event id — used by the Runs list "↺ rerun" button to call the replay endpoint. */
    eventId?: string;
  }>
> {
  const limit = opts.limit ?? 50;
  const sinceHours = opts.sinceHours ?? 24;
  const now = new Date();
  const from = new Date(now.getTime() - sinceHours * 3600_000);
  const fromIso = from.toISOString();
  const untilIso = now.toISOString();
  // Inngest v1.19+ uses runs(filter:, orderBy:) with V2 RunsConnection.
  const data = await gql<{ runs: { edges: Array<{ node: unknown }> } }>(`
    {
      runs(
        first: ${limit},
        orderBy: [{ field: STARTED_AT, direction: DESC }],
        filter: { from: "${fromIso}", until: "${untilIso}", timeField: STARTED_AT }
      ) {
        edges {
          node {
            id status startedAt endedAt eventName
            triggerIDs
            function { name slug }
          }
        }
      }
    }
  `);
  const runs = (data.runs?.edges ?? []).map((e) => e.node) as Array<{
    id: string;
    status: string;
    startedAt: string;
    endedAt?: string | null;
    eventName?: string;
    triggerIDs?: string[] | null;
    function: { name: string; slug: string };
  }>;
  // ★ Scope filter: monitored app prefix only (drops raas-backend etc.).
  const monitored = runs.filter((r) => isMonitoredSlug(r.function?.slug));
  const filtered = opts.functionSlug
    ? monitored.filter((r) => r.function?.slug === opts.functionSlug)
    : monitored;
  // Normalize status (v2 returns COMPLETED uppercase) → match REST API casing.
  return filtered.map((r) => ({
    id: r.id,
    status: titleCase(r.status),
    startedAt: r.startedAt,
    finishedAt: r.endedAt ?? undefined,
    function: r.function,
    eventName: r.eventName,
    // FunctionRunV2.triggerIDs holds the event id(s) that triggered this run.
    // For single-event runs (the common case) it's a 1-element array; for
    // batched runs there can be N. We use the first one for the "rerun"
    // button — re-emitting any trigger event re-fires the function.
    eventId: Array.isArray(r.triggerIDs) && r.triggerIDs.length > 0 ? r.triggerIDs[0] : undefined,
  }));
}

function titleCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ─────────────────────────────────────────────────────────────
// Run detail — V2 `run(runID:)` + `trace.childrenSpans` +
// `runTraceSpanOutputByID(outputID:)` second-hop for per-step IO.
//
// V1 `functionRun.history` only exposes {type, stepName, attempt, createdAt},
// which is why the run drawer used to show empty step cards with no JSON
// body. V2 gives per-step duration + outputID; the outputID then resolves
// to `{ data, input, error }` so each step gets its real output JSON.
//
// Top-level run `output` is also more reliable on V2 (V1 sometimes returns
// null for multi-step functions even when the function did return a value).
//
// V2 doesn't expose the triggering event payload directly — we keep a
// secondary V1 `functionRun.event` call for that (soft-fail).
// ─────────────────────────────────────────────────────────────

export type RunStepDetail = {
  name: string;
  status: string;
  durationMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  stepOp: string | null;
  stepID: string | null;
  attempts: number | null;
  output: unknown;
  input: unknown;
  error: { name: string; message: string; stack?: string } | null;
};

export async function getRunHistory(runId: string): Promise<{
  id: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  output?: unknown;
  function: { name: string; slug: string };
  event?: { id: string; name: string; payload: string; createdAt: string };
  steps: RunStepDetail[];
}> {
  // 1) V2 root + trace tree (one round-trip)
  const v2 = await gql<{
    run: {
      id: string;
      status: string;
      startedAt: string | null;
      endedAt: string | null;
      output: string | null;
      function: { name: string; slug: string };
      trace: {
        childrenSpans: Array<{
          name: string;
          status: string;
          duration: number | null;
          startedAt: string | null;
          endedAt: string | null;
          outputID: string | null;
          stepOp: string | null;
          stepID: string | null;
          attempts: number | null;
        }>;
      } | null;
    } | null;
  }>(`{
    run(runID: "${runId}") {
      id status startedAt endedAt output
      function { name slug }
      trace {
        childrenSpans {
          name status duration startedAt endedAt outputID stepOp stepID attempts
        }
      }
    }
  }`);

  if (!v2.run) throw new Error(`Run not found: ${runId}`);

  // 2) V1 event lookup (V2 has no `event` field on FunctionRunV2)
  let event: { id: string; name: string; payload: string; createdAt: string } | undefined;
  try {
    const v1 = await gql<{ functionRun: { event?: { id: string; name: string; payload: string; createdAt: string } } | null }>(`
      { functionRun(query: { functionRunId: "${runId}" }) { event { id name payload createdAt } } }
    `);
    if (v1.functionRun?.event) event = v1.functionRun.event;
  } catch {
    /* soft — event payload is best-effort */
  }

  // 3) Fan out outputID lookups per child span (typical: 1–5 spans).
  //    Sequential calls would be N round-trips; Promise.all keeps it 1
  //    wall-clock round-trip from the API route's perspective.
  const spans = v2.run.trace?.childrenSpans ?? [];
  const steps: RunStepDetail[] = await Promise.all(
    spans.map(async (sp) => {
      let output: unknown = null;
      let input: unknown = null;
      let error: RunStepDetail['error'] = null;
      if (sp.outputID) {
        try {
          const out = await gql<{
            runTraceSpanOutputByID: {
              data: string | null;
              input: string | null;
              error: { name: string; message: string; stack?: string } | null;
            } | null;
          }>(`{
            runTraceSpanOutputByID(outputID: "${sp.outputID}") {
              data input error { name message stack }
            }
          }`);
          const r = out.runTraceSpanOutputByID;
          if (r) {
            output = parseMaybeJson(r.data);
            input = parseMaybeJson(r.input);
            error = r.error;
          }
        } catch {
          /* soft — keep span without IO if lookup fails */
        }
      }
      return {
        name: sp.name,
        status: sp.status,
        durationMs: sp.duration ?? null,
        startedAt: sp.startedAt,
        endedAt: sp.endedAt,
        stepOp: sp.stepOp,
        stepID: sp.stepID,
        attempts: sp.attempts ?? null,
        output,
        input,
        error,
      };
    }),
  );

  return {
    id: v2.run.id,
    status: titleCase(v2.run.status),
    startedAt: v2.run.startedAt ?? '',
    finishedAt: v2.run.endedAt ?? undefined,
    output: parseMaybeJson(v2.run.output),
    function: v2.run.function,
    event,
    steps,
  };
}

function parseMaybeJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ─────────────────────────────────────────────────────────────
// Step-level outputs (V2 trace API).
//
// `getRunHistory()` returns step state transitions but NOT the actual JSON
// returned by each step.run(). Inngest's V2 trace API exposes per-span
// outputID pointers; resolving each one yields the JSON the step returned.
//
// This is what the Inngest dev UI shows when you expand a step — duplicating
// it inside RAAS / AO monitoring saves an extra-tab round trip.
//
// Returns leaf spans only (the user-visible step.run / step.sendEvent calls)
// — internal Inngest plumbing spans (no stepOp) are filtered out. Output is
// the raw JSON string Inngest stored; caller can JSON.parse for display.
// ─────────────────────────────────────────────────────────────

export type RunStepOutput = {
  spanID: string;
  name: string;
  stepOp: string | null;
  status: string | null;
  attempts: number | null;
  durationMs: number | null;
  queuedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Raw JSON string Inngest stored for this step's return value. */
  output: string | null;
  /** Set if fetching the output failed (e.g. expired / not yet ready). */
  outputError: string | null;
};

type RawSpan = {
  spanID: string;
  name: string;
  stepOp: string | null;
  status: string | null;
  attempts: number | null;
  duration: number | null;
  queuedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  outputID: string | null;
  childrenSpans: RawSpan[] | null;
};

function flattenLeafSpans(span: RawSpan | null | undefined): RawSpan[] {
  if (!span) return [];
  const kids = Array.isArray(span.childrenSpans) ? span.childrenSpans : [];
  if (kids.length === 0) return [span];
  return kids.flatMap(flattenLeafSpans);
}

export async function getRunStepOutputs(runId: string): Promise<RunStepOutput[]> {
  // V2 trace API — same query the Inngest dev UI uses. childrenSpans is
  // recursive; we walk the tree client-side because GraphQL recursion needs
  // an explicit fragment.
  const data = await gql<{
    run: { trace: RawSpan | null } | null;
  }>(`
    {
      run(runID: "${runId}") {
        trace {
          spanID name stepOp status attempts duration outputID
          queuedAt startedAt endedAt
          childrenSpans {
            spanID name stepOp status attempts duration outputID
            queuedAt startedAt endedAt
            childrenSpans {
              spanID name stepOp status attempts duration outputID
              queuedAt startedAt endedAt
              childrenSpans {
                spanID name stepOp status attempts duration outputID
                queuedAt startedAt endedAt
              }
            }
          }
        }
      }
    }
  `);
  const trace = data.run?.trace;
  if (!trace) return [];

  const leaves = flattenLeafSpans(trace);

  // Resolve outputID → JSON string in parallel. Failures per-step are
  // captured in `outputError` and don't fail the whole batch.
  return Promise.all(
    leaves.map(async (span): Promise<RunStepOutput> => {
      const base: RunStepOutput = {
        spanID: span.spanID,
        name: span.name,
        stepOp: span.stepOp,
        status: span.status,
        attempts: span.attempts,
        durationMs: span.duration,
        queuedAt: span.queuedAt,
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        output: null,
        outputError: null,
      };
      if (!span.outputID) return base;
      try {
        const resp = await gql<{
          runTraceSpanOutputByID: { data: string | null; error: { message: string } | null } | null;
        }>(`
          {
            runTraceSpanOutputByID(outputID: "${span.outputID}") {
              data
              error { message }
            }
          }
        `);
        const r = resp.runTraceSpanOutputByID;
        if (r?.error?.message) {
          base.outputError = r.error.message;
        } else {
          base.output = r?.data ?? null;
        }
      } catch (err) {
        base.outputError = (err as Error).message;
      }
      return base;
    }),
  );
}

// ─────────────────────────────────────────────────────────────
// Flow grouping (Level 4 — per-candidate × per-JD process trace)
// ─────────────────────────────────────────────────────────────

export type FlowGroupKey = {
  upload_id?: string;
  job_requisition_id?: string;
  candidate_id?: string;
};

/** Derive a stable flow id from event payload. Returns:
 *   - `upload:<upload_id>`  if upload_id present (resume side)
 *   - `jr:<job_req_id>`     if only JR id present (JD side)
 *   - `evt:<event_id>`      fallback when neither (each event is its own "flow")
 */
export function deriveFlowId(eventPayload: Record<string, unknown> | null, eventId: string): string {
  if (eventPayload) {
    const uploadId =
      (eventPayload.upload_id as string | undefined) ||
      ((eventPayload.payload as Record<string, unknown> | undefined)?.upload_id as
        | string
        | undefined);
    if (uploadId) return `upload:${uploadId}`;
    const jrId =
      (eventPayload.job_requisition_id as string | undefined) ||
      (eventPayload.entity_id as string | undefined) ||
      ((eventPayload.payload as Record<string, unknown> | undefined)?.job_requisition_id as
        | string
        | undefined);
    if (jrId) return `jr:${jrId}`;
  }
  return `evt:${eventId}`;
}

/** Pull a friendly label from the event payload (candidate name, JR title, etc.) */
export function flowLabel(eventPayload: Record<string, unknown> | null): {
  candidateName?: string;
  jdTitle?: string;
  candidateId?: string;
  jrId?: string;
} {
  if (!eventPayload) return {};
  const parsed = (eventPayload.parsed as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const candidateName = (parsed?.name as string | undefined) ?? undefined;
  const payload = eventPayload.payload as Record<string, unknown> | undefined;
  const raw = payload?.raw_input_data as Record<string, unknown> | undefined;
  const jdTitle =
    (raw?.prompt as string | undefined)?.slice(0, 40) ??
    ((payload?.client_job_title as string) ?? undefined);
  const candidateId =
    (eventPayload.candidate_id as string | undefined) ??
    (payload?.candidate_id as string | undefined);
  const jrId =
    (eventPayload.job_requisition_id as string | undefined) ??
    (eventPayload.entity_id as string | undefined) ??
    (payload?.job_requisition_id as string | undefined);
  return { candidateName, jdTitle, candidateId, jrId };
}

/** List runs for a function with their event payload parsed. */
export async function listRunsWithEvents(
  functionSlug: string,
  opts: { limit?: number; sinceHours?: number } = {},
): Promise<
  Array<{
    runId: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    durationMs: number | null;
    eventName: string;
    eventId: string;
    eventPayload: Record<string, unknown> | null;
    flowId: string;
    label: ReturnType<typeof flowLabel>;
  }>
> {
  const runs = await listRecentRuns({ limit: opts.limit ?? 100, functionSlug, sinceHours: opts.sinceHours });
  // For each run we need event payload — fetch via GraphQL
  const enriched = await Promise.all(
    runs.map(async (r) => {
      let eventPayload: Record<string, unknown> | null = null;
      let eventId = '';
      let eventName = r.eventName ?? '';
      try {
        const data = await gql<{ functionRun: { event: { id: string; name: string; payload: string } | null } }>(`
          { functionRun(query: { functionRunId: "${r.id}" }) { event { id name payload } } }
        `);
        const ev = data.functionRun?.event;
        if (ev) {
          eventId = ev.id;
          eventName = ev.name;
          try {
            eventPayload = JSON.parse(ev.payload) as Record<string, unknown>;
          } catch {
            eventPayload = null;
          }
        }
      } catch {
        // soft fail
      }
      const flowId = deriveFlowId(eventPayload, eventId || r.id);
      return {
        runId: r.id,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs:
          r.finishedAt && r.startedAt
            ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
            : null,
        eventName,
        eventId,
        eventPayload,
        flowId,
        label: flowLabel(eventPayload),
      };
    }),
  );
  return enriched;
}

/** Group runs by flowId, sorted by latest activity. */
export function groupRunsByFlow<T extends { flowId: string; startedAt: string }>(
  runs: T[],
): Array<{ flowId: string; runs: T[]; latestStartedAt: string }> {
  const groups = new Map<string, T[]>();
  for (const r of runs) {
    const arr = groups.get(r.flowId) ?? [];
    arr.push(r);
    groups.set(r.flowId, arr);
  }
  return Array.from(groups.entries())
    .map(([flowId, arr]) => ({
      flowId,
      runs: arr.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
      latestStartedAt: arr[0].startedAt,
    }))
    .sort((a, b) => new Date(b.latestStartedAt).getTime() - new Date(a.latestStartedAt).getTime());
}

// ─────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────

/** Re-emit the same event payload to trigger a fresh run. */
export async function replayEvent(eventId: string): Promise<{ newEventId: string }> {
  // Inngest doesn't have a "replay" REST endpoint in dev server; the cleanest
  // way is to fetch the original event payload and re-send it via /e/test.
  const evRes = await fetch(`${BASE}/v1/events/${encodeURIComponent(eventId)}`);
  if (!evRes.ok) throw new Error(`event ${eventId} not found`);
  const evBody = (await evRes.json()) as { data: InngestEvent };
  const orig = evBody.data;
  const sendRes = await fetch(`${BASE}/e/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: orig.name, data: orig.data, replay_of: eventId }),
  });
  const sendBody = (await sendRes.json()) as { ids?: string[] };
  return { newEventId: sendBody.ids?.[0] ?? '' };
}

/** Send a fresh event with arbitrary payload (used by /events page "Send Test"). */
export async function sendEvent(name: string, data: unknown): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/e/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  const body = (await res.json()) as { ids?: string[] };
  return { id: body.ids?.[0] ?? '' };
}

/** Dev server doesn't have pause/resume API; we track agent state in our own DB. */
