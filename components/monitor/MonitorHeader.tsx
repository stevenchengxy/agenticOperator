"use client";
import React from "react";
import { useApp } from "@/lib/i18n";

const STREAM_CONNECTED_THRESHOLD_MS = 10_000;

type Stats = {
  activeRuns: number;
  pendingHitl: number;
  failuresInWindow: number;
  tokensInWindow: number;
};

export function MonitorHeader({
  stats,
  lastSuccessAt,
  hasError,
}: {
  stats: Stats | null;
  lastSuccessAt: Date | null;
  hasError: boolean;
}) {
  const { t } = useApp();
  const ageMs = lastSuccessAt ? Date.now() - lastSuccessAt.getTime() : Infinity;
  const connected = !hasError && ageMs < STREAM_CONNECTED_THRESHOLD_MS;

  return (
    <div className="flex items-start justify-between mb-2">
      <div>
        <div className="text-[11px] uppercase tracking-[0.16em] text-claude-ink-4 font-medium mb-2">
          {t("monitor_hero_subtitle")}
        </div>
        <h1 className="text-[44px] font-medium leading-[1.05] text-claude-ink-1">
          Monitor
        </h1>
      </div>
      <div className="flex items-center gap-8">
        <StatTile label={t("monitor_stat_active")} value={stats?.activeRuns ?? "—"} />
        <StatTile label={t("monitor_stat_hitl")} value={stats?.pendingHitl ?? "—"} />
        <StatTile
          label={t("monitor_stat_failures")}
          value={stats?.failuresInWindow ?? "—"}
          tone={stats && stats.failuresInWindow > 0 ? "err" : undefined}
        />
        <StatTile
          label={t("monitor_stat_tokens")}
          value={stats ? fmt(stats.tokensInWindow) : "—"}
        />
        <StreamPill connected={connected} />
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "err";
}) {
  return (
    <div>
      <div
        className={`text-[26px] font-medium tabular-nums leading-none ${
          tone === "err" ? "text-claude-err" : "text-claude-ink-1"
        }`}
      >
        {value}
      </div>
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-claude-ink-4 mt-1">
        {label}
      </div>
    </div>
  );
}

function StreamPill({ connected }: { connected: boolean }) {
  const { t } = useApp();
  return (
    <div
      className={
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11.5px] " +
        (connected
          ? "bg-claude-ok/12 text-claude-ok"
          : "bg-claude-panel text-claude-ink-3")
      }
    >
      <span
        className={
          "inline-block w-1.5 h-1.5 rounded-full " +
          (connected ? "bg-claude-ok" : "bg-claude-ink-4")
        }
      />
      {connected ? t("monitor_stream_connected") : t("monitor_stream_disconnected")}
    </div>
  );
}

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
