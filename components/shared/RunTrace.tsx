"use client";
import React from "react";
import Link from "next/link";
import { Ic } from "@/components/shared/Ic";
import { Markdown } from "@/components/shared/Markdown";
import { describeStep, describeLogKind } from "@/lib/monitor-step-descriptor";
import { useApp } from "@/lib/i18n";
import { fetchJson } from "@/lib/api/client";
import type { RunSummaryResponse } from "@/app/api/runs/[id]/summary/route";

// Shared run-detail / trace components.
// Used by /monitor (run inspection) and /fleet/[short] (light "today's stats"
// link — actual trace lives in Monitor only). Extracted from the original
// in-Fleet implementation so we don't duplicate the timeline / error-log /
// output viewer code.

export type RunStatus = "Running" | "Completed" | "Failed" | "Cancelled";

export type RunRow = {
  id: string;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  eventName: string | null;
  eventId?: string | null;
  function?: { name: string; slug: string };
};

export type RunHistoryEvent = { type: string; createdAt: string; stepName?: string | null };

/** Per-step trace data from Inngest V2 trace API. See lib/inngest-admin-client.ts
 *  `getRunStepOutputs`. Optional because older runs / agents without spans
 *  fall back to the legacy `steps[]` derived from `history[]`. */
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
  output: string | null;
  outputError: string | null;
};

export type RunDetail = {
  status: string;
  startedAt: string;
  finishedAt: string | null;
  output: unknown;
  /** Structured error from the failed step (V2 trace) — used by the Event
   *  panel's "Error details" tab. Falls back to parsing `output` when absent. */
  error?: { name?: string; message?: string; stack?: string } | null;
  steps: Array<{ stepName: string; states: RunHistoryEvent[] }>;
  history: RunHistoryEvent[];
  /** Inngest V2 trace API per-step outputs — preferred over `steps` for
   *  timeline + drill-in because it has real durations and JSON outputs. */
  stepOutputs?: RunStepOutput[];
  event?: { id: string; name: string; payload: string; createdAt: string } | null;
  tokenUsage?: { prompt: number; completion: number; total: number };
};

/** Short run-status label (i18n-aware). Pass `t` from useApp().
 *  Old name `STATUS_ZH` kept as a default-zh export below for any
 *  un-migrated callers, but new callers should use this. */
export function statusLabel(s: RunStatus, t: (k: string) => string): string {
  switch (s) {
    case "Running": return t("mox_status_running");
    case "Completed": return t("mox_status_completed");
    case "Failed": return t("mox_status_failed");
    case "Cancelled": return t("mox_status_cancelled");
    default: return s;
  }
}

/** @deprecated use statusLabel(s, t) — kept for back-compat with callers
 *  that don't have a `t` in scope yet. */
export const STATUS_ZH: Record<RunStatus, string> = {
  Running:   "运行中",
  Completed: "已完成",
  Failed:    "失败",
  Cancelled: "已取消",
};

export function statusDotColor(s: RunStatus): string {
  if (s === "Running")   return "var(--c-ok)";
  if (s === "Completed") return "var(--c-ink-3)";
  if (s === "Failed")    return "var(--c-err)";
  return "var(--c-ink-4)";
}

/**
 * Compact relative-time formatter (e.g. "刚刚" / "5m" / "2h" / "3d" in zh;
 * "just now" / "5m" / "2h" / "3d" in en). `t` is the i18n function from
 * useApp(). Older callers that pass only the iso default to a lang-agnostic
 * fallback that still drops the "刚刚" leak.
 */
export function relTime(iso: string | null | undefined, t?: (k: string) => string): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "—";
  const diffSec = Math.max(0, (Date.now() - ts) / 1000);
  if (diffSec < 60) return t ? t("common_just_now") : "—";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

export function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("zh-CN", { hour12: false }) +
      "." + String(d.getMilliseconds()).padStart(3, "0");
  } catch { return iso; }
}

