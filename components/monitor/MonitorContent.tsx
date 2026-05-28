"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Ic } from "@/components/shared/Ic";
import { SystemStatusCards } from "./SystemStatusCards";
import { InngestDlqTab } from "./InngestDlqTab";
import { useApp } from "@/lib/i18n";
import { AGENT_MAP, displayName as agentDisplayName } from "@/lib/agent-mapping";
import { useDeploymentMap } from "@/lib/hooks/useDeploymentMap";
import {
  RunDetailExpansion,
  fetchRunDetail,
  STATUS_ZH,
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

// AGENT_MAP order — used as a stable display order; the actual "deployed"
// subset is computed at render time via useDeploymentMap (Inngest live).
const ALL_AGENT_SHORTS: string[] = AGENT_MAP.map((a) => a.short);

type StatusFilter = "all" | RunStatus;
type WindowId = "1h" | "24h" | "7d";
type TabId = "runs" | "dlq";

export function MonitorContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const { t } = useApp();

  const agentFilter = sp.get("agent");
  const statusFilter = (sp.get("status") ?? "all") as StatusFilter;
  const windowId = (sp.get("window") ?? "24h") as WindowId;
  const eventName = sp.get("event");
  const runIdParam = sp.get("run");
  const tab: TabId = (sp.get("tab") === "dlq" ? "dlq" : "runs");

  const setUrl = React.useCallback((mut: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(sp.toString());
    mut(next);
    router.replace(`/monitor${next.toString() ? `?${next.toString()}` : ""}`);
  }, [router, sp]);

  const setTab = (next: TabId) => setUrl((p) => {
    if (next === "runs") p.delete("tab");
    else p.set("tab", next);
  });

  const agentSlug = React.useMemo(() => {
    if (!agentFilter) return null;
    return shortToSlug(agentFilter);
  }, [agentFilter]);

  const [runs, setRuns] = React.useState<RunRow[] | null>(null);
  const [runsError, setRunsError] = React.useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const url = agentSlug
          ? `/api/inngest-admin/runs?fn=${encodeURIComponent(agentSlug)}&limit=200`
          : `/api/inngest-admin/runs?limit=200`;
        const res = await fetch(url);
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg = (body as { message?: string }).message ?? `HTTP ${res.status}`;
          setRunsError(msg);
          // Keep the previously loaded runs visible (don't blank out the list on a transient hiccup)
          if (runs === null) setRuns([]);
          return;
        }
        const body = await res.json();
        if (cancelled) return;
        setRuns(body.runs ?? []);
        setRunsError(null);
        setLastRefresh(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      } catch (e) {
        if (cancelled) return;
        setRunsError((e as Error).message ?? t("mox_request_failed"));
        if (runs === null) setRuns([]);
      }
    }
    load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSlug]);

  const filtered = React.useMemo(() => {
    if (!runs) return [];
    let xs = runs;
    if (statusFilter !== "all") xs = xs.filter((r) => r.status === statusFilter);
    if (eventName) xs = xs.filter((r) => r.eventName === eventName);
    const windowMs = windowId === "1h" ? 3600_000 : windowId === "24h" ? 86400_000 : 7 * 86400_000;
    const cutoff = Date.now() - windowMs;
    xs = xs.filter((r) => {
      if (!r.startedAt) return true;
      return new Date(r.startedAt).getTime() >= cutoff;
    });
    return xs;
  }, [runs, statusFilter, eventName, windowId]);

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

        <div className="flex items-center gap-x-7 gap-y-1.5 mt-4 flex-wrap">
          <CountChip label={t("mox_count_total")} value={String(filtered.length)} tone="muted" />
          <CountChip
            label={t("mox_count_running")}
            value={String(counts.running)}
            tone={counts.running > 0 ? "ok" : "muted"}
            active={statusFilter === "Running"}
            onClick={() => setUrl((p) => statusFilter === "Running" ? p.delete("status") : p.set("status", "Running"))}
          />
          <CountChip
            label={t("mox_count_completed")}
            value={String(counts.completed)}
            tone="muted"
            active={statusFilter === "Completed"}
            onClick={() => setUrl((p) => statusFilter === "Completed" ? p.delete("status") : p.set("status", "Completed"))}
          />
          <CountChip
            label={t("mox_count_failed")}
            value={String(counts.failed)}
            tone={counts.failed > 0 ? "err" : "muted"}
            active={statusFilter === "Failed"}
            onClick={() => setUrl((p) => statusFilter === "Failed" ? p.delete("status") : p.set("status", "Failed"))}
          />
          <div className="flex-1" />
          <WindowSelector value={windowId} onChange={(v) => setUrl((p) => v === "24h" ? p.delete("window") : p.set("window", v))} />
        </div>
      </div>

      {/* tab nav */}
      <div className="flex items-center gap-1 border-b border-line" style={{ padding: "0 32px" }}>
        {(["runs", "dlq"] as TabId[]).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="transition-colors"
            style={{
              padding: "10px 14px",
              borderBottom: tab === id ? "1.5px solid var(--c-ink-1)" : "1.5px solid transparent",
              color: tab === id ? "var(--c-ink-1)" : "var(--c-ink-3)",
              fontWeight: tab === id ? 500 : 400,
              fontSize: 13,
              marginBottom: -1,
            }}
          >
            {t(id === "runs" ? "monitor_tab_runs" : "monitor_tab_dlq")}
          </button>
        ))}
      </div>

      {tab === "runs" && (
        <>
          {/* infrastructure status — preserved per user request 2026-05-19 */}
          <div style={{ padding: "16px 32px 0" }}>
            <div className="text-ink-3 mb-2 flex items-baseline gap-2" style={{ fontSize: 12 }}>
              {t("mox_infra")}
            </div>
            <SystemStatusCards />
          </div>

          {/* secondary filter toolbar */}
          <div className="flex items-center gap-3 mt-4 flex-wrap" style={{ padding: "10px 32px", fontSize: 12.5 }}>
            <span className="text-ink-3">{t("mox_col_agent")}</span>
            <AgentFilter
              value={agentFilter}
              onChange={(v) => setUrl((p) => v ? p.set("agent", v) : p.delete("agent"))}
            />
            {(agentFilter || eventName || statusFilter !== "all") && (
              <button
                onClick={() => setUrl((p) => { p.delete("agent"); p.delete("event"); p.delete("status"); })}
                className="text-ink-3 hover:text-ink-1"
              >
                {t("mox_clear_filters")}
              </button>
            )}
            {eventName && (
              <span className="inline-flex items-center gap-1.5 text-ink-2 rounded border border-line bg-surface" style={{ padding: "3px 9px", fontSize: 12 }}>
                <span className="text-ink-3">{t("mox_filter_event")}</span> {eventName}
                <button onClick={() => setUrl((p) => p.delete("event"))} className="text-ink-3 hover:text-ink-1 ml-1">×</button>
              </span>
            )}
          </div>

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
                  <div className="font-medium">{t("mox_event_engine_unreachable")}</div>
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
              <RunsList runs={filtered} initialExpandedId={runIdParam} />
            )}
          </div>
        </>
      )}

      {tab === "dlq" && (
        <div style={{ padding: "20px 32px" }}>
          <InngestDlqTab />
        </div>
      )}
    </div>
  );
}

