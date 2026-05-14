"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { usePoll } from "@/lib/monitor/usePoll";
import { AlertList } from "./AlertList";
import { ManagerActionList } from "./ManagerActionList";
import type { BehaviorApiResponse } from "@/lib/behavior/types";

// ── KPI strip ─────────────────────────────────────────────────────────────

function KpiCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className="bg-panel rounded-xl px-5 py-4 flex flex-col gap-1 border border-line"
      style={{ minWidth: 120 }}
    >
      <div
        className="text-[26px] font-bold mono"
        style={{ color: accent ? 'var(--c-fail, oklch(0.5 0.2 25))' : 'var(--c-ink-1)' }}
      >
        {value}
      </div>
      <div className="text-[11px] text-ink-4 uppercase tracking-[0.06em]">{label}</div>
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────

function SectionHead({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="text-[13px] font-semibold text-ink-1">{title}</span>
      {count !== undefined && (
        <span className="text-[11px] mono text-ink-4 bg-panel border border-line px-[6px] py-[1px] rounded-full">
          {count}
        </span>
      )}
    </div>
  );
}

// ── Pill: connection state ────────────────────────────────────────────────

function StreamPill({ lastSuccessAt, hasError }: { lastSuccessAt: Date | null; hasError: boolean }) {
  const stale = !lastSuccessAt || Date.now() - lastSuccessAt.getTime() > 20_000;
  const color = hasError || stale ? 'oklch(0.5 0.2 25)' : 'var(--c-ok, oklch(0.6 0.15 145))';
  return (
    <span className="flex items-center gap-[5px] text-[11px] text-ink-4">
      <span className="w-[6px] h-[6px] rounded-full inline-block" style={{ background: color }} />
      {hasError ? 'Disconnected' : lastSuccessAt ? 'Live · 8s' : 'Connecting…'}
    </span>
  );
}

// ── Main content ──────────────────────────────────────────────────────────

export function BehaviorContent() {
  const { t } = useApp();
  const { data, error, lastSuccessAt } = usePoll<BehaviorApiResponse>('/api/behavior', 8_000);

  const kpi = data?.kpi ?? { open: 0, in24h: 0, escalated: 0, autoResolved: 0 };
  const openAlerts = data?.openAlerts ?? [];
  const recentActions = data?.recentActions ?? [];

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-[28px] font-bold text-ink-1 leading-none mb-1">
            {t('behavior_title')}
          </div>
          <div className="text-[11.5px] tracking-[0.1em] uppercase text-ink-4">
            {t('behavior_subtitle')}
          </div>
        </div>
        <StreamPill lastSuccessAt={lastSuccessAt} hasError={!!error} />
      </div>

      {/* KPI strip */}
      <div className="flex gap-3 mb-8 flex-wrap">
        <KpiCard label={t('behavior_kpi_open')} value={kpi.open} accent={kpi.open > 0} />
        <KpiCard label={t('behavior_kpi_24h')} value={kpi.in24h} />
        <KpiCard label={t('behavior_kpi_escalated')} value={kpi.escalated} accent={kpi.escalated > 0} />
        <KpiCard label={t('behavior_kpi_auto_resolved')} value={kpi.autoResolved} />
      </div>

      {/* Two-column body */}
      <div className="grid gap-5" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {/* Left: Open alerts */}
        <div className="bg-surface border border-line rounded-xl p-5">
          <SectionHead title={t('behavior_alerts_title')} count={openAlerts.length} />
          <AlertList alerts={openAlerts} />
        </div>

        {/* Right: Manager decisions */}
        <div className="bg-surface border border-line rounded-xl p-5">
          <SectionHead title={t('behavior_actions_title')} count={recentActions.length} />
          <ManagerActionList actions={recentActions} />
        </div>
      </div>

      {/* Behavior agents status note */}
      <div className="mt-6 p-4 bg-panel border border-line rounded-lg text-[11.5px] text-ink-4">
        <span className="font-medium text-ink-3">Monitor Agent</span> runs every 60s via Inngest cron,
        evaluating 6 heuristic rules. <span className="font-medium text-ink-3">Manager Agent</span> responds
        to each MONITOR_ALERT with a rule-based decision (escalate / monitor / throttle / auto_restart).
        All events persist as EventInstance rows for the full audit trail.
      </div>
    </div>
  );
}