export function formatDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Single Inngest app in this deployment. Function slugs are
// `agentic-operator-main-<fnId>`; the app portion is the constant prefix.
const INNGEST_APP_ID = "agentic-operator-main";
export function appFromSlug(slug: string | undefined | null): string | null {
  if (!slug) return null;
  return slug.startsWith(INNGEST_APP_ID) ? INNGEST_APP_ID : slug;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

export function extractErrorMessage(output: unknown): string | null {
  if (output == null) return null;
  if (typeof output === "string") {
    // Inngest sometimes serializes errors as a JSON string
    try {
      const parsed = JSON.parse(output);
      return extractErrorMessage(parsed);
    } catch {
      return output;
    }
  }
  if (typeof output === "object") {
    const o = output as { error?: { message?: string; name?: string }; message?: string; cause?: { message?: string } };
    if (o.error?.message) {
      const prefix = o.error.name ? `${o.error.name}: ` : "";
      return prefix + o.error.message;
    }
    if (o.message) return o.message;
    if (o.cause?.message) return o.cause.message;
    try { return JSON.stringify(o, null, 2).slice(0, 800); } catch { return null; }
  }
  return null;
}

export function failedStepName(detail: RunDetail | null): string | null {
  if (!detail?.steps) return null;
  for (const s of detail.steps) {
    if (!s.states?.length) continue;
    const lastState = s.states[s.states.length - 1];
    if (lastState?.type === "StepFailed" || lastState?.type === "StepErrored") {
      return s.stepName;
    }
  }
  return null;
}

// ── timeline ────────────────────────────────────────────────────

type TimelineSeg = {
  label: string;
  startMs: number;
  durationMs: number;
  isFunction: boolean;
  status: "running" | "completed" | "failed" | "scheduled";
};

export function buildTimeline(detail: RunDetail, runStartedAt: string | null, runFinishedAt: string | null): TimelineSeg[] {
  if (!runStartedAt) return [];
  const t0 = new Date(runStartedAt).getTime();
  const tEnd = runFinishedAt ? new Date(runFinishedAt).getTime() : Date.now();
  const out: TimelineSeg[] = [];

  out.push({
    label: "Function execution",
    startMs: 0,
    durationMs: Math.max(1, tEnd - t0),
    isFunction: true,
    status:
      detail.status === "Failed" || detail.status === "FAILED" ? "failed" :
      detail.status === "Running" || detail.status === "RUNNING" ? "running" :
      "completed",
  });

  // Prefer Inngest V2 trace spans when available — they have authoritative
  // queuedAt/startedAt/endedAt + real per-step durations + a stable spanID
  // that the per-step expansion can key on. Falls back to the legacy
  // `steps[]` derived from `history[]` for older runs / partial data.
  const fromSpans =
    detail.stepOutputs && detail.stepOutputs.length > 0
      ? detail.stepOutputs
          .filter((s) => s.startedAt || s.queuedAt)
          .map((s) => {
            const startAbs = new Date(s.startedAt ?? s.queuedAt ?? runStartedAt).getTime();
            const startMs = Math.max(0, startAbs - t0);
            const durationMs =
              typeof s.durationMs === "number" && s.durationMs > 0
                ? s.durationMs
                : s.endedAt
                  ? Math.max(1, new Date(s.endedAt).getTime() - startAbs)
                  : 1;
            const status: TimelineSeg["status"] =
              s.status === "FAILED" || s.status === "Failed"
                ? "failed"
                : s.status === "RUNNING" || s.status === "Running"
                  ? "running"
                  : s.status === "SCHEDULED" || s.status === "Scheduled"
                    ? "scheduled"
                    : "completed";
            return { label: s.name, startMs, durationMs, isFunction: false as const, status };
          })
          .sort((a, b) => a.startMs - b.startMs)
      : null;

  if (fromSpans && fromSpans.length > 0) {
    out.push(...fromSpans);
    return out;
  }

  const sorted = [...detail.steps]
    .filter((s) => s.stepName && s.stepName !== "step" && s.states?.length > 0)
    .map((s) => {
      const first = s.states[0];
      const last = s.states[s.states.length - 1];
      const startMs = new Date(first.createdAt).getTime() - t0;
      const endMs = new Date(last.createdAt).getTime() - t0;
      const finalState = last.type;
      const status: TimelineSeg["status"] =
        finalState === "StepFailed" || finalState === "StepErrored" ? "failed" :
        finalState === "StepCompleted" ? "completed" :
        finalState === "StepScheduled" ? "scheduled" :
        "running";
      return {
        label: s.stepName,
        startMs: Math.max(0, startMs),
        durationMs: Math.max(1, endMs - startMs),
        isFunction: false,
        status,
      };
    })
    .sort((a, b) => a.startMs - b.startMs);

  out.push(...sorted);
  return out;
}

export function TimelineRow({ seg, totalMs }: { seg: TimelineSeg; totalMs: number }) {
  const offsetPct = totalMs > 0 ? Math.max(0, Math.min(100, (seg.startMs / totalMs) * 100)) : 0;
  const widthPct = totalMs > 0 ? Math.max(0.5, Math.min(100 - offsetPct, (seg.durationMs / totalMs) * 100)) : 100;
  const barColor =
    seg.status === "failed"    ? "var(--c-err)" :
    seg.status === "running"   ? "var(--c-ok)" :
    seg.status === "scheduled" ? "var(--c-ink-4)" :
    seg.isFunction             ? "color-mix(in oklab, var(--c-ink-3) 50%, transparent)" :
    "var(--c-ok)";
  const barOpacity = seg.isFunction ? 0.4 : 0.85;
  return (
    <div
      className="grid items-center"
      style={{ gridTemplateColumns: "minmax(120px, 220px) 1fr 64px", gap: 10 }}
    >
      <span
        className={seg.isFunction ? "text-ink-2" : "text-ink-1"}
        style={{
          fontFamily: seg.isFunction ? "inherit" : "var(--f-mono)",
          fontSize: seg.isFunction ? 12 : 11.5,
          fontWeight: seg.isFunction ? 500 : 400,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={seg.label}
      >
        {seg.label}
      </span>
      <div className="relative" style={{ height: 14 }}>
        <div
          className="absolute"
          style={{
            top: 0, bottom: 0, left: 0, right: 0,
            background: "color-mix(in oklab, var(--c-line) 60%, transparent)",
            borderRadius: 2,
          }}
        />
        <div
          className="absolute"
          style={{
            top: 0, bottom: 0,
            left: `${offsetPct}%`,
            width: `${widthPct}%`,
            background: barColor,
            opacity: barOpacity,
            borderRadius: 2,
          }}
        />
      </div>
      <span className="text-ink-3 tabular-nums" style={{ fontSize: 11, textAlign: "right" }}>
        {formatDur(seg.durationMs)}
      </span>
    </div>
  );
}

// ── AI summary banner ───────────────────────────────────────────
// A one-line, template-generated natural-language read of the run, pulled
// from the trigger payload + status. No LLM call — derived client-side from
// data already in the detail response.

const STATUS_KEY: Record<RunStatus, string> = {
  Running: "mox_status_running",
  Completed: "mox_status_completed",
  Failed: "mox_status_failed",
  Cancelled: "mox_status_cancelled",
};

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

export function summarizeRun(
  run: RunRow,
  detail: RunDetail,
  agentName?: string,
  t?: (k: string) => string,
): string {
  const status = run.status;
  const phrase = t ? t(STATUS_KEY[status] ?? "") : "";
  const agent = agentName ?? run.function?.name ?? (t ? t("nav_agent_fleet") : "Agent");
  // Try to read business context out of the trigger payload.
  let ctx: Record<string, unknown> = {};
  if (detail.event?.payload) {
    try {
      const parsed = JSON.parse(detail.event.payload);
      ctx = (parsed?.data ?? parsed ?? {}) as Record<string, unknown>;
    } catch { /* keep empty */ }
  }
  const candidate = pick(ctx, ["candidateName", "candidate", "name", "applicantName"]);
  const client = pick(ctx, ["client", "clientName", "company", "customer"]);
  const job = pick(ctx, ["jobTitle", "position", "jdTitle", "title", "role"]);

  const target = [client, job].filter(Boolean).join(" · ");
  if (candidate && target) return `${candidate} · ${target} · ${phrase}`;
  if (target) return `${agent} · ${target} · ${phrase}`;
  if (run.eventName) return `${agent} · ${run.eventName} · ${phrase}`;
  return `${agent} · ${phrase}`;
}

type RunSummarySuccess = Extract<RunSummaryResponse, { ok: true }>;

/**
 * Inline AI summary block. Replaces the old heuristic one-liner banner.
 *
 * Behavior:
 *   - Running runs: skip fetch (no summary yet), show heuristic + "运行中" pill
 *   - Failed/Completed/Suspended: fetch /api/runs/<id>/summary on mount.
 *     The route is cache-then-lazy-synthesize; first viewer pays the LLM
 *     wait, subsequent viewers get the cached Postgres row instantly.
 *   - Header: title + AI badge + 重新生成 (DELETE + fresh refetch)
 *   - Body: full markdown via <Markdown compact /> when ok; heuristic
 *     one-liner as a fallback while loading / on error.
 */
function RunSummaryBanner({ run, detail, agentName }: { run: RunRow; detail: RunDetail; agentName?: string }) {
  const { t } = useApp();
  const failed = run.status === "Failed";
  const running = run.status === "Running";
  const tone = failed ? "var(--c-err)" : "var(--c-accent)";
  const heuristic = summarizeRun(run, detail, agentName, t);

  const [data, setData] = React.useState<RunSummarySuccess | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [regenerating, setRegenerating] = React.useState(false);

  const load = React.useCallback(
    async (fresh: boolean) => {
      if (running) return;
      setLoading(true);
      setErr(null);
      try {
        const path = `/api/runs/${encodeURIComponent(run.id)}/summary${fresh ? "?fresh=1" : ""}`;
        const r = await fetchJson<RunSummaryResponse>(path, { timeoutMs: 60_000 });
        if (r.ok) setData(r);
        else setErr(r.message ?? r.reason);
      } catch (e) {
        setErr((e as Error)?.message ?? "unknown error");
      } finally {
        setLoading(false);
      }
    },
    [run.id, running],
  );

  React.useEffect(() => {
    void load(false);
    // Refetch when the run advances past Running.
  }, [load, run.status]);

  const onRegenerate = React.useCallback(async () => {
    if (regenerating || loading) return;
    setRegenerating(true);
    try {
      await fetch(`/api/runs/${encodeURIComponent(run.id)}/summary`, { method: "DELETE" });
      await load(true);
    } finally {
      setRegenerating(false);
    }
  }, [run.id, regenerating, loading, load]);

  return (
    <div
      className="ao-pop-in rounded-lg"
      style={{
        padding: "11px 14px",
        background: `color-mix(in oklab, ${tone} 7%, var(--c-surface))`,
        border: `1px solid color-mix(in oklab, ${tone} 30%, var(--c-line))`,
      }}
    >
      {/* header row */}
      <div className="flex items-center gap-2" style={{ marginBottom: data || err ? 8 : 0 }}>
        <Ic.bolt style={{ width: 15, height: 15, color: tone, flexShrink: 0 }} />
        <span className="text-ink-1" style={{ fontSize: 12.5, fontWeight: 600 }}>
          {failed ? t("run_ai_summary_title_failed") : running ? t("run_ai_summary_title_running") : t("run_ai_summary_title_normal")}
        </span>
        {data && data.source === "llm" && (
          <span
            className="mono rounded-sm"
            style={{
              fontSize: 9.5,
              padding: "1px 6px",
              color: tone,
              background: `color-mix(in oklab, ${tone} 14%, transparent)`,
              border: `1px solid color-mix(in oklab, ${tone} 35%, var(--c-line))`,
            }}
          >
            {t("run_ai_summary_badge_ai")}
          </span>
        )}
        {data && (data.source === "fallback" || data.source === "static-fallback") && (
          <span
            className="mono rounded-sm"
            style={{
              fontSize: 9.5,
              padding: "1px 6px",
              color: "var(--c-ink-3)",
              background: "var(--c-panel)",
              border: "1px solid var(--c-line)",
            }}
          >
            {t("run_ai_summary_fallback_tag")}
          </span>
        )}
        {(loading || regenerating) && (
          <span className="text-ink-3 mono" style={{ fontSize: 10.5 }}>
            {t("run_ai_summary_loading")}
          </span>
        )}
        <div className="flex-1" />
        {!running && (
          <button
            onClick={onRegenerate}
            disabled={loading || regenerating}
            className="inline-flex items-center gap-1 rounded-md no-underline whitespace-nowrap shrink-0 ao-hover-lift bg-surface text-ink-2 cursor-pointer disabled:opacity-50"
            style={{
              padding: "4px 9px",
              border: "1px solid var(--c-line)",
              fontSize: 11,
            }}
          >
            ↻ {t("run_ai_summary_regenerate")}
          </button>
        )}
      </div>

      {/* body */}
      {running ? (
        <div className="text-ink-2" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
          {t("run_ai_summary_pending")}
        </div>
      ) : data ? (
        <div className="text-ink-1" style={{ fontSize: 12.5, lineHeight: 1.65 }}>
          <Markdown compact>{data.summaryText}</Markdown>
          {data.llmModel && (
            <div
              className="mono text-ink-4"
              style={{ fontSize: 10, marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--c-line)" }}
            >
              {data.llmModel}
              {data.llmDurationMs ? ` · ${(data.llmDurationMs / 1000).toFixed(1)}s` : ""}
              {data.llmPromptTokens != null && data.llmCompletionTokens != null
                ? ` · ${data.llmPromptTokens}/${data.llmCompletionTokens} tokens`
                : ""}
            </div>
          )}
        </div>
      ) : loading && !err ? (
        <div className="text-ink-2" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          {heuristic}
        </div>
      ) : err ? (
        <div className="flex flex-col gap-1.5">
          <div className="text-ink-2" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{heuristic}</div>
          <div className="text-err mono" style={{ fontSize: 10.5 }}>{t("run_ai_summary_failed_inline")}{err.slice(0, 120)}</div>
        </div>
      ) : (
        <div className="text-ink-1" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          {heuristic}
        </div>
      )}
    </div>
  );
}

// ── trace flow (labeled step list) ──────────────────────────────
// Image-reference style: a vertical list of 触发 / 步骤 / 工具 / LLM rows with
// a colored type marker, a human title, a from→to subline and a right-aligned
// timestamp + duration. Classification is derived from the step name's
// descriptor group + Inngest stepOp.

type TraceType = "trigger" | "step" | "tool" | "llm";

const TRACE_TONE: Record<TraceType, string> = {
  trigger: "var(--c-ok)",
  step:    "var(--c-ink-3)",
  tool:    "var(--c-accent)",
  llm:     "oklch(0.62 0.19 300)",
};

function classifyStep(name: string, group: string | undefined): TraceType {
  const g = group ?? "";
  const n = name.toLowerCase();
  if (g.includes("AI") || /\b(llm|ai|gateway|infer|gpt|gemini|model)\b/.test(n)) return "llm";
  if (g.includes("外部") || g.includes("回查") || g.includes("持久化") || g.includes("事件回发") ||
      /(api|fetch|lookup|rule-check|match|pg\.|allmeta|robohire|send)/.test(n)) return "tool";
  return "step";
}

function TraceFlow({ run, detail }: { run: RunRow; detail: RunDetail }) {
  const { t } = useApp();
  const t0 = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const segs = buildTimeline(detail, run.startedAt, run.finishedAt).filter((s) => !s.isFunction);

  const typeLabel: Record<TraceType, string> = {
    trigger: t("mox_trace_trigger"),
    step: t("mox_trace_step"),
    tool: t("mox_trace_tool"),
    llm: t("mox_trace_llm"),
  };

  const rows: Array<{ type: TraceType; title: string; sub: string | null; atMs: number | null; durMs: number | null; running?: boolean }> = [];

  // trigger row
  if (detail.event) {
    rows.push({
      type: "trigger",
      title: detail.event.name,
      sub: run.id ? `trace · ${run.id.slice(0, 10)}` : null,
      atMs: detail.event.createdAt ? new Date(detail.event.createdAt).getTime() : t0,
      durMs: null,
    });
  }
  for (const s of segs) {
    const desc = describeStep(s.label);
    const type = classifyStep(s.label, desc.group);
    rows.push({
      type,
      title: desc.label,
      sub: desc.fromTo ?? desc.group ?? null,
      atMs: t0 != null ? t0 + s.startMs : null,
      durMs: s.durationMs,
      running: s.status === "running",
    });
  }

  if (rows.length === 0) return null;

  return (
    <div>
      <div className="text-ink-3 mb-2.5" style={{ fontSize: 11.5, letterSpacing: "0.02em" }}>{t("mox_trace_label")}</div>
      <div className="flex flex-col">
        {rows.map((r, i) => {
          const tone = TRACE_TONE[r.type];
          const last = i === rows.length - 1;
          return (
            <div key={i} className="ao-fade-rise flex gap-3" style={{ ["--ao-i"]: i } as React.CSSProperties}>
              {/* marker + connector rail */}
              <div className="flex flex-col items-center" style={{ width: 16 }}>
                <span
                  className={r.running ? "rounded-full anim-pulse" : "rounded-full"}
                  style={{ width: 9, height: 9, marginTop: 3, background: tone, boxShadow: `0 0 0 3px color-mix(in oklab, ${tone} 16%, transparent)` }}
                />
                {!last && <span style={{ flex: 1, width: 1.5, background: "var(--c-line)", marginTop: 2 }} />}
              </div>
              {/* body */}
              <div className="flex-1 min-w-0" style={{ paddingBottom: last ? 0 : 14 }}>
                <div className="flex items-baseline gap-2 min-w-0">
                  <span
                    className="rounded px-1.5 font-medium shrink-0"
                    style={{ fontSize: 9.5, color: tone, background: `color-mix(in oklab, ${tone} 12%, transparent)`, lineHeight: "15px" }}
                  >
                    {typeLabel[r.type]}
                  </span>
                  <span className="text-ink-1 truncate" style={{ fontSize: 12.5, fontWeight: 500 }}>{r.title}</span>
                  <div className="flex-1" />
                  <span className="text-ink-4 tabular-nums shrink-0" style={{ fontSize: 10.5 }}>
                    {r.atMs != null ? new Date(r.atMs).toLocaleTimeString("zh-CN", { hour12: false }) : ""}
                    {r.durMs != null && <span className="ml-1.5">{formatDur(r.durMs)}</span>}
                    {r.running && <span className="ml-1.5" style={{ color: "var(--c-ok)" }}>{t("mox_summary_running")}</span>}
                  </span>
                </div>
                {r.sub && <div className="text-ink-3 truncate" style={{ fontSize: 11, marginTop: 1 }}>{r.sub}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── run detail body ─────────────────────────────────────────────

export function RunDetailBody({
  run, detail,
  agentShortForLinks,
  showAgentLink,
}: {
  run: RunRow;
  detail: RunDetail;
  agentShortForLinks?: string;  // for "Trigger ↗" link to Events
  showAgentLink?: boolean;       // when used in Monitor, show "Agent → Fleet" header
}) {
  const isFailed = run.status === "Failed";
  const errMsg = isFailed ? extractErrorMessage(detail.output) : null;
  const fStepName = isFailed ? failedStepName(detail) : null;
  const [showOutput, setShowOutput] = React.useState(false);
  const app = appFromSlug(run.function?.slug);
  const fnName = run.function?.name ?? null;
  const poll = run.status === "Running";

  return (
    <div className="flex flex-col gap-3">
      {/* AI summary banner — one-line read */}
      <RunSummaryBanner run={run} detail={detail} agentName={fnName ?? agentShortForLinks} />

      {/* meta + cross-link row */}
      <div className="flex items-baseline gap-x-5 gap-y-1 flex-wrap text-ink-3" style={{ fontSize: 11.5 }}>
        <MetaCell
          label="Run"
          value={
            <span
              className="select-all"
              style={{ fontFamily: "var(--f-mono)", color: "var(--c-ink-1)", wordBreak: "break-all" }}
            >
              {run.id}
            </span>
          }
        />
        {app && <MetaCell label="App" value={<span style={{ fontFamily: "var(--f-mono)" }}>{app}</span>} />}
        {fnName && <MetaCell label="Function" value={<span style={{ color: "var(--c-ink-1)" }}>{fnName}</span>} />}
        {run.startedAt && <MetaCell label="Started" value={fmtTime(run.startedAt)} />}
        {run.finishedAt && <MetaCell label="Ended" value={fmtTime(run.finishedAt)} />}
        <MetaCell
          label="Duration"
          value={
            <span className="tabular-nums" style={{ color: "var(--c-ink-1)" }}>
              {run.durationMs != null ? `${(run.durationMs / 1000).toFixed(2)}s` : "—"}
            </span>
          }
        />
        {detail.tokenUsage && detail.tokenUsage.total > 0 && (
          <MetaCell
            label="Tokens"
            value={<span className="tabular-nums">{detail.tokenUsage.total.toLocaleString()}</span>}
          />
        )}
      </div>

      {/* cross-page links — Agent / Event */}
      <div className="flex items-baseline gap-x-4 gap-y-1 flex-wrap" style={{ fontSize: 11.5 }}>
        {showAgentLink && agentShortForLinks && (
          <Link
            href={`/fleet/${encodeURIComponent(agentShortForLinks)}`}
            className="text-ink-2 hover:text-ink-1"
          >
            <span className="text-ink-4">Agent</span> {agentShortForLinks} →
          </Link>
        )}
        {run.eventName && (
          <Link
            href={`/events?name=${encodeURIComponent(run.eventName)}`}
            className="text-ink-2 hover:text-ink-1"
          >
            <span className="text-ink-4">Trigger</span> {run.eventName} →
          </Link>
        )}
      </div>

      {/* error block */}
      {isFailed && (errMsg || fStepName) && (
        <div className="flex flex-col gap-2">
          {fStepName && (
            <div className="flex items-baseline gap-2">
              <span className="text-ink-3" style={{ fontSize: 11.5 }}>失败步骤</span>
              <code
                className="text-ink-1 tabular-nums"
                style={{
                  fontFamily: "var(--f-mono)", fontSize: 11.5,
                  background: "var(--c-surface)", padding: "2px 6px", borderRadius: 4,
                  border: "1px solid var(--c-line)",
                }}
              >
                {fStepName}
              </code>
            </div>
          )}
          {errMsg && (
            <pre
              className="text-ink-1 whitespace-pre-wrap break-words"
              style={{
                fontFamily: "var(--f-mono)", fontSize: 11.5,
                margin: 0, padding: "8px 10px",
                background: "var(--c-surface)",
                border: "1px solid color-mix(in oklab, var(--c-err) 18%, var(--c-line))",
                borderRadius: 4, maxHeight: 180, overflow: "auto", lineHeight: 1.55,
              }}
            >
              {errMsg}
            </pre>
          )}
        </div>
      )}

      {/* trace — labeled flow (触发 / 步骤 / 工具 / LLM) */}
      <TraceFlow run={run} detail={detail} />

      {/* event panel — trigger event (name / id / received-at) with
          Input / Error details / Metadata tabs, mirroring Inngest dev UI. */}
      {detail.event && <EventPanel run={run} detail={detail} />}

      {/* 数据写入摘要 — Postgres step trace + Neo4j 实时反查 */}
      <DataWritesSummary runId={run.id} stepOutputs={detail.stepOutputs ?? []} poll={poll} />


      {/* per-step outputs — one expandable row per step.run / step.sendEvent.
          Mirrors what Inngest dev UI shows when you click a span. */}
      {detail.stepOutputs && detail.stepOutputs.length > 0 && (
        <div>
          <div className="text-ink-3 mb-2" style={{ fontSize: 11.5, letterSpacing: "0.02em" }}>
            Steps · {detail.stepOutputs.length}
          </div>
          <div className="flex flex-col gap-1.5">
            {detail.stepOutputs.map((s, i) => (
              <StepOutputRow key={s.spanID} step={s} stepIndex={i + 1} />
            ))}
          </div>
        </div>
      )}

      {/* 智能体完整日志 — surface AO 自己的 file log(按 run_id),补 Inngest trace
          漏 step + 无 input 的缺口。每一步全量 in/out。 */}
      {run.id && <AgentFullLog runId={run.id} poll={poll} />}

      {/* output */}
      {detail.output != null && (
        <div>
          <button
            onClick={() => setShowOutput((s) => !s)}
            className="flex items-center gap-1.5 text-ink-3 hover:text-ink-1"
            style={{ fontSize: 11.5 }}
          >
            <Ic.chev style={{ width: 10, height: 10, transition: "transform 0.15s", transform: showOutput ? "rotate(90deg)" : "rotate(0deg)" }} />
            Output
          </button>
          {showOutput && (
            <pre
              className="text-ink-1 whitespace-pre-wrap break-words mt-1.5"
              style={{
                fontFamily: "var(--f-mono)", fontSize: 11,
                margin: 0, padding: "8px 10px",
                background: "var(--c-surface)",
                border: "1px solid var(--c-line)",
                borderRadius: 4, maxHeight: 240, overflow: "auto", lineHeight: 1.55,
              }}
            >
              {typeof detail.output === "string"
                ? detail.output
                : JSON.stringify(detail.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// Shared monospace JSON / text block.
function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre
      className="text-ink-1 whitespace-pre-wrap break-words"
      style={{
        fontFamily: "var(--f-mono)", fontSize: 11, margin: 0,
        padding: "8px 10px", background: "var(--c-bg)",
        border: "1px solid var(--c-line)", borderRadius: 4,
        maxHeight: 320, overflow: "auto", lineHeight: 1.55,
      }}
    >
      {children}
    </pre>
  );
}

// ── Event panel ─────────────────────────────────────────────────
//
// Mirrors Inngest dev UI's right-hand event drawer: an event header
// (name · id · received-at) + Input / Error details / Metadata tabs.
// All data already comes from /api/inngest-admin/runs/[runId]
// (detail.event + detail.error + detail.output) — no extra fetch.

function EventPanel({ run, detail }: { run: RunRow; detail: RunDetail }) {
  type EventTab = "input" | "error" | "metadata";
  const ev = detail.event!;
  const [tab, setTab] = React.useState<EventTab>("input");

  let payloadPretty = ev.payload ?? "";
  if (ev.payload) {
    try { payloadPretty = JSON.stringify(JSON.parse(ev.payload), null, 2); } catch { payloadPretty = ev.payload; }
  }

  const err = detail.error ?? null;
  const errMsgFallback = run.status === "Failed" ? extractErrorMessage(detail.output) : null;
  const hasError = !!err || !!errMsgFallback;

  const metaRows: Array<[string, string]> = [
    ["Event name", ev.name],
    ["Event ID", ev.id],
    ["Received at", fmtDateTime(ev.createdAt)],
    ["Run ID", run.id],
    ["App", appFromSlug(run.function?.slug) ?? "—"],
    ["Function", run.function?.name ?? run.function?.slug ?? "—"],
    ["Status", run.status],
  ];

  const tabs: Array<{ id: EventTab; label: string }> = [
    { id: "input", label: "Input" },
    { id: "error", label: "Error details" },
    { id: "metadata", label: "Metadata" },
  ];

  return (
    <div style={{ border: "1px solid var(--c-line)", borderRadius: 6, background: "var(--c-surface)" }}>
      {/* header */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--c-line)" }}>
        <div className="text-ink-1" style={{ fontSize: 12.5, fontWeight: 600 }}>{ev.name}</div>
        <div className="flex items-baseline gap-x-4 gap-y-0.5 flex-wrap mt-1" style={{ fontSize: 11 }}>
          <MetaCell label="Event ID" value={<span className="select-all" style={{ fontFamily: "var(--f-mono)" }}>{ev.id}</span>} />
          <MetaCell label="Received at" value={<span className="tabular-nums">{fmtDateTime(ev.createdAt)}</span>} />
        </div>
      </div>
      {/* tab bar */}
      <div className="flex items-center gap-1" style={{ padding: "0 10px", borderBottom: "1px solid var(--c-line)" }}>
        {tabs.map((tb) => {
          const active = tab === tb.id;
          const isErrTab = tb.id === "error";
          return (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              style={{
                padding: "6px 8px",
                fontSize: 11.5,
                borderBottom: active ? "1.5px solid var(--c-ink-1)" : "1.5px solid transparent",
                color: active
                  ? "var(--c-ink-1)"
                  : isErrTab && hasError
                    ? "var(--c-err)"
                    : "var(--c-ink-3)",
                fontWeight: active ? 500 : 400,
                marginBottom: -1,
                background: "transparent",
              }}
            >
              {tb.label}
              {isErrTab && hasError && <span style={{ marginLeft: 4, color: "var(--c-err)" }}>•</span>}
            </button>
          );
        })}
      </div>
      {/* tab body */}
      <div style={{ padding: "8px 10px" }}>
        {tab === "input" && <Pre>{payloadPretty || "(empty)"}</Pre>}
        {tab === "error" && (
          err ? (
            <Pre>
              {(err.name ? `${err.name}: ` : "") + (err.message ?? "")}
              {err.stack ? `\n\n${err.stack}` : ""}
            </Pre>
          ) : errMsgFallback ? (
            <Pre>{errMsgFallback}</Pre>
          ) : (
            <div className="text-ink-4" style={{ fontSize: 11 }}>无错误 · No error</div>
          )
        )}
        {tab === "metadata" && (
          <div className="flex flex-col gap-1">
            {metaRows.map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-3" style={{ fontSize: 11 }}>
                <span className="text-ink-4" style={{ minWidth: 92, flexShrink: 0 }}>{k}</span>
                <span className="text-ink-1 select-all" style={{ fontFamily: "var(--f-mono)", wordBreak: "break-all" }}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 智能体完整日志 (2026-05-26) ────────────────────────────────────────────
//
// 从 /api/inngest-admin/runs/[runId]/agent-log 拉 AO 自己 file log 里这次 run 的
// 所有结构化事件(handler.raw_input / 各 step / emit / handler.done)。
// 这是**完整**源 — 不受 Inngest trace 漏 step / 无 input 限制。
// 每条事件展示 kind + from→to + 完整 payload JSON。

type AgentLogEvent = {
  ts: string;
  agent: string;
  run_id: string;
  kind: string;
  anchors?: Record<string, unknown>;
  payload?: unknown;
};

function AgentFullLog({ runId, poll }: { runId: string; poll?: boolean }) {
  const [events, setEvents] = React.useState<AgentLogEvent[] | null>(null);
  const [open, setOpen] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/inngest-admin/runs/${runId}/agent-log`)
        .then((r) => r.json())
        .then((b) => {
          if (!cancelled) setEvents(b.events ?? []);
        })
        .catch(() => {
          // keep prior events on a transient error so the live view doesn't blank
          if (!cancelled) setEvents((prev) => prev ?? []);
        });
    };
    load();
    const timer = poll ? setInterval(load, 4000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, poll]);

  if (events == null) return null;        // loading — 不闪
  if (events.length === 0) return null;   // 这个 run 没 file log(老 run / 非本机)

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-ink-3 hover:text-ink-1 mb-2"
        style={{ fontSize: 11.5, letterSpacing: "0.02em" }}
      >
        <Ic.chev
          style={{
            width: 10, height: 10, transition: "transform 0.15s",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
          }}
        />
        🔍 智能体完整日志 · 每一步 in/out · {events.length} 条
      </button>
      {open && (
        <div className="flex flex-col gap-1.5">
          {events.map((e, i) => (
            <AgentLogRow key={`${e.ts}-${i}`} event={e} index={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentLogRow({ event, index }: { event: AgentLogEvent; index: number }) {
  const [expanded, setExpanded] = React.useState(false);
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const from = typeof p.from === "string" ? p.from : null;
  const to = typeof p.to === "string" ? p.to : null;
  // kind → 人类可读
  const kindLabel = describeLogKind(event.kind);
  const hasPayload = event.payload != null;
  return (
    <div style={{ border: "1px solid var(--c-line)", borderRadius: 4, background: "var(--c-surface)" }}>
      <button
        type="button"
        onClick={() => hasPayload && setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-left hover:bg-[color:var(--c-panel)]"
        style={{ padding: "6px 10px", fontSize: 11.5, cursor: hasPayload ? "pointer" : "default" }}
      >
        {hasPayload && (
          <Ic.chev
            style={{
              width: 10, height: 10, transition: "transform 0.15s",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)", color: "var(--c-ink-4)",
            }}
          />
        )}
        <span className="text-ink-4 tabular-nums shrink-0" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
          {index}
        </span>
        <span className="text-ink-1 truncate" style={{ fontWeight: 500 }}>{kindLabel}</span>
        {(from || to) && (
          <span
            className="shrink-0"
            style={{
              fontFamily: "var(--f-mono)", fontSize: 10,
              color: "var(--c-accent)", background: "var(--c-accent-bg)",
              padding: "1px 5px", borderRadius: 3,
            }}
          >
            {from ?? "?"} → {to ?? "?"}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-ink-4 tabular-nums shrink-0" style={{ fontSize: 10.5 }}>
          {event.ts.slice(11, 23)}
        </span>
      </button>
      {expanded && hasPayload && (
        <pre
          className="text-ink-1 whitespace-pre-wrap break-words"
          style={{
            fontFamily: "var(--f-mono)", fontSize: 11, margin: 0,
            padding: "8px 10px", borderTop: "1px solid var(--c-line)",
            background: "var(--c-bg)", maxHeight: 360, overflow: "auto", lineHeight: 1.55,
          }}
        >
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

function StepOutputRow({ step, stepIndex }: { step: RunStepOutput; stepIndex: number }) {
  const [expanded, setExpanded] = React.useState(false);
  const statusColor =
    step.status === "FAILED" || step.status === "Failed"
      ? "var(--c-err)"
      : step.status === "RUNNING" || step.status === "Running"
        ? "var(--c-ok)"
        : step.status === "COMPLETED" || step.status === "Completed"
          ? "var(--c-ink-3)"
          : "var(--c-ink-4)";
  let pretty = step.output ?? "";
  if (step.output) {
    try {
      pretty = JSON.stringify(JSON.parse(step.output), null, 2);
    } catch {
      pretty = step.output;
    }
  }
  // 2026-05-26 — 把 cryptic step.name 翻译成业务语义 + 数据流向(不暴露底层存储).
  const desc = describeStep(step.name);
  return (
    <div
      style={{
        border: "1px solid var(--c-line)",
        borderRadius: 4,
        background: "var(--c-surface)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-left hover:bg-[color:var(--c-panel)]"
        style={{ padding: "6px 10px", fontSize: 11.5 }}
      >
        <Ic.chev
          style={{
            width: 10,
            height: 10,
            transition: "transform 0.15s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            color: "var(--c-ink-4)",
          }}
        />
        <span className="text-ink-4 tabular-nums shrink-0" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
          第 {stepIndex} 步
        </span>
        <span className="text-ink-1 truncate" style={{ fontWeight: 500 }}>
          {desc.label}
        </span>
        {desc.fromTo && (
          <span
            className="shrink-0"
            style={{
              fontFamily: "var(--f-mono)", fontSize: 10,
              color: "var(--c-accent)", background: "var(--c-accent-bg)",
              padding: "1px 5px", borderRadius: 3,
            }}
          >
            {desc.fromTo}
          </span>
        )}
        <span className="flex-1" />
        {step.durationMs != null && (
          <span className="text-ink-3 tabular-nums" style={{ fontSize: 11 }}>
            {formatDur(step.durationMs)}
          </span>
        )}
        <span className="tabular-nums" style={{ fontSize: 10.5, color: statusColor, minWidth: 70, textAlign: "right" }}>
          {step.status ?? "—"}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: "0 10px 8px", borderTop: "1px solid var(--c-line)" }}>
          {step.outputError ? (
            <div className="text-err mt-2" style={{ fontSize: 11 }}>
              output 拉取失败: {step.outputError}
            </div>
          ) : step.output == null ? (
            <div className="text-ink-3 italic mt-2" style={{ fontSize: 11 }}>
              {step.stepOp === "INVOKE" || step.stepOp === "WAIT_FOR_EVENT"
                ? "此 step 类型无 output"
                : "(无 output)"}
            </div>
          ) : (
            <pre
              className="text-ink-1 whitespace-pre-wrap break-words mt-2"
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 11,
                margin: 0,
                padding: "8px 10px",
                background: "var(--c-bg)",
                border: "1px solid var(--c-line)",
                borderRadius: 4,
                maxHeight: 280,
                overflow: "auto",
                lineHeight: 1.55,
              }}
            >
              {pretty}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function MetaCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span>
      <span className="text-ink-4">{label}</span>{" "}
      <span className="text-ink-2">{value}</span>
    </span>
  );
}

// ── 数据写入摘要 ──
//
// 按 step name 模式把写入操作分类成 Postgres / Neo4j 两组,显眼地展示
// 写了哪些实体 + 主键 ID + 成功/失败状态。展开后看完整 input + output。

type DataWriteEntry = {
  step: RunStepOutput;
  target: "Postgres" | "Neo4j";
  entityLabel: string;     // Job_Posting / Candidate / Resume / Application / Candidate_Match_Result
  primaryKey: string | null;
  ok: boolean;
  detail: string;          // 简短说明(如 "synced=true / created=true / 4xx 错误信息")
};

function classifyWriteStep(step: RunStepOutput): DataWriteEntry | null {
  const name = step.name;
  let target: "Postgres" | "Neo4j" | null = null;
  let entityLabel = "";

  // Postgres writes
  if (name.startsWith("sync-jd-")) {
    target = "Postgres";
    entityLabel = "Job_Posting + Job_Requisition + spec.status";
  } else if (name === "save-candidate") {
    target = "Postgres";
    entityLabel = "Candidate + Resume + Application";
  } else if (name.startsWith("save-match-")) {
    target = "Postgres";
    entityLabel = "Candidate_Match_Result + runtime_state";
  }
  // Neo4j writes (via allmeta)
  else if (name.startsWith("write-jobposting-neo4j-")) {
    target = "Neo4j";
    entityLabel = "Job_Posting";
  } else if (name.startsWith("write-candidate-neo4j-")) {
    target = "Neo4j";
    entityLabel = "Candidate";
  } else if (name.startsWith("write-resume-neo4j-")) {
    target = "Neo4j";
    entityLabel = "Resume";
  } else if (name.startsWith("write-application-neo4j-")) {
    target = "Neo4j";
    entityLabel = "Application";
  } else if (name.startsWith("write-cmr-neo4j-") || name.startsWith("write-cmr-")) {
    target = "Neo4j";
    entityLabel = "Candidate_Match_Result";
  }
  // RuleCheckAudit (AO SQLite)
  else if (name.startsWith("write-audit-")) {
    target = "Postgres";
    entityLabel = "RuleCheckAudit (AO SQLite)";
  } else {
    return null;
  }

  // Parse step output to extract pk + ok status
  let parsed: Record<string, unknown> | null = null;
  if (step.output) {
    try {
      parsed = JSON.parse(step.output) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  const stepOk = step.status === "COMPLETED" || step.status === "Completed";
  let okFromBody = stepOk;
  if (parsed && typeof parsed.ok === "boolean") okFromBody = parsed.ok;

  // Extract pk from output. partner-pg returns specific id fields; allmeta returns `instance.upserted[]`.
  let primaryKey: string | null = null;
  let detail = "";
  if (parsed) {
    const cmrId =
      (parsed.candidate_match_result_id as string | undefined) ?? null;
    const jpId = (parsed.job_posting_id as string | undefined) ?? null;
    const candId = (parsed.candidate_id as string | undefined) ?? null;
    const resId = (parsed.resume_id as string | undefined) ?? null;
    const appId = (parsed.application_id as string | undefined) ?? null;
    const auditId = (parsed.auditId as string | undefined) ?? null;
    primaryKey =
      cmrId ?? jpId ?? candId ?? resId ?? appId ?? auditId ?? null;
    // For allmeta safeWriteInstance result: {ok, instance: {upserted: [pk], ...}} or {ok:false, error}
    if (!primaryKey && parsed.instance && typeof parsed.instance === "object") {
      const inst = parsed.instance as Record<string, unknown>;
      const ups = inst.upserted;
      if (Array.isArray(ups) && ups.length > 0 && typeof ups[0] === "string") {
        primaryKey = ups[0] as string;
      }
    }
    if (typeof parsed.error === "string" && parsed.error) {
      detail = parsed.error.slice(0, 160);
    } else if (parsed.synced != null) {
      detail = `synced=${parsed.synced}` + (parsed.reason ? ` · ${parsed.reason}` : "");
    } else if (parsed.created != null) {
      detail = `created=${parsed.created}`;
    } else if (parsed.candidate_created != null) {
      detail = `candidate_created=${parsed.candidate_created} · resume_created=${parsed.resume_created ?? "?"}`;
    } else if (parsed.ok != null) {
      detail = okFromBody ? "ok" : "failed";
    }
  }

  return {
    step,
    target,
    entityLabel,
    primaryKey,
    ok: okFromBody,
    detail,
  };
}

// ── Neo4j 实时反查 ──
//
// Inngest dev server V2 trace 不一定把所有 step.run 都暴露在 childrenSpans,
// 导致 step-based 分类漏写。这里 useEffect 直接 fetch
// /api/monitor/run-neo4j-instances?runId=… 拿 allmeta 真实存在性,而非靠 trace。

type Neo4jProbeResult = {
  label: string;
  pk: string;
  source: 'event-input' | 'run-output';
  exists: boolean;
  error?: string;
};

function DataWritesSummary({
  runId,
  stepOutputs,
  poll,
}: {
  runId: string;
  stepOutputs: RunStepOutput[];
  poll?: boolean;
}) {
  const writes = React.useMemo(() => {
    const out: DataWriteEntry[] = [];
    for (const s of stepOutputs) {
      const e = classifyWriteStep(s);
      if (e) out.push(e);
    }
    return out;
  }, [stepOutputs]);

  // Live probe(绕开 Inngest trace 限制)— 一次 fetch 拿 Postgres + Neo4j 两边
  const [live, setLive] = React.useState<{
    loading: boolean;
    neoEntities: Neo4jProbeResult[];
    pgEntities: Neo4jProbeResult[];
    error?: string;
  }>({ loading: true, neoEntities: [], pgEntities: [] });

  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const load = () => {
      fetch(`/api/monitor/run-neo4j-instances?runId=${encodeURIComponent(runId)}`)
        .then((r) => r.json())
        .then((b) => {
          if (cancelled) return;
          if (b.entities || b.postgres_entities) {
            setLive({
              loading: false,
              neoEntities: b.entities ?? [],
              pgEntities: b.postgres_entities ?? [],
            });
          } else {
            setLive({
              loading: false,
              neoEntities: [],
              pgEntities: [],
              error: b.reason ?? b.error ?? 'unknown',
            });
          }
        })
        .catch((e) => {
          if (cancelled) return;
          setLive({
            loading: false,
            neoEntities: [],
            pgEntities: [],
            error: (e as Error).message ?? 'fetch-failed',
          });
        });
    };
    load();
    const timer = poll ? setInterval(load, 5000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, poll]);

  // Step-based detection kept as fallback when live probe returns nothing
  const pgFromSteps = writes.filter((w) => w.target === "Postgres");
  const neoFromSteps = writes.filter((w) => w.target === "Neo4j");
  const pgLiveExists = live.pgEntities.filter((e) => e.exists);
  const pgLiveMissing = live.pgEntities.filter((e) => !e.exists);
  const neoLiveExists = live.neoEntities.filter((e) => e.exists);
  const neoLiveMissing = live.neoEntities.filter((e) => !e.exists);

  const hasContent =
    writes.length > 0 ||
    live.neoEntities.length > 0 ||
    live.pgEntities.length > 0 ||
    live.loading;
  if (!hasContent) return null;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-ink-3" style={{ fontSize: 11.5, letterSpacing: "0.02em" }}>
        数据写入 · 业务数据库 {live.loading ? "…" : pgLiveExists.length}
        {pgLiveMissing.length > 0 && (
          <span style={{ color: "var(--c-err)" }}> ({pgLiveMissing.length} 缺失)</span>
        )}
        {" · 实例库 "}
        {live.loading ? "…" : neoLiveExists.length}
        {neoLiveMissing.length > 0 && (
          <span style={{ color: "var(--c-err)" }}> ({neoLiveMissing.length} 缺失)</span>
        )}
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <Neo4jLiveColumn
          title="业务数据库 · 实时反查"
          loading={live.loading}
          error={live.error}
          entities={live.pgEntities}
          stepFallback={pgFromSteps}
        />
        <Neo4jLiveColumn
          title="实例库 · 实时反查"
          loading={live.loading}
          error={live.error}
          entities={live.neoEntities}
          stepFallback={neoFromSteps}
        />
      </div>
    </div>
  );
}

function Neo4jLiveColumn({
  title,
  loading,
  error,
  entities,
  stepFallback,
}: {
  title: string;
  loading: boolean;
  error?: string;
  entities: Neo4jProbeResult[];
  stepFallback: DataWriteEntry[];
}) {
  return (
    <div
      style={{
        border: "1px solid var(--c-line)",
        borderRadius: 6,
        background: "var(--c-surface)",
        padding: 8,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          color: "var(--c-ok)",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {loading && (
        <div className="text-ink-4" style={{ fontSize: 11 }}>
          查询中…
        </div>
      )}
      {!loading && error && entities.length === 0 && (
        <div className="text-ink-4" style={{ fontSize: 11 }}>
          反查失败:{error}
        </div>
      )}
      {!loading && entities.length === 0 && !error && stepFallback.length === 0 && (
        <div className="text-ink-4" style={{ fontSize: 11 }}>
          (此 agent 无写入)
        </div>
      )}
      {!loading && entities.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {entities.map((e, i) => (
            <Neo4jProbeRow key={`${e.label}-${e.pk}-${i}`} entry={e} />
          ))}
        </div>
      )}
      {/* fallback: 如果 live 反查没数据,但 step trace 有,显示 step-based 信息 */}
      {!loading && entities.length === 0 && stepFallback.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {stepFallback.map((w, i) => (
            <WriteRow key={`${w.step.spanID}-${i}`} entry={w} />
          ))}
        </div>
      )}
    </div>
  );
}

function Neo4jProbeRow({ entry }: { entry: Neo4jProbeResult }) {
  const statusIcon = entry.exists ? "✓" : "✗";
  const statusColor = entry.exists ? "var(--c-ok)" : "var(--c-err)";
  return (
    <div
      style={{
        border: "1px solid var(--c-line)",
        borderRadius: 4,
        background: "var(--c-panel)",
        padding: "5px 8px",
        fontSize: 11,
      }}
    >
      <div className="flex items-start gap-2">
        <span style={{ color: statusColor, fontWeight: 600, width: 12 }}>{statusIcon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-ink-1" style={{ fontWeight: 500, fontSize: 11.5 }}>
            :{entry.label}
          </div>
          <div
            className="text-ink-3 truncate"
            style={{ fontFamily: "var(--f-mono)", fontSize: 10.5 }}
          >
            pk = {entry.pk}
          </div>
          {entry.error && (
            <div className="text-ink-4 truncate" style={{ fontSize: 10.5 }}>
              {entry.error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WriteColumn({
  title,
  tone,
  writes,
}: {
  title: string;
  tone: "accent" | "ok";
  writes: DataWriteEntry[];
}) {
  const headerColor = tone === "accent" ? "var(--c-accent)" : "var(--c-ok)";
  return (
    <div
      style={{
        border: "1px solid var(--c-line)",
        borderRadius: 6,
        background: "var(--c-surface)",
        padding: 8,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          color: headerColor,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {writes.length === 0 ? (
        <div className="text-ink-4" style={{ fontSize: 11 }}>
          (无写入)
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {writes.map((w, i) => (
            <WriteRow key={`${w.step.spanID}-${i}`} entry={w} />
          ))}
        </div>
      )}
    </div>
  );
}

function WriteRow({ entry }: { entry: DataWriteEntry }) {
  const [expanded, setExpanded] = React.useState(false);
  const statusIcon = entry.ok ? "✓" : "✗";
  const statusColor = entry.ok ? "var(--c-ok)" : "var(--c-err)";
  let outputPretty = "";
  if (entry.step.output) {
    try {
      outputPretty = JSON.stringify(JSON.parse(entry.step.output), null, 2);
    } catch {
      outputPretty = entry.step.output;
    }
  }
  return (
    <div
      style={{
        border: "1px solid var(--c-line)",
        borderRadius: 4,
        background: "var(--c-panel)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 text-left hover:bg-[color:var(--c-surface)]"
        style={{ padding: "5px 8px", fontSize: 11 }}
      >
        <Ic.chev
          style={{
            width: 9,
            height: 9,
            marginTop: 4,
            transition: "transform 0.15s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            color: "var(--c-ink-4)",
          }}
        />
        <span style={{ color: statusColor, fontWeight: 600, width: 12 }}>{statusIcon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-ink-1" style={{ fontWeight: 500, fontSize: 11.5 }}>
            {entry.entityLabel}
          </div>
          {entry.primaryKey && (
            <div className="text-ink-3 truncate" style={{ fontFamily: "var(--f-mono)", fontSize: 10.5 }}>
              pk = {entry.primaryKey}
            </div>
          )}
          {entry.detail && (
            <div className="text-ink-3 truncate" style={{ fontSize: 10.5 }}>
              {entry.detail}
            </div>
          )}
        </div>
      </button>
      {expanded && (
        <div style={{ padding: "0 8px 8px 28px", display: "flex", flexDirection: "column", gap: 6 }}>
          {outputPretty ? (
            <pre
              className="text-ink-1 whitespace-pre-wrap break-words"
              style={{
                fontFamily: "var(--f-mono)", fontSize: 10.5,
                margin: 0, padding: "6px 8px",
                background: "var(--c-surface)",
                border: "1px solid var(--c-line)",
                borderRadius: 4,
                maxHeight: 240,
                overflow: "auto",
                lineHeight: 1.5,
              }}
            >
              {outputPretty}
            </pre>
          ) : (
            <div className="text-ink-4" style={{ fontSize: 10.5 }}>(无 output)</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── run detail expansion (used both in detail-page-style and run-list-row) ──

export function RunDetailExpansion({
  run, detail,
  agentShortForLinks,
  showAgentLink,
}: {
  run: RunRow;
  detail: RunDetail | "loading" | "error" | undefined;
  agentShortForLinks?: string;
  showAgentLink?: boolean;
}) {
  const { t } = useApp();
  const isFailed = run.status === "Failed";
  const accent = isFailed ? "var(--c-err)" : "var(--c-line-strong)";
  return (
    <div
      className="ao-expand-reveal"
      style={{
        borderLeft: `2px solid ${accent}`,
        background: isFailed ? "color-mix(in oklab, var(--c-err) 3%, transparent)" : "var(--c-panel)",
        margin: "0 4px 8px 8px",
        padding: "14px 16px",
        borderRadius: "0 6px 6px 0",
      }}
    >
      {(!detail || detail === "loading") && (
        <div className="text-ink-3" style={{ fontSize: 12 }}>{t("mox_trace_loading")}</div>
      )}
      {detail === "error" && (
        <div className="text-ink-3" style={{ fontSize: 12 }}>{t("mox_trace_unavailable")}</div>
      )}
      {detail && detail !== "loading" && detail !== "error" && (
        <RunDetailBody
          run={run}
          detail={detail}
          agentShortForLinks={agentShortForLinks}
          showAgentLink={showAgentLink}
        />
      )}
    </div>
  );
}

// ── fetch helper (shared) ────────────────────────────────────────

export async function fetchRunDetail(runId: string): Promise<RunDetail | null> {
  try {
    const res = await fetch(`/api/inngest-admin/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) return null;
    const body = await res.json();
    // The API returns V2 step objects with a structured `error` ({name,message,stack}).
    // Pull the failed step's error so the Event panel's "Error details" tab is rich.
    const rawSteps: Array<{ status?: string; error?: { name?: string; message?: string; stack?: string } | null }> =
      Array.isArray(body.steps) ? body.steps : [];
    const failedStep =
      rawSteps.find((s) => s && s.error && /fail|error/i.test(String(s.status ?? ""))) ??
      rawSteps.find((s) => s && s.error);
    return {
      status: body.status,
      startedAt: body.startedAt,
      finishedAt: body.finishedAt,
      output: body.output,
      error: failedStep?.error ?? null,
      steps: body.steps ?? [],
      history: body.history ?? [],
      stepOutputs: Array.isArray(body.stepOutputs) ? body.stepOutputs : undefined,
      event: body.event ?? null,
      tokenUsage: body.tokenUsage,
    };
  } catch {
    return null;
  }
}
