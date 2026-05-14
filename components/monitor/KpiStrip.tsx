"use client";
import React from "react";
import { ClaudeMetric } from "./atoms";
import { useApp } from "@/lib/i18n";
import type { MonitorKpi } from "@/lib/monitor/types";

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function KpiStrip({
  kpi,
  onApplyStatusFilter,
  onApplyHitlFilter,
}: {
  kpi: MonitorKpi | null;
  onApplyStatusFilter: (s: 'failed') => void;
  onApplyHitlFilter: () => void;
}) {
  const { t } = useApp();
  return (
    <div className="grid grid-cols-5 gap-3">
      <ClaudeMetric label={t("monitor_kpi_active_runs")} value={kpi ? fmt(kpi.activeRuns) : "—"} />
      <ClaudeMetric
        label={t("monitor_kpi_pending_hitl")}
        value={kpi ? fmt(kpi.pendingHitl) : "—"}
        emphasis={kpi && kpi.pendingHitl > 0 ? "warn" : "normal"}
        onClick={kpi && kpi.pendingHitl > 0 ? onApplyHitlFilter : undefined}
      />
      <ClaudeMetric
        label={t("monitor_kpi_failures")}
        value={kpi ? fmt(kpi.failuresInWindow) : "—"}
        emphasis={kpi && kpi.failuresInWindow > 0 ? "err" : "normal"}
        onClick={kpi && kpi.failuresInWindow > 0 ? () => onApplyStatusFilter('failed') : undefined}
      />
      <ClaudeMetric label={t("monitor_kpi_tokens")} value={kpi ? fmt(kpi.tokensInWindow) : "—"} />
      <ClaudeMetric
        label={t("monitor_kpi_queue_p95")}
        value={kpi == null || kpi.queueLagP95Ms == null ? "—" : `${kpi.queueLagP95Ms}ms`}
      />
    </div>
  );
}
