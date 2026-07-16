"use client";
import React from "react";
import { usePoll } from "@/lib/monitor/usePoll";
import { ClaudeCard } from "./atoms";
import { useApp } from "@/lib/i18n";
import { fetchJson } from "@/lib/api/client";
import {
  formatRelativeTime,
  subsystemDetail,
  subsystemLabel,
  subsystemMetricLabel,
  subsystemStateLabel,
} from "./i18n-utils";
import type { MonitorSystemStatusResponse, SubsystemHealth } from "@/lib/monitor/types";
import { useDeepLinkFocus } from "@/lib/hooks/useDeepLinkFocus";

// ── Helpers ────────────────────────────────────────────────────────

function stateColor(state: SubsystemHealth["state"]): string {
  switch (state) {
    case "healthy":  return "bg-claude-ok";
    case "degraded": return "bg-claude-warn";
    case "down":     return "bg-claude-err";
    default:         return "bg-claude-ink-4";
  }
}

function localizedMetricValue(label: string, value: string, lang: "zh" | "en"): string {
  if (lang === "en") return value;
  if (label === "last sync") {
    const m = value.match(/^(\d+)([smhd]) ago$/);
    if (!m) return value;
    const unit = m[2] === "s" ? "秒" : m[2] === "m" ? "分钟" : m[2] === "h" ? "小时" : "天";
    return `${m[1]}${unit}前`;
  }
  return value;
}

function compactMetricValue(label: string, value: string, lang: "zh" | "en"): string {
  const localized = localizedMetricValue(label, value, lang);
  if (!["server", "callback", "registered", "endpoint"].includes(label)) return localized;
  try {
    const u = new URL(value);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return localized;
  }
}

// ── Single card ────────────────────────────────────────────────────

