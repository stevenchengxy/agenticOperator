"use client";
import React from "react";
import clsx from "clsx";
import { useRouter, useSearchParams } from "next/navigation";
import { Ic } from "@/components/shared/Ic";
import { Pagination } from "@/components/shared/Pagination";
import { SystemStatusCards } from "./SystemStatusCards";
import { useApp } from "@/lib/i18n";
import { paginationFrom, readPage, readPageSize, setPaginationParams } from "@/lib/api/pagination";
import { AGENT_MAP, displayName as agentDisplayName, type Stage } from "@/lib/agent-mapping";
import { useDomain } from "@/lib/domains";
import { useDisplayNameResolver } from "@/lib/agent-names";
import {
  runDomainOf,
  useAgentDomainMap,
  slugToShort,
  shortToSlug,
} from "@/lib/monitor/run-domain";

// Stage order — workflow-natural left-to-right reading order. Matches Fleet's
// STAGE_ORDER. Used by AgentFilter to cluster the deployed agents.
const MONITOR_STAGE_ORDER: Stage[] = [
  "system",
  "requirement",
  "jd",
  "resume",
  "match",
  "interview",
  "eval",
  "package",
  "submit",
];

const MONITOR_STAGE_KEYS: Record<Stage, string> = {
  system: "flx_stage_system",
  requirement: "flx_stage_requirement",
  jd: "flx_stage_jd",
  resume: "flx_stage_resume",
  match: "flx_stage_match",
  interview: "flx_stage_interview",
  eval: "flx_stage_eval",
  package: "flx_stage_package",
  submit: "flx_stage_submit",
};
import { useDeploymentMap } from "@/lib/hooks/useDeploymentMap";
import {
  RunDetailExpansion,
  fetchRunDetail,
  statusLabel,
  statusDotColor,
  relTime,
  type RunRow,
  type RunDetail,
  type RunStatus,
} from "@/components/shared/RunTrace";

// /monitor — 运行监控
//
// Job: "What's running / has run? Show me the trace of any individual run."
// Plus: infrastructure status cards (event mgr / RAAS API / Ontology / Inngest).
//
// Per IA spec (2026-05-19):
//   - Run-level execution only (no agent registry → /fleet, no event stream → /events)
//   - Infrastructure status preserved per user explicit request
//
// Removed from the old multi-tab page:
//   - InngestAgentsTab → owned by /fleet
//   - InngestEventsTab → owned by /events
//   - DLQ tab → /alerts (future)
//   - MonitorGraph / RuntimeTopologyView → deferred

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

// Phase 0 (2026-06-01): Monitor's agent filter scopes to the active domain
// (matches /overview + /fleet). `shortsForDomain` is computed inside
// `AgentFilter` via useDomain() so switching domains in the AppBar
// immediately reshapes the chip strip.

type StatusFilter = "all" | RunStatus;
type WindowId = "1h" | "24h" | "7d" | "all";

