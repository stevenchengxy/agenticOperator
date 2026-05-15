"use client";
import React from "react";
import { usePoll } from "@/lib/monitor/usePoll";
import { ClaudeCard } from "./atoms";
import { useApp } from "@/lib/i18n";
import {
  formatRelativeTime,
  subsystemDetail,
  subsystemLabel,
  subsystemMetricLabel,
  subsystemStateLabel,
} from "./i18n-utils";
import type { MonitorSystemStatusResponse, SubsystemHealth } from "@/lib/monitor/types";

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

// ── Single card ────────────────────────────────────────────────────

function StatusCard({ sub }: { sub: SubsystemHealth }) {
  const { t, lang } = useApp();
  const [showTooltip, setShowTooltip] = React.useState(false);
  const label = subsystemLabel(sub.id, sub.label, t);
  const detail = subsystemDetail(sub.detail, t);

  return (
    <div className="relative">
      <ClaudeCard
        className="p-4 cursor-default"
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
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {sub.metrics.map((m) => (
            <span key={m.label} className="text-[11.5px] text-claude-ink-3">
              <span className="text-claude-ink-4">{subsystemMetricLabel(m.label, t)}:</span> {localizedMetricValue(m.label, m.value, lang)}
            </span>
          ))}
        </div>
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

// ── Section ────────────────────────────────────────────────────────

const LOCAL_STORAGE_KEY = "ao:monitor:infra-collapsed";

export function SystemStatusCards({ paused = false }: { paused?: boolean }) {
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

  const { data, error } = usePoll<MonitorSystemStatusResponse>(
    "/api/monitor/system-status",
    15_000,
    paused,
  );

  const subsystems = data?.subsystems ?? [];

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
          <div className="grid grid-cols-4 gap-3">
            {subsystems.length === 0
              ? [
                  { id: "em", label: t("monitor_ss_em"), state: "unknown", lastUpdate: null, metrics: [], detail: null },
                  { id: "raas", label: t("monitor_ss_raas"), state: "unknown", lastUpdate: null, metrics: [{ label: "endpoint", value: "—" }, { label: "http status", value: "—" }], detail: null },
                  { id: "neo4j", label: t("monitor_ss_neo4j"), state: "unknown", lastUpdate: null, metrics: [], detail: null },
                  { id: "inngest", label: t("monitor_ss_inngest"), state: "unknown", lastUpdate: null, metrics: [], detail: null },
                ].map((s) => (
                  <StatusCard key={s.id} sub={s as SubsystemHealth} />
                ))
              : subsystems.map((s) => (
                  <StatusCard key={s.id} sub={s} />
                ))
            }
          </div>
        </>
      )}
    </div>
  );
}
