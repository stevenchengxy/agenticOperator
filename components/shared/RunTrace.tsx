"use client";
import React from "react";
import Link from "next/link";
import { Ic } from "@/components/shared/Ic";

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
  steps: Array<{ stepName: string; states: RunHistoryEvent[] }>;
  history: RunHistoryEvent[];
  /** Inngest V2 trace API per-step outputs — preferred over `steps` for
   *  timeline + drill-in because it has real durations and JSON outputs. */
  stepOutputs?: RunStepOutput[];
  event?: { id: string; name: string; payload: string; createdAt: string } | null;
  tokenUsage?: { prompt: number; completion: number; total: number };
};

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

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffSec = Math.max(0, (Date.now() - t) / 1000);
  if (diffSec < 60) return "刚刚";
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
    .filter((s) => s.stepName && s.stepName !== "step" && s.states.length > 0)
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
  const timeline = buildTimeline(detail, run.startedAt, run.finishedAt);
  const [showOutput, setShowOutput] = React.useState(false);

  return (
    <div className="flex flex-col gap-3">
      {/* meta + cross-link row */}
      <div className="flex items-baseline gap-x-5 gap-y-1 flex-wrap text-ink-3" style={{ fontSize: 11.5 }}>
        <MetaCell label="Run" value={<span className="tabular-nums">{run.id.slice(0, 16)}…</span>} />
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

      {/* timeline */}
      {timeline.length > 0 && (
        <div>
          <div className="text-ink-3 mb-2" style={{ fontSize: 11.5, letterSpacing: "0.02em" }}>Trace</div>
          <div className="flex flex-col gap-1">
            {(() => {
              const totalMs = Math.max(...timeline.map((s) => s.startMs + s.durationMs), 1);
              return timeline.map((seg, i) => <TimelineRow key={i} seg={seg} totalMs={totalMs} />);
            })()}
          </div>
        </div>
      )}

      {/* event input — trigger payload that fired this run. Same data shown
          under "Input" in Inngest dev UI. */}
      {detail.event && (
        <JsonPanel
          label="Input"
          sublabel={detail.event.name}
          json={detail.event.payload}
        />
      )}

      {/* per-step outputs — one expandable row per step.run / step.sendEvent.
          Mirrors what Inngest dev UI shows when you click a span. */}
      {detail.stepOutputs && detail.stepOutputs.length > 0 && (
        <div>
          <div className="text-ink-3 mb-2" style={{ fontSize: 11.5, letterSpacing: "0.02em" }}>
            Steps · {detail.stepOutputs.length}
          </div>
          <div className="flex flex-col gap-1.5">
            {detail.stepOutputs.map((s) => (
              <StepOutputRow key={s.spanID} step={s} />
            ))}
          </div>
        </div>
      )}

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

// Collapsible JSON viewer — shared by Input panel and per-step output rows.
function JsonPanel({
  label,
  sublabel,
  json,
  defaultExpanded = false,
}: {
  label: string;
  sublabel?: string;
  json: string | null | undefined;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  let pretty = json ?? "";
  if (json) {
    try {
      pretty = JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      pretty = json;
    }
  }
  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-ink-3 hover:text-ink-1"
        style={{ fontSize: 11.5 }}
      >
        <Ic.chev
          style={{
            width: 10,
            height: 10,
            transition: "transform 0.15s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        />
        {label}
        {sublabel && (
          <span className="text-ink-4" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
            · {sublabel}
          </span>
        )}
      </button>
      {expanded && (
        <pre
          className="text-ink-1 whitespace-pre-wrap break-words mt-1.5"
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 11,
            margin: 0,
            padding: "8px 10px",
            background: "var(--c-surface)",
            border: "1px solid var(--c-line)",
            borderRadius: 4,
            maxHeight: 280,
            overflow: "auto",
            lineHeight: 1.55,
          }}
        >
          {pretty || "(empty)"}
        </pre>
      )}
    </div>
  );
}

function StepOutputRow({ step }: { step: RunStepOutput }) {
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
        <span
          className="flex-1 min-w-0 truncate text-ink-1"
          style={{ fontFamily: "var(--f-mono)" }}
          title={step.name}
        >
          {step.name}
        </span>
        {step.stepOp && (
          <span className="text-ink-4 tabular-nums" style={{ fontFamily: "var(--f-mono)", fontSize: 10.5 }}>
            {step.stepOp}
          </span>
        )}
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
  const isFailed = run.status === "Failed";
  const accent = isFailed ? "var(--c-err)" : "var(--c-line-strong)";
  return (
    <div
      style={{
        borderLeft: `2px solid ${accent}`,
        background: isFailed ? "color-mix(in oklab, var(--c-err) 3%, transparent)" : "var(--c-panel)",
        margin: "0 4px 8px 8px",
        padding: "14px 16px",
        borderRadius: "0 6px 6px 0",
      }}
    >
      {(!detail || detail === "loading") && (
        <div className="text-ink-3" style={{ fontSize: 12 }}>加载 trace…</div>
      )}
      {detail === "error" && (
        <div className="text-ink-3" style={{ fontSize: 12 }}>无法获取 trace(Inngest admin API 不可用)</div>
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
    return {
      status: body.status,
      startedAt: body.startedAt,
      finishedAt: body.finishedAt,
      output: body.output,
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
