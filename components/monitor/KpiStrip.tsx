"use client";
import React from "react";
import { ClaudeMetric } from "./atoms";
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
  return (
    <div className="grid grid-cols-5 gap-3">
      <ClaudeMetric label="Active runs" value={kpi ? fmt(kpi.activeRuns) : "—"} />
      <ClaudeMetric
        label="Pending HITL"
        value={kpi ? fmt(kpi.pendingHitl) : "—"}
        emphasis={kpi && kpi.pendingHitl > 0 ? "warn" : "normal"}
        onClick={kpi && kpi.pendingHitl > 0 ? onApplyHitlFilter : undefined}
      />
      <ClaudeMetric
        label="Failures (window)"
        value={kpi ? fmt(kpi.failuresInWindow) : "—"}
        emphasis={kpi && kpi.failuresInWindow > 0 ? "err" : "normal"}
        onClick={kpi && kpi.failuresInWindow > 0 ? () => onApplyStatusFilter('failed') : undefined}
      />
      <ClaudeMetric label="Tokens (window)" value={kpi ? fmt(kpi.tokensInWindow) : "—"} />
      <ClaudeMetric
        label="Queue p95"
        value={kpi == null || kpi.queueLagP95Ms == null ? "—" : `${kpi.queueLagP95Ms}ms`}
      />
    </div>
  );
}
