"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeSectionTitle, ClaudeBadge } from "./atoms";
import type { MonitorRunRow } from "@/lib/monitor/types";

const STATUS_TONE = {
  running:   'accent',
  completed: 'ok',
  failed:    'err',
  suspended: 'warn',
  paused:    'warn',
} as const;

export function RecentRunsStrip({ rows }: { rows: MonitorRunRow[] }) {
  return (
    <ClaudeCard className="h-full">
      <ClaudeSectionTitle>Recent runs</ClaudeSectionTitle>
      <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
        {rows.length === 0 ? (
          <div className="text-claude-ink-4 text-[12.5px]">No runs.</div>
        ) : (
          rows.map((r) => (
            <Link
              key={r.id}
              href={`/monitor/runs/${encodeURIComponent(r.id)}`}
              className="flex-none w-[200px] rounded-[10px] border border-claude-line bg-claude-bg p-3 no-underline hover:bg-claude-panel"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-claude-ink-1 text-[12.5px] font-medium truncate">{r.triggerEvent}</span>
                <ClaudeBadge tone={STATUS_TONE[r.status] ?? 'neutral'} size="xs">{r.status}</ClaudeBadge>
              </div>
              <div className="text-claude-ink-3 text-[11.5px] truncate">{r.clientLabel ?? '—'}</div>
              <div className="text-claude-ink-4 text-[11px] mt-1 tabular-nums">{r.id.slice(0, 12)}…</div>
            </Link>
          ))
        )}
      </div>
    </ClaudeCard>
  );
}
