"use client";
import React from "react";
import clsx from "clsx";
import { useApp } from "@/lib/i18n";
import { Markdown } from "@/components/shared/Markdown";
import { ClaudeCard, ClaudeBadge } from "./atoms";
import { fetchJson } from "@/lib/api/client";
import type { RunSummaryResponse } from "@/app/api/runs/[id]/summary/route";

// Run AI Summary card
//
// Fetches /api/runs/:id/summary and renders the synthesized markdown summary.
// Auto-expanded for failed/suspended runs; otherwise expansion state is
// persisted in localStorage under 'ao:run-summary-expanded'. Critical states
// get a red border + anomaly badge. Running runs show a pending message
// (no fetch needed because summaries only generate on terminal status).
//
// 502 from the API includes a deterministic statistical `fallback` string;
// we render that with a warn banner + retry button so the page is never empty.

const STORAGE_KEY = "ao:run-summary-expanded";

type Props = {
  runId: string;
  status: string;
  lastActivityAt: string;
};

type FetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; data: Extract<RunSummaryResponse, { ok: true }> }
  | { kind: "fallback"; fallback: string; message: string | undefined }
  | { kind: "error"; message: string };

function isCritical(status: string): boolean {
  return status === "failed" || status === "suspended";
}

function isRunning(status: string): boolean {
  return status === "running" || status === "paused";
}

function readPersistedExpanded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "true";
  } catch {
    return false;
  }
}

function writePersistedExpanded(v: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, v ? "true" : "false");
  } catch {
    // ignore
  }
}