export function MonitorContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const { t } = useApp();
  const { domain } = useDomain();
  const slugToDomain = useAgentDomainMap();

  const agentFilter = sp.get("agent");
  const statusFilter = (sp.get("status") ?? "all") as StatusFilter;
  const windowId = (sp.get("window") ?? "24h") as WindowId;
  const eventName = sp.get("event");
  const runIdParam = sp.get("run");
  const page = readPage(sp.get("page"));
  const pageSize = readPageSize(sp.get("pageSize"), [20, 50, 100], 50);

  const setUrl = React.useCallback((mut: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(sp.toString());
    mut(next);
    router.replace(`/monitor${next.toString() ? `?${next.toString()}` : ""}`);
  }, [router, sp]);

  const agentSlug = React.useMemo(() => {
    if (!agentFilter) return null;
    return shortToSlug(agentFilter);
  }, [agentFilter]);

  const [runs, setRuns] = React.useState<RunRow[] | null>(null);
  const [runsError, setRunsError] = React.useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = React.useState<string | null>(null);
  const [total, setTotal] = React.useState<number | null>(null);
  const [totalPages, setTotalPages] = React.useState<number | null>(null);
  const [runsLoading, setRunsLoading] = React.useState(true);
  const requestSeq = React.useRef(0);

  const refreshRuns = React.useCallback(async () => {
    const request = ++requestSeq.current;
    const params = new URLSearchParams({ domain });
    setPaginationParams(params, page, pageSize);
    if (agentSlug) params.set("fn", agentSlug);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (eventName) params.set("event", eventName);
    params.set("sinceHours", windowId === "1h" ? "1" : windowId === "24h" ? "24" : windowId === "7d" ? "168" : "all");
    setRunsLoading(true);
    try {
      const res = await fetch(`/api/inngest-admin/runs?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      if (request !== requestSeq.current) return;
      const nextRuns = Array.isArray(body.runs) ? body.runs : [];
      const pagination = paginationFrom(body, { page, pageSize, rowCount: nextRuns.length });
      setRuns(nextRuns);
      setTotal(pagination.total);
      setTotalPages(pagination.totalPages);
      setRunsError(null);
      setLastRefresh(new Date().toLocaleTimeString(undefined, { hour12: false }));
    } catch (cause) {
      if (request !== requestSeq.current) return;
      setRunsError(cause instanceof Error ? cause.message : t("mox_request_failed"));
      setRuns((previous) => previous ?? []);
    } finally {
      if (request === requestSeq.current) setRunsLoading(false);
    }
  }, [agentSlug, domain, eventName, page, pageSize, statusFilter, t, windowId]);

  React.useEffect(() => {
    void refreshRuns();
    const timer = setInterval(refreshRuns, page === 1 ? 5_000 : 15_000);
    return () => {
      requestSeq.current += 1;
      clearInterval(timer);
    };
  }, [page, refreshRuns]);

  React.useEffect(() => {
    if (totalPages != null && page > totalPages) {
      setUrl((params) => {
        if (totalPages <= 1) params.delete("page");
        else params.set("page", String(totalPages));
        params.delete("run");
      });
    }
  }, [page, setUrl, totalPages]);

  const filtered = React.useMemo(() => {
    if (!runs) return [];
    let xs = runs;
    // Scope to the active business domain — each run is attributed via its
    // Inngest function slug (energy runs → 能源调度, recruitment → 招聘), so
    // switching the AppBar domain shows only that domain's runs. (When a specific
    // agent is selected, the runs are already that agent's, so this is a no-op.)
    xs = xs.filter((r) => runDomainOf(r, slugToDomain) === domain);
    if (statusFilter !== "all") xs = xs.filter((r) => r.status === statusFilter);
    if (eventName) xs = xs.filter((r) => r.eventName === eventName);
    if (windowId !== "all") {
      const windowMs = windowId === "1h" ? 3600_000 : windowId === "24h" ? 86400_000 : 7 * 86400_000;
      const cutoff = Date.now() - windowMs;
      xs = xs.filter((r) => {
        if (!r.startedAt) return true;
        return new Date(r.startedAt).getTime() >= cutoff;
      });
    }
    return xs;
  }, [runs, statusFilter, eventName, windowId, domain, slugToDomain]);

  const counts = React.useMemo(() => {
    const c = { running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const r of filtered) {
      if (r.status === "Running") c.running++;
      else if (r.status === "Completed") c.completed++;
      else if (r.status === "Failed") c.failed++;
      else if (r.status === "Cancelled") c.cancelled++;
    }
    return c;
  }, [filtered]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-auto bg-bg">
      <div className="border-b border-line" style={{ padding: "28px 32px 18px" }}>
        <div className="flex items-start gap-6">
          <div className="flex-1 min-w-0">
            <h1 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontWeight: 500, fontSize: 26, letterSpacing: "-0.015em", lineHeight: 1.15 }}>
              {t("mox_page_title")}
            </h1>
            <div className="text-ink-2 mt-1.5" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
              {t("mox_page_subtitle")}
            </div>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <LiveDot lastRefresh={lastRefresh} />
          </div>
        </div>

        <div className="flex items-end gap-x-2 mt-3 flex-wrap">
          <MonitorTabs
            value={statusFilter}
            counts={{ all: filtered.length, running: counts.running, completed: counts.completed, failed: counts.failed }}
            onChange={(next) => setUrl((p) => {
              if (next === "all") p.delete("status");
              else p.set("status", next);
              p.delete("page");
              p.delete("run");
            })}
            t={t}
          />
          <div className="flex-1" />
          <div className="pb-2 flex items-center gap-2">
            <AgentFilter
              value={agentFilter}
              onChange={(v) => setUrl((p) => {
                if (v) p.set("agent", v);
                else p.delete("agent");
                p.delete("page");
                p.delete("run");
              })}
            />
            <WindowSelector value={windowId} onChange={(v) => setUrl((p) => {
              if (v === "24h") p.delete("window");
              else p.set("window", v);
              p.delete("page");
              p.delete("run");
            })} />
          </div>
        </div>
      </div>

      <div className="border-b border-line" style={{ padding: "0 32px", height: 1 }} />

      <>
          {/* infrastructure status — preserved per user request 2026-05-19 */}
          <div style={{ padding: "16px 32px 0" }}>
            <div className="text-ink-3 mb-2 flex items-baseline gap-2" style={{ fontSize: 12 }}>
              {t("mox_infra")}
            </div>
            <SystemStatusCards />
          </div>

          {/* secondary filter chips — only shown when active. The 智能体 +
              time-window controls moved into the top tab row; this strip
              now only surfaces the event chip + a clear-all link when any
              filter is active. */}
          {(agentFilter || eventName || statusFilter !== "all") && (
            <div className="flex items-center gap-3 mt-3 flex-wrap" style={{ padding: "0 32px", fontSize: 12.5 }}>
              {eventName && (
                <span className="inline-flex items-center gap-1.5 text-ink-2 rounded border border-line bg-surface" style={{ padding: "3px 9px", fontSize: 12 }}>
                  <span className="text-ink-3">{t("mox_filter_event")}</span> {eventName}
                  <button onClick={() => setUrl((p) => { p.delete("event"); p.delete("page"); p.delete("run"); })} className="text-ink-3 hover:text-ink-1 ml-1">×</button>
                </span>
              )}
              <button
                onClick={() => setUrl((p) => { p.delete("agent"); p.delete("event"); p.delete("status"); p.delete("page"); p.delete("run"); })}
                className="text-ink-3 hover:text-ink-1"
              >
                {t("mox_clear_filters")}
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0" style={{ padding: "8px 32px 48px" }}>
            {runsError && (
              <div
                className="mb-3 rounded-lg flex items-start gap-2.5"
                style={{
                  padding: "10px 14px",
                  background: "var(--c-warn-bg)",
                  border: "1px solid color-mix(in oklab, var(--c-warn) 35%, transparent)",
                  color: "oklch(0.45 0.14 75)",
                  fontSize: 12,
                }}
              >
                <span style={{ flexShrink: 0 }}>⚠</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium flex items-center gap-2">
                    <span>{t("mox_event_engine_unreachable")}</span>
                    <button className="text-accent hover:underline" onClick={() => void refreshRuns()}>{t("evx_retry")}</button>
                  </div>
                  <div className="mono text-[11px] opacity-80 mt-0.5 truncate" title={runsError}>{runsError}</div>
                </div>
              </div>
            )}
            {runs === null && !runsError && (
              <div className="text-ink-3 text-[13px] text-center py-16">{t("mox_loading")}</div>
            )}
            {runs !== null && filtered.length === 0 && !runsError && (
              <div className="text-ink-3 text-[13px] text-center py-16">
                {t("mox_no_matching_runs")}
              </div>
            )}
            {runs !== null && filtered.length === 0 && runsError && (
              <div className="text-ink-3 text-[13px] text-center py-8">
                {t("mox_waiting_inngest")}
              </div>
            )}
            {runs !== null && filtered.length > 0 && (
              <RunsList runs={filtered} initialExpandedId={runIdParam} onRunsMutated={refreshRuns} />
            )}
            {runs !== null && (runs.length > 0 || page > 1) && (
              <Pagination
                page={page}
                pageSize={pageSize}
                rowCount={runs.length}
                total={total}
                totalPages={totalPages}
                loading={runsLoading}
                onPageChange={(nextPage) => setUrl((params) => {
                  if (nextPage <= 1) params.delete("page");
                  else params.set("page", String(nextPage));
                  params.delete("run");
                })}
                onPageSizeChange={(nextSize) => setUrl((params) => {
                  if (nextSize === 50) params.delete("pageSize");
                  else params.set("pageSize", String(nextSize));
                  params.delete("page");
                  params.delete("run");
                })}
              />
            )}
          </div>
        </>
    </div>
  );
}

// ── runs list with expandable trace ─────────────────────────────

function RunsList({ runs, initialExpandedId, onRunsMutated }: { runs: RunRow[]; initialExpandedId: string | null; onRunsMutated?: () => void }) {
  const { t } = useApp();
  const [expandedId, setExpandedId] = React.useState<string | null>(initialExpandedId);
  const [details, setDetails] = React.useState<Record<string, RunDetail | "loading" | "error">>({});
  // Bulk retry selection — retry works by re-emitting each run's trigger
  // event, so only rows that still carry an eventId are selectable. "全选"
  // scopes to the current view: switch to the 失败 tab first to select all
  // failed runs in one click.
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const selectable = React.useMemo(
    () => runs.filter((r) => !!r.eventId),
    [runs],
  );
  // Selection is kept as run ids; derive against the current view so rows that
  // left the page/filter silently drop out of the pending batch.
  const selectedRuns = React.useMemo(
    () => runs.filter((r) => selected.has(r.id) && !!r.eventId),
    [runs, selected],
  );
  const toggleSelect = React.useCallback((runId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  const fetchDetail = React.useCallback(async (runId: string) => {
    if (details[runId] && details[runId] !== "error") return;
    setDetails((m) => ({ ...m, [runId]: "loading" }));
    const result = await fetchRunDetail(runId);
    setDetails((m) => ({ ...m, [runId]: result ?? "error" }));
  }, [details]);

  // Force re-fetch (no cache check, no loading flicker) — used by the live poll
  // so an in-progress run's steps / in-out / logs update in place.
  const refreshDetail = React.useCallback(async (runId: string) => {
    const result = await fetchRunDetail(runId);
    if (result) setDetails((m) => ({ ...m, [runId]: result }));
  }, []);

  // If a runId came in via URL, prefetch its detail
  React.useEffect(() => {
    if (initialExpandedId && !details[initialExpandedId]) {
      fetchDetail(initialExpandedId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialExpandedId]);

  // Live-refresh the expanded run's detail while it is Running. The status
  // string (not the whole runs array) is the dep, so completed runs don't
  // re-poll. The cleanup also pulls once more when the run leaves "Running",
  // capturing the final output/steps.
  const expandedRunStatus = expandedId
    ? runs.find((r) => r.id === expandedId)?.status
    : undefined;
  React.useEffect(() => {
    if (!expandedId || expandedRunStatus !== "Running") return;
    refreshDetail(expandedId);
    const timer = setInterval(() => refreshDetail(expandedId), 4000);
    return () => {
      clearInterval(timer);
      refreshDetail(expandedId);
    };
  }, [expandedId, expandedRunStatus, refreshDetail]);

  const toggle = (run: RunRow) => {
    const next = expandedId === run.id ? null : run.id;
    setExpandedId(next);
    if (next) fetchDetail(run.id);
  };

  return (
    <>
      <BulkRetryBar
        selectedCount={selectedRuns.length}
        selectableCount={selectable.length}
        onSelectAll={() => setSelected(new Set(selectable.map((r) => r.id)))}
        onClear={() => setSelected(new Set())}
        eventIds={[...new Set(selectedRuns.map((r) => r.eventId).filter((id): id is string => !!id))]}
        onRetried={() => {
          setSelected(new Set());
          onRunsMutated?.();
        }}
      />
      <div
        className="grid gap-4 text-ink-3 border-b border-line"
        style={{ gridTemplateColumns: "24px 200px minmax(0, 1fr) 110px 90px 80px 90px 18px", padding: "8px 12px", fontSize: 11.5, minWidth: 790 }}
      >
        <span />
        <span>{t("mox_col_agent")}</span>
        <span>{t("mox_col_trigger_event")}</span>
        <span>{t("mox_col_status")}</span>
        <span style={{ textAlign: "right" }}>{t("mox_col_started")}</span>
        <span style={{ textAlign: "right" }}>{t("mox_col_duration")}</span>
        <span style={{ textAlign: "center" }}>{t("mox_col_rerun")}</span>
        <span />
      </div>
      {runs.map((r, i) => {
        const expanded = expandedId === r.id;
        const agentShort = slugToShort(r.function?.slug);
        return (
          <div key={r.id} className="border-b border-line ao-fade-rise" style={{ ["--ao-i"]: Math.min(i, 18) } as React.CSSProperties}>
            <div
              className="w-full grid items-center gap-4 hover:bg-panel transition-colors"
              style={{ padding: "12px 12px", gridTemplateColumns: "24px 200px minmax(0, 1fr) 110px 90px 80px 90px 18px", minWidth: 790 }}
            >
              <span className="flex items-center justify-center">
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  disabled={!r.eventId}
                  onChange={() => toggleSelect(r.id)}
                  onClick={(e) => e.stopPropagation()}
                  title={r.eventId ? t("mox_select_run_tip") : t("mox_rerun_no_event_id")}
                  aria-label={t("mox_select_run_tip")}
                  className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ width: 13, height: 13, accentColor: "var(--c-accent)" }}
                />
              </span>
              <button
                onClick={() => toggle(r)}
                className="contents text-left cursor-pointer bg-transparent border-0"
              >
                <span className="text-ink-1 truncate" style={{ fontSize: 13, fontWeight: 500 }} title={agentShort ?? r.function?.slug ?? undefined}>
                  {agentShort ? agentDisplayName(agentShort) : r.function?.name ?? r.function?.slug ?? "—"}
                </span>
                <span className="text-ink-3 truncate" style={{ fontSize: 12 }}>
                  {r.eventName ?? "—"}
                </span>
                <span className="flex items-center gap-2">
                  <span className="rounded-full inline-block" style={{ width: 7, height: 7, background: statusDotColor(r.status) }} />
                  <span style={{ fontSize: 12.5, color: r.status === "Failed" ? "var(--c-err)" : "var(--c-ink-1)" }}>
                    {statusLabel(r.status, t)}
                  </span>
                </span>
                <span className="text-ink-3 tabular-nums" style={{ textAlign: "right", fontSize: 12 }}>
                  {relTime(r.startedAt, t)}
                </span>
                <span className="text-ink-3 tabular-nums" style={{ textAlign: "right", fontSize: 12 }}>
                  {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "—"}
                </span>
              </button>
              <ReplayRunButton run={r} />
              <button
                onClick={() => toggle(r)}
                className="text-ink-4 flex justify-center bg-transparent border-0 cursor-pointer"
                style={{ fontSize: 11 }}
                aria-label="toggle details"
              >
                <Ic.chev style={{ width: 10, height: 10, transition: "transform 0.15s", transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }} />
              </button>
            </div>
            {expanded && (
              <RunDetailExpansion
                run={r}
                detail={details[r.id]}
                agentShortForLinks={agentShort ?? undefined}
                showAgentLink
              />
            )}
          </div>
        );
      })}
    </>
  );
}

// ── Bulk retry bar (一键全选当前视图 + 批量重试, calls /api/inngest-admin/replay
//    with eventIds[]) — "全选" follows the active status tab / filters, so
//    selecting every failed run = switch to the 失败 tab, then 全选. Always
//    visible above the runs table so the affordance stays discoverable. ─────
function BulkRetryBar({
  selectedCount,
  selectableCount,
  onSelectAll,
  onClear,
  eventIds,
  onRetried,
}: {
  selectedCount: number;
  selectableCount: number;
  onSelectAll: () => void;
  onClear: () => void;
  eventIds: string[];
  onRetried: () => void;
}) {
  const { t } = useApp();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ text: string; ok: boolean } | null>(null);

  async function retrySelected() {
    if (eventIds.length === 0 || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/inngest-admin/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventIds }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error((b as { message?: string; error?: string }).message ?? (b as { error?: string }).error ?? `HTTP ${r.status}`);
      const failSuffix = b.failed > 0
        ? t("mox_bulk_retry_fail_suffix").replace("{fail}", String(b.failed))
        : "";
      setMsg({ text: `${t("mox_bulk_retry_done").replace("{ok}", String(b.replayed))}${failSuffix}`, ok: b.failed === 0 });
      onRetried();
    } catch (err) {
      setMsg({ text: `✗ ${(err as Error).message}`, ok: false });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 6000);
    }
  }

  return (
    <div className="flex items-center gap-3 flex-wrap border-b border-line" style={{ padding: "8px 12px", fontSize: 12 }}>
      <button
        type="button"
        onClick={onSelectAll}
        disabled={selectableCount === 0}
        className="text-[11px] px-2 py-1 rounded border border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink-1 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
      >
        {t("mox_select_all").replace("{n}", String(selectableCount))}
      </button>
      {selectedCount > 0 && (
        <span className="text-ink-3 tabular-nums">
          {t("mox_selected_n").replace("{n}", String(selectedCount))}
          <button
            type="button"
            onClick={onClear}
            className="ml-2 text-ink-3 hover:text-ink-1 underline-offset-2 hover:underline"
          >
            {t("mox_clear_selection")}
          </button>
        </span>
      )}
      <div className="flex-1" />
      {msg && (
        <span style={{ color: msg.ok ? "var(--c-ok)" : "var(--c-err)", fontSize: 11.5 }}>{msg.text}</span>
      )}
      <button
        type="button"
        onClick={retrySelected}
        disabled={busy || selectedCount === 0}
        className="text-[11px] px-2.5 py-1 rounded border border-accent text-accent hover:bg-accent-bg disabled:opacity-40 disabled:cursor-not-allowed font-medium whitespace-nowrap"
      >
        {busy ? t("mox_bulk_retrying") : `↺ ${t("mox_bulk_retry")}${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
      </button>
    </div>
  );
}

// ── Replay button (per-row, calls /api/inngest-admin/replay) ─────
function ReplayRunButton({ run }: { run: RunRow }) {
  const { t } = useApp();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  async function handle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!run.eventId) {
      setMsg(t('mox_no_event_id'));
      setTimeout(() => setMsg(null), 2000);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/inngest-admin/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: run.eventId }),
      });
      const b = await r.json();
      setMsg(b.ok ? `✓ ${t('mox_replay_triggered')}` : `✗ ${b.message ?? b.error ?? 'failed'}`);
    } catch (err) {
      setMsg(`✗ ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 2500);
    }
  }

  return (
    <button
      type="button"
      onClick={handle}
      disabled={busy || !run.eventId}
      title={run.eventId ? t('mox_replay_title').replace('{event}', run.eventId) : t('mox_rerun_no_event_id')}
      className="text-[11px] px-2 py-1 rounded border border-accent text-accent hover:bg-accent-bg disabled:opacity-40 disabled:cursor-not-allowed font-medium whitespace-nowrap"
      style={{ justifySelf: "center" }}
    >
      {busy ? '…' : msg ?? `↺ ${t('mox_rerun_short')}`}
    </button>
  );
}

// slug↔short + run→domain attribution now live in lib/monitor/run-domain.ts
// (shared with /overview's 智能体运行 panel).

// ── controls ────────────────────────────────────────────────────

function MonitorTabs({
  value, counts, onChange, t,
}: {
  value: StatusFilter;
  counts: { all: number; running: number; completed: number; failed: number };
  onChange: (v: StatusFilter) => void;
  t: (k: string) => string;
}) {
  const tabs: { id: StatusFilter; label: string; count: number; tone?: "ok" | "err" | "info" }[] = [
    { id: "all",       label: t("mox_count_all"),       count: counts.all },
    { id: "Running",   label: t("mox_count_running"),   count: counts.running, tone: counts.running > 0 ? "info" : undefined },
    { id: "Completed", label: t("mox_count_completed"), count: counts.completed, tone: counts.completed > 0 ? "ok" : undefined },
    { id: "Failed",    label: t("mox_count_failed"),    count: counts.failed, tone: counts.failed > 0 ? "err" : undefined },
  ];
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [ind, setInd] = React.useState<{ left: number; width: number } | null>(null);
  React.useLayoutEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-tab="${value}"]`);
    if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value, counts.all, counts.running, counts.completed, counts.failed]);
  return (
    <div ref={containerRef} className="relative flex items-end gap-1">
      {tabs.map((tab) => {
        const on = value === tab.id;
        const countColor =
          tab.tone === "err" ? "var(--c-err)"
          : tab.tone === "info" ? "var(--c-info)"
          : tab.tone === "ok" ? "var(--c-ok)"
          : on ? "var(--c-ink-2)" : "var(--c-ink-4)";
        return (
          <button
            key={tab.id}
            data-tab={tab.id}
            onClick={() => onChange(tab.id)}
            className="flex items-baseline gap-1.5 transition-colors"
            style={{ padding: "8px 12px 10px", color: on ? "var(--c-ink-1)" : "var(--c-ink-3)", fontWeight: on ? 600 : 400, fontSize: 13.5 }}
          >
            <span>{tab.label}</span>
            <span className="tabular-nums" style={{ fontSize: 12, color: countColor }}>{tab.count}</span>
          </button>
        );
      })}
      {ind && (
        <span className="absolute ao-tab-underline" style={{ bottom: 0, height: 2, background: "var(--c-ink-1)", left: ind.left, width: ind.width }} />
      )}
    </div>
  );
}

