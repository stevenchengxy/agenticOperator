"use client";
import React from "react";
import { NODES } from "@/lib/workflow-graph-meta";
import { useApp } from "@/lib/i18n";

// Column x-coordinate → human-readable stage label.
// Each column is defined by the shared x value of all nodes in that column.
const COLUMN_LABEL_KEYS: Record<number, string> = {
  100:  'monitor_stage_start',
  320:  'monitor_stage_requirement_intake',
  620:  'monitor_stage_jd_generation',
  920:  'monitor_stage_resume_processing',
  1220: 'monitor_stage_matching',
  1520: 'monitor_stage_interview_eval',
  1820: 'monitor_stage_package',
  2080: 'monitor_stage_submit_col',
};

export function StageBackdrop() {
  const { t } = useApp();
  // Derive unique x values in ascending order so labels render left-to-right.
  const columnXs = React.useMemo(
    () => [...new Set(NODES.map(n => n.x))].sort((a, b) => a - b),
    [],
  );

  return (
    <g>
      {columnXs.map(x => {
        const labelKey = COLUMN_LABEL_KEYS[x];
        if (!labelKey) return null;
        return (
          <text
            key={x}
            x={x}
            y={30}
            textAnchor="middle"
            fontSize={10}
            letterSpacing="0.14em"
            fill="var(--c-claude-ink-4)"
            fontWeight={500}
          >
            {t(labelKey)}
          </text>
        );
      })}
    </g>
  );
}
