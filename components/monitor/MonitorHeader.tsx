"use client";
import React from "react";

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
  const ageMs = lastSuccessAt ? Date.now() - lastSuccessAt.getTime() : Infinity;
  const connected = !hasError && ageMs < STREAM_CONNECTED_THRESHOLD_MS;

  return (
    <div className="flex items-start justify-between mb-2">
      <div>
        <div className="text-[11px] uppercase tracking-[0.16em] text-claude-ink-4 font-medium mb-2">
          Agentic Operator · Live Ops
        </div>
        <h1 className="text-[44px] font-medium leading-[1.05] text-claude-ink-1">
          Monitor
        </h1>
      </div>
      <div className="flex items-center gap-8">
        <StatTile label="Active" value={stats?.activeRuns ?? "—"} />
        <StatTile label="HITL" value={stats?.pendingHitl ?? "—"} />
        <StatTile
          label="Failures"
          value={stats?.failuresInWindow ?? "—"}
          tone={stats && stats.failuresInWindow > 0 ? "err" : undefined}
        />
        <StatTile
          label="Tokens"
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
      {connected ? "Stream connected" : "Disconnected"}
    </div>
  );
}

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