function WindowSelector({ value, onChange }: { value: WindowId; onChange: (v: WindowId) => void }) {
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const opts: { id: WindowId; label: string }[] = [
    { id: "1h", label: t("mox_window_1h") },
    { id: "24h", label: t("mox_window_24h") },
    { id: "7d", label: t("mox_window_7d") },
    { id: "all", label: t("mox_window_all") },
  ];
  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);
  const activeLabel = opts.find((o) => o.id === value)?.label ?? value;
  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded border border-line bg-surface text-ink-1 cursor-pointer hover:border-line-strong transition-colors"
        style={{ padding: "5px 12px", fontSize: 12.5 }}
      >
        <Ic.clock />
        <span>{activeLabel}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 min-w-[120px] bg-surface border border-line rounded-md shadow-sh-2 z-30 py-1"
        >
          {opts.map((o) => {
            const on = value === o.id;
            return (
              <button
                key={o.id}
                onClick={() => { onChange(o.id); setOpen(false); }}
                className="flex items-center w-full text-left transition-colors"
                style={{
                  padding: "6px 12px",
                  fontSize: 12.5,
                  color: on ? "var(--c-ink-1)" : "var(--c-ink-2)",
                  background: on ? "var(--c-accent-bg)" : "transparent",
                  fontWeight: on ? 500 : 400,
                }}
              >
                {o.label}
                {on && <span className="ml-auto text-[10px]" style={{ color: "var(--c-accent)" }}>●</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Small inline funnel SVG used in the AgentFilter trigger button. */
function FunnelIcon({ active }: { active?: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 1.7 : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 2h9l-3.5 4.5V11l-2-1V6.5L1.5 2z" />
    </svg>
  );
}

function AgentFilter({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const { t } = useApp();
  const { realness: realnessMap } = useDeploymentMap();
  const { domain } = useDomain();
  const resolveName = useDisplayNameResolver();
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Group deployed agents in the active domain by stage, in workflow order.
  const grouped = React.useMemo(() => {
    const byStage = new Map<Stage, typeof AGENT_MAP>();
    for (const a of AGENT_MAP) {
      if (a.domain !== domain) continue;
      if (a.short === "Chatbot") continue;
      if ((realnessMap.get(a.short) ?? "unbuilt") === "unbuilt") continue;
      const arr = byStage.get(a.stage) ?? [];
      arr.push(a);
      byStage.set(a.stage, arr);
    }
    return MONITOR_STAGE_ORDER.filter((s) => byStage.has(s)).map((s) => ({
      stage: s,
      agents: byStage.get(s)!,
    }));
  }, [realnessMap, domain]);

  const totalAgents = grouped.reduce((sum, g) => sum + g.agents.length, 0);
  const active = value !== null;
  const triggerLabel = active ? resolveName(value) : t("mox_col_agent");

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "inline-flex items-center gap-1.5 rounded border transition-colors cursor-pointer",
          active
            ? "border-[color:var(--c-accent-line)] bg-accent-bg text-[color:var(--c-accent)]"
            : "border-line bg-surface text-ink-1 hover:border-line-strong",
        )}
        style={{ padding: "5px 12px", fontSize: 12.5 }}
      >
        <FunnelIcon active={active} />
        <span>{triggerLabel}</span>
        {active && (
          <span
            className="ml-1 mono text-[10px] cursor-pointer rounded-sm hover:bg-bg"
            style={{ padding: "0 4px", color: "var(--c-ink-3)" }}
            onClick={(e) => { e.stopPropagation(); onChange(null); }}
            role="button"
            aria-label={t("mox_all")}
          >
            ✕
          </span>
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 bg-surface border border-line rounded-md shadow-sh-2 z-30"
          style={{ minWidth: 320, maxWidth: 480, padding: "10px 4px" }}
        >
          {/* All toggle */}
          <button
            onClick={() => { onChange(null); setOpen(false); }}
            className="flex items-center gap-2 w-full text-left transition-colors"
            style={{
              padding: "5px 12px",
              fontSize: 12.5,
              color: !active ? "var(--c-ink-1)" : "var(--c-ink-2)",
              background: !active ? "var(--c-accent-bg)" : "transparent",
              fontWeight: !active ? 500 : 400,
            }}
          >
            <span>{t("mox_all")}</span>
            <span className="ml-auto mono tabular-nums text-[11px] text-ink-3">{totalAgents}</span>
          </button>

          <div className="my-1.5 border-t border-line" />

          {/* Per-stage clusters inside the popover */}
          {grouped.length === 0 ? (
            <div className="text-ink-4" style={{ fontSize: 11.5, padding: "8px 12px" }}>
              {t("domain_empty_fleet")}
            </div>
          ) : (
            <div className="flex flex-col" style={{ gap: 4, padding: "4px 8px" }}>
              {grouped.map(({ stage, agents }) => (
                <div key={stage} className="flex items-baseline gap-2 flex-wrap">
                  <span
                    className="mono text-ink-4 flex-none"
                    style={{
                      fontSize: 10,
                      minWidth: 56,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      paddingTop: 4,
                    }}
                  >
                    {t(MONITOR_STAGE_KEYS[stage])}
                  </span>
                  <div className="flex items-center gap-1 flex-wrap">
                    {agents.map((a) => {
                      const on = value === a.short;
                      return (
                        <button
                          key={a.short}
                          onClick={() => { onChange(a.short); setOpen(false); }}
                          className="transition-colors rounded cursor-pointer"
                          style={{
                            padding: "3px 9px",
                            fontSize: 12,
                            color: on ? "var(--c-accent)" : "var(--c-ink-2)",
                            background: on ? "var(--c-accent-bg)" : "transparent",
                            border: on
                              ? "1px solid var(--c-accent-line)"
                              : "1px solid transparent",
                            fontWeight: on ? 500 : 400,
                          }}
                          title={a.short}
                        >
                          {resolveName(a.short)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LiveDot({ lastRefresh }: { lastRefresh: string | null }) {
  const { t } = useApp();
  const live = !!lastRefresh;
  return (
    <span
      className="flex items-center gap-1.5 text-ink-3"
      title={live ? t("mox_last_refresh").replace("{time}", lastRefresh) : t("mox_connecting_inngest")}
      style={{ fontSize: 11.5 }}
    >
      <span
        className={live ? "rounded-full anim-pulse" : "rounded-full"}
        style={{ width: 6, height: 6, background: live ? "var(--c-ok)" : "var(--c-ink-4)" }}
      />
      {live ? t("mox_live") : t("mox_connecting")}
    </span>
  );
}