export function RunAiSummaryCard({ runId, status, lastActivityAt }: Props) {
  const { t, lang } = useApp();
  const critical = isCritical(status);
  const running = isRunning(status);

  // Default expansion: critical → always open. Otherwise read localStorage.
  const [expanded, setExpanded] = React.useState<boolean>(() => {
    if (critical) return true;
    return readPersistedExpanded();
  });
  const [state, setState] = React.useState<FetchState>({ kind: "idle" });
  const [regenerating, setRegenerating] = React.useState(false);

  const toggleExpand = React.useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      // Only persist for non-critical (critical is forced open anyway).
      if (!critical) writePersistedExpanded(next);
      return next;
    });
  }, [critical]);

  const load = React.useCallback(
    async (fresh: boolean) => {
      setState({ kind: "loading" });
      const path = `/api/runs/${encodeURIComponent(runId)}/summary${fresh ? "?fresh=1" : ""}`;
      try {
        const data = await fetchJson<RunSummaryResponse>(path, {
          timeoutMs: 30000,
        });
        if (data.ok) {
          setState({ kind: "ok", data });
        } else if (data.fallback) {
          setState({
            kind: "fallback",
            fallback: data.fallback,
            message: data.message,
          });
        } else {
          setState({
            kind: "error",
            message: data.message ?? data.reason,
          });
        }
      } catch (e: unknown) {
        // fetchJson throws ApiError for non-2xx. ApiError.body may contain
        // ok:false with fallback if server returned 502 JSON.
        const errObj = e as { body?: RunSummaryResponse; message?: string };
        if (errObj?.body && errObj.body.ok === false && errObj.body.fallback) {
          setState({
            kind: "fallback",
            fallback: errObj.body.fallback,
            message: errObj.body.message,
          });
        } else {
          setState({
            kind: "error",
            message: (e as Error)?.message ?? "unknown error",
          });
        }
      }
    },
    [runId],
  );

  // Initial fetch — skip while still running (no summary will exist yet).
  React.useEffect(() => {
    if (running) return;
    load(false);
  }, [running, load, lastActivityAt]);

  const onRegenerate = React.useCallback(async () => {
    setRegenerating(true);
    try {
      await fetch(`/api/runs/${encodeURIComponent(runId)}/summary`, {
        method: "DELETE",
      });
      await load(true);
    } finally {
      setRegenerating(false);
    }
  }, [runId, load]);

  // Title + tone
  let title: string;
  if (critical) title = t("run_ai_summary_title_failed");
  else if (running) title = t("run_ai_summary_title_running");
  else title = t("run_ai_summary_title_normal");

  const borderClass = critical
    ? "border-claude-err"
    : "border-claude-line";

  return (
    <ClaudeCard
      className={clsx("mb-5 p-5", borderClass, critical && "border-2")}
    >
      {/* Header */}
      <button
        type="button"
        onClick={running ? undefined : toggleExpand}
        disabled={running}
        className={clsx(
          "w-full flex items-center gap-2 text-left",
          !running && "cursor-pointer",
        )}
      >
        <h3 className="text-[14px] font-medium text-claude-ink-1 m-0">
          {title}
        </h3>
        {critical ? (
          <ClaudeBadge tone="err" size="xs">
            {t("run_ai_summary_badge_anomaly")}
          </ClaudeBadge>
        ) : (
          !running && (
            <ClaudeBadge tone="accent" size="xs">
              {t("run_ai_summary_badge_ai")}
            </ClaudeBadge>
          )
        )}
        {state.kind === "ok" && state.data.isStale && (
          <ClaudeBadge tone="warn" size="xs">
            {t("run_ai_summary_stale")}
          </ClaudeBadge>
        )}
        {state.kind === "fallback" && (
          <ClaudeBadge tone="warn" size="xs">
            {t("run_ai_summary_fallback_tag")}
          </ClaudeBadge>
        )}
        {!running && (
          <span
            className={clsx(
              "ml-auto text-[11px] text-claude-ink-4 transition-transform inline-block",
              expanded && "rotate-180",
            )}
          >
            ▾
          </span>
        )}
      </button>

      {/* Running state */}
      {running && (
        <p className="mt-2 text-[12.5px] text-claude-ink-3">
          {t("run_ai_summary_pending")}
        </p>
      )}

      {/* Body */}
      {!running && expanded && (
        <div className="mt-3">
          {state.kind === "loading" && (
            <p className="text-[12.5px] text-claude-ink-3">
              {t("run_ai_summary_loading")}
            </p>
          )}

          {state.kind === "ok" && (
            <>
              <Markdown compact>{state.data.summaryText}</Markdown>
              <SummaryMeta data={state.data} lang={lang} t={t} />
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={onRegenerate}
                  disabled={regenerating}
                  className="text-[11.5px] text-claude-ink-3 hover:text-claude-ink-1 underline underline-offset-2 disabled:opacity-50"
                >
                  {regenerating
                    ? t("run_ai_summary_loading")
                    : t("run_ai_summary_regenerate")}
                </button>
              </div>
            </>
          )}

          {state.kind === "fallback" && (
            <>
              <div className="mb-2 rounded-md border border-claude-warn/40 bg-claude-warn/10 px-3 py-2 text-[12px] text-claude-warn">
                {t("run_ai_summary_failed_inline")}
              </div>
              <Markdown compact>{state.fallback}</Markdown>
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => load(true)}
                  className="text-[11.5px] text-claude-accent hover:opacity-90 underline underline-offset-2"
                >
                  {t("run_ai_summary_retry")}
                </button>
              </div>
            </>
          )}

          {state.kind === "error" && (
            <>
              <div className="mb-2 rounded-md border border-claude-err/40 bg-claude-err/10 px-3 py-2 text-[12px] text-claude-err">
                {state.message}
              </div>
              <button
                type="button"
                onClick={() => load(true)}
                className="text-[11.5px] text-claude-accent hover:opacity-90 underline underline-offset-2"
              >
                {t("run_ai_summary_retry")}
              </button>
            </>
          )}
        </div>
      )}
    </ClaudeCard>
  );
}

// ── Meta row (model / duration / tokens / source) ───────────────────

function SummaryMeta({
  data,
  lang,
  t,
}: {
  data: Extract<RunSummaryResponse, { ok: true }>;
  lang: "zh" | "en";
  t: (key: string) => string;
}) {
  const parts: string[] = [];
  if (data.llmModel) parts.push(data.llmModel);
  if (data.llmDurationMs != null) parts.push(`${data.llmDurationMs}ms`);
  const totalTokens =
    (data.llmPromptTokens ?? 0) + (data.llmCompletionTokens ?? 0);
  if (totalTokens > 0) parts.push(`${totalTokens.toLocaleString()} tokens`);
  const sourceLabel =
    data.source === "llm"
      ? t("run_ai_summary_source_llm")
      : t("run_ai_summary_source_fallback");
  parts.push(`${lang === "zh" ? "来源" : "source"} ${sourceLabel}`);

  const when = new Date(data.generatedAt).toLocaleString();
  const generatedAt = t("run_ai_summary_meta_generated_at").replace(
    "{when}",
    when,
  );

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-claude-ink-4">
      <span>{parts.join(" · ")}</span>
      <span aria-hidden>·</span>
      <span>{generatedAt}</span>
    </div>
  );
}