function StatusCard({ sub, onActionComplete }: { sub: SubsystemHealth; onActionComplete?: () => void }) {
  const { t, lang } = useApp();
  const [showTooltip, setShowTooltip] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  const label = subsystemLabel(sub.id, sub.label, t);
  const detail = subsystemDetail(sub.detail, t);
  const action =
    sub.id === "inngest"
      ? { label: t("monitor_infra_action_sync_inngest"), run: syncInngestApp }
      : sub.id === "neo4j"
        ? { label: t("monitor_infra_action_sync_neo4j"), run: syncNeo4j }
        : sub.id === "deployment" || sub.id === "raas"
          ? { label: t("monitor_infra_action_check"), run: checkInfra }
          : null;

  async function doAction(e: React.MouseEvent) {
    e.stopPropagation();
    if (!action || busy) return;
    setBusy(true);
    setResult(null);
    try {
      await action.run();
      setResult(t("monitor_infra_action_done"));
      onActionComplete?.();
    } catch (err) {
      setResult((err as Error).message || t("monitor_infra_action_failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" data-focus-key={`infra:${sub.id}`}>
      <ClaudeCard
        className="p-4 h-full min-w-0 overflow-hidden cursor-default"
        onMouseEnter={() => detail ? setShowTooltip(true) : undefined}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {/* Top row: dot + state label */}
        <div className="flex items-center gap-2 mb-2">
          <span
            className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${stateColor(sub.state)}`}
          />
          <span className="text-[10.5px] uppercase tracking-[0.08em] text-claude-ink-4 font-medium">
            {subsystemStateLabel(sub.state, t)}
          </span>
        </div>

        {/* Title */}
        <div className="text-[13px] font-medium text-claude-ink-1 leading-snug mb-0.5">
          {label}
        </div>

        {/* Last update */}
        <div className="text-[11px] text-claude-ink-4 mb-3">
          {formatRelativeTime(sub.lastUpdate, lang)}
        </div>

        {/* Metrics */}
        <div className="space-y-1 min-w-0">
          {sub.metrics.map((m) => (
            <div
              key={m.label}
              className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-1.5 text-[11.5px] leading-5 min-w-0"
            >
              <span className="text-claude-ink-4 whitespace-nowrap">
                {subsystemMetricLabel(m.label, t)}:
              </span>
              <span className="text-claude-ink-3 min-w-0 truncate tabular-nums" title={m.value}>
                {compactMetricValue(m.label, m.value, lang)}
              </span>
            </div>
          ))}
        </div>

        {action && (
          <div className="mt-3 flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={doAction}
              disabled={busy}
              className="h-6 px-2 shrink-0 rounded-md border border-claude-line text-[11px] text-claude-ink-2 hover:bg-claude-surface disabled:opacity-50"
            >
              {busy ? "…" : action.label}
            </button>
            {result && <span className="min-w-0 text-[10.5px] text-claude-ink-4 truncate">{result}</span>}
          </div>
        )}
      </ClaudeCard>

      {/* Tooltip */}
      {showTooltip && detail && (
        <div className="absolute left-0 top-full mt-1 z-30 max-w-[260px] rounded-[8px] border border-claude-line bg-claude-surface shadow-md px-3 py-2 text-[11.5px] text-claude-ink-2 leading-relaxed">
          {detail}
        </div>
      )}
    </div>
  );
}

async function syncInngestApp(): Promise<void> {
  const cfg = await fetchJson<{ inngest: { serveEndpointUrl: string } }>("/api/system/config", { cache: "no-store" });
  const r = await fetch("/api/inngest-admin/sync-app", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: cfg.inngest.serveEndpointUrl }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error ?? "sync failed");
}

async function syncNeo4j(): Promise<void> {
  const r = await fetch("/api/em/sync/event-definitions/run-now", { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error ?? j.result?.error ?? "sync failed");
}

async function checkInfra(): Promise<void> {
  const r = await fetch("/api/infra/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "check" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error ?? "check failed");
}

// ── Section ────────────────────────────────────────────────────────

const LOCAL_STORAGE_KEY = "ao:monitor:infra-collapsed";

export function SystemStatusCards({ paused = false, focusId = null }: { paused?: boolean; focusId?: string | null }) {
  const { t, lang } = useApp();

  // Persist collapsed state
  const [collapsed, setCollapsed] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(LOCAL_STORAGE_KEY) === "true";
  });

  const onToggle = React.useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      if (typeof window !== "undefined") localStorage.setItem(LOCAL_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const { data, error, refresh } = usePoll<MonitorSystemStatusResponse>(
    "/api/monitor/system-status",
    15_000,
    paused,
  );

  const subsystems = data?.subsystems ?? [];
  const focusKey = focusId ? `infra:${focusId}` : null;
  useDeepLinkFocus(focusKey, subsystems.some((sub) => sub.id === focusId));

  React.useEffect(() => {
    if (focusId) setCollapsed(false);
  }, [focusId]);

  return (
    <div className="mb-4">
      {/* Toggle header */}
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 text-[11.5px] text-claude-ink-3 hover:text-claude-ink-1 mb-2 transition-colors"
      >
        {t("monitor_infra_toggle")}
        <span className="text-[10px]">{collapsed ? "▶" : "▼"}</span>
        {data?.fetchedAt && (
          <span className="text-claude-ink-4 ml-2">
            {t("monitor_infra_updated")} {formatRelativeTime(data.fetchedAt, lang)}
          </span>
        )}
      </button>

      {!collapsed && (
        <>
          {error && (
            <p className="text-claude-err text-[12px] mb-2">
              {t("monitor_polling_error")} {error}
            </p>
          )}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
            {subsystems.length === 0
              ? [
                  { id: "em", label: t("monitor_ss_em"), state: "unknown", lastUpdate: null, metrics: [], detail: null },
                  { id: "raas", label: t("monitor_ss_raas"), state: "unknown", lastUpdate: null, metrics: [{ label: "endpoint", value: "—" }, { label: "http status", value: "—" }], detail: null },
                  { id: "neo4j", label: t("monitor_ss_neo4j"), state: "unknown", lastUpdate: null, metrics: [], detail: null },
                  { id: "inngest", label: t("monitor_ss_inngest"), state: "unknown", lastUpdate: null, metrics: [], detail: null },
                  { id: "deployment", label: t("monitor_ss_deployment"), state: "unknown", lastUpdate: null, metrics: [], detail: null },
                ].map((s) => (
                  <StatusCard key={s.id} sub={s as SubsystemHealth} onActionComplete={refresh} />
                ))
              : subsystems.map((s) => (
                  <StatusCard key={s.id} sub={s} onActionComplete={refresh} />
                ))
            }
          </div>
        </>
      )}
    </div>
  );
}
