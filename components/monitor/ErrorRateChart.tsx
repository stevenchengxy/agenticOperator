"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import type { MonitorAgentDetail } from "@/lib/monitor/types";

const W = 720;
const H = 160;
const PAD = { top: 20, right: 20, bottom: 28, left: 48 };

export function ErrorRateChart({ data }: { data: MonitorAgentDetail['errorRate'] }) {
  const { t } = useApp();
  const peak = Math.max(1, ...data.map(d => d.total));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const barW = (innerW / data.length) * 0.8;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* X axis baseline */}
      <line
        x1={PAD.left} y1={PAD.top + innerH}
        x2={W - PAD.right} y2={PAD.top + innerH}
        stroke="var(--c-claude-line)"
      />
      {data.every(d => d.total === 0) && (
        <text
          x={(W) / 2}
          y={(H) / 2 + 4}
          fontSize={11}
          textAnchor="middle"
          fill="var(--c-claude-ink-4)"
        >
          {t("monitor_agent_no_errors")}
        </text>
      )}
      {/* Bars */}
      {data.map((d, i) => {
        const totalH  = innerH * (d.total  / peak);
        const failedH = innerH * (d.failed / peak);
        const x      = PAD.left + (i + 0.1) * (innerW / data.length);
        const yTotal  = PAD.top + innerH - totalH;
        const yFailed = PAD.top + innerH - failedH;
        return (
          <g key={i}>
            {/* Panel bar = total attempts */}
            <rect x={x} y={yTotal}  width={barW} height={totalH}  fill="var(--c-claude-panel)" />
            {/* Error bar = failed attempts */}
            <rect x={x} y={yFailed} width={barW} height={failedH} fill="var(--c-claude-err)" />
          </g>
        );
      })}
      {/* Y axis labels */}
      <text
        x={PAD.left - 6} y={PAD.top + 6}
        fontSize={10} textAnchor="end" fill="var(--c-claude-ink-4)"
      >
        {peak}
      </text>
      <text
        x={PAD.left - 6} y={PAD.top + innerH + 4}
        fontSize={10} textAnchor="end" fill="var(--c-claude-ink-4)"
      >
        0
      </text>
      {/* Legend */}
      <g transform={`translate(${PAD.left}, ${H - 10})`}>
        <rect x={0} y={-7} width={8} height={8} fill="var(--c-claude-panel)" />
        <text x={12} y={0} fontSize={10} fill="var(--c-claude-ink-3)">{t("monitor_run_col_total")}</text>
        <rect x={48} y={-7} width={8} height={8} fill="var(--c-claude-err)" />
        <text x={60} y={0} fontSize={10} fill="var(--c-claude-ink-3)">{t("monitor_filter_failed")}</text>
      </g>
    </svg>
  );
}