// ── runs list with expandable trace ─────────────────────────────

function RunsList({ runs, initialExpandedId }: { runs: RunRow[]; initialExpandedId: string | null }) {
  const { t } = useApp();
  const [expandedId, setExpandedId] = React.useState<string | null>(initialExpandedId);
  const [details, setDetails] = React.useState<Record<string, RunDetail | "loading" | "error">>({});

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
      <div
        className="grid gap-4 text-ink-3 border-b border-line"
        style={{ gridTemplateColumns: "200px minmax(0, 1fr) 110px 90px 80px 90px 18px", padding: "8px 12px", fontSize: 11.5, minWidth: 760 }}
      >
        <span>{t("mox_col_agent")}</span>
        <span>{t("mox_col_trigger_event")}</span>
        <span>{t("mox_col_status")}</span>
        <span style={{ textAlign: "right" }}>{t("mox_col_started")}</span>
        <span style={{ textAlign: "right" }}>{t("mox_col_duration")}</span>
        <span style={{ textAlign: "center" }}>{t("mox_col_rerun")}</span>
        <span />
      </div>
      {runs.map((r) => {
        const expanded = expandedId === r.id;
        const agentShort = slugToShort(r.function?.slug);
        return (
          <div key={r.id} className="border-b border-line">
            <div
              className="w-full grid items-center gap-4 hover:bg-panel transition-colors"
              style={{ padding: "12px 12px", gridTemplateColumns: "200px minmax(0, 1fr) 110px 90px 80px 90px 18px", minWidth: 760 }}
            >
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
                    {STATUS_ZH[r.status]}
                  </span>
                </span>
                <span className="text-ink-3 tabular-nums" style={{ textAlign: "right", fontSize: 12 }}>
                  {relTime(r.startedAt)}
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

// Inngest app id (see server/inngest/client.ts). Slug shape: `<prefix>-<fnId>`.
// Static derivation here so the lookup doesn't depend on useInngestLiveOverlay
// being mounted upstream — /monitor is often the first page visited.
const INNGEST_APP_PREFIX = "agentic-operator-main-";

// Match the three fnId conventions kept in sync with lib/inngest-registry.ts:
//   1. explicit `inngestId` on AgentMeta
//   2. stub-factory `agent.<short.toLowerCase()>`
//   3. kebab `<kebab-short>-agent` (real-agent file convention)
function matchesFnId(a: (typeof AGENT_MAP)[number], fnId: string): boolean {
  if (a.inngestId === fnId) return true;
  if (fnId === `agent.${a.short.toLowerCase()}`) return true;
  const kebab = a.short.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "");
  return fnId === `${kebab}-agent`;
}

function shortToSlug(short: string): string | null {
  const meta = AGENT_MAP.find((a) => a.short === short);
  if (!meta) return null;
  const fnId = meta.inngestId ?? `agent.${meta.short.toLowerCase()}`;
  return `${INNGEST_APP_PREFIX}${fnId}`;
}

function slugToShort(slug: string | undefined): string | null {
  if (!slug) return null;
  const fnId = slug.startsWith(INNGEST_APP_PREFIX) ? slug.slice(INNGEST_APP_PREFIX.length) : slug;
  return AGENT_MAP.find((a) => matchesFnId(a, fnId))?.short ?? null;
}

// ── controls ────────────────────────────────────────────────────

function CountChip({
  label, value, tone, active, onClick,
}: {
  label: string;
  value: string;
  tone?: "ok" | "err" | "muted";
  active?: boolean;
  onClick?: () => void;
}) {
  const color =
    tone === "ok"    ? "var(--c-ok)" :
    tone === "err"   ? "var(--c-err)" :
    tone === "muted" ? "var(--c-ink-2)" :
    "var(--c-ink-1)";
  const Tag: React.ElementType = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={"flex items-baseline gap-2 transition-opacity " + (onClick ? "cursor-pointer hover:opacity-75" : "")}
      style={{
        borderBottom: active ? "1.5px solid var(--c-ink-1)" : "1.5px solid transparent",
        paddingBottom: 2,
      }}
    >
      <span className="text-ink-3" style={{ fontSize: 12 }}>{label}</span>
      <span className="font-semibold tabular-nums" style={{ fontSize: 18, color, letterSpacing: "-0.015em" }}>{value}</span>
    </Tag>
  );
}

function WindowSelector({ value, onChange }: { value: WindowId; onChange: (v: WindowId) => void }) {
  const { t } = useApp();
  const opts: { id: WindowId; label: string }[] = [
    { id: "1h", label: t("mox_window_1h") },
    { id: "24h", label: t("mox_window_24h") },
    { id: "7d", label: t("mox_window_7d") },
  ];
  return (
    <div className="flex items-center gap-1">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className="transition-colors rounded"
          style={{
            padding: "3px 9px",
            color: value === o.id ? "var(--c-ink-1)" : "var(--c-ink-3)",
            background: value === o.id ? "var(--c-panel)" : "transparent",
            fontWeight: value === o.id ? 500 : 400,
            fontSize: 12.5,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function AgentFilter({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const { t } = useApp();
  const { realness: realnessMap } = useDeploymentMap();
  const deployedShorts = React.useMemo(
    () => ALL_AGENT_SHORTS.filter((s) => (realnessMap.get(s) ?? "unbuilt") !== "unbuilt"),
    [realnessMap],
  );
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <button
        onClick={() => onChange(null)}
        className="transition-colors rounded"
        style={{
          padding: "3px 9px", fontSize: 12.5,
          color: value === null ? "var(--c-ink-1)" : "var(--c-ink-3)",
          background: value === null ? "var(--c-panel)" : "transparent",
          fontWeight: value === null ? 500 : 400,
        }}
      >
        {t("mox_all")}
      </button>
      {deployedShorts.map((short) => (
        <button
          key={short}
          onClick={() => onChange(short)}
          className="transition-colors rounded"
          style={{
            padding: "3px 9px", fontSize: 12.5,
            color: value === short ? "var(--c-ink-1)" : "var(--c-ink-3)",
            background: value === short ? "var(--c-panel)" : "transparent",
            fontWeight: value === short ? 500 : 400,
          }}
          title={short}
        >
          {agentDisplayName(short)}
        </button>
      ))}
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
