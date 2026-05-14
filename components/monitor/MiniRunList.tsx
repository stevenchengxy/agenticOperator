"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeSectionTitle, ClaudeBadge } from "./atoms";
import type { MonitorRunRow } from "@/lib/monitor/types";

type Props = {
  agentTitle: string;
  rows: MonitorRunRow[];
  onClose: () => void;
};

export function MiniRunList({ agentTitle, rows, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 bg-black/10 flex items-start justify-center pt-24" onClick={onClose}>
      <ClaudeCard className="w-[420px] max-h-[60vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <ClaudeSectionTitle>{agentTitle} — active runs</ClaudeSectionTitle>
          <button onClick={onClose} className="text-claude-ink-3 hover:text-claude-ink-1 text-[14px]">×</button>
        </div>
        {rows.length === 0 ? (
          <div className="text-claude-ink-4 text-[12.5px]">No active runs.</div>
        ) : (
          <ul className="flex flex-col divide-y divide-claude-line">
            {rows.slice(0, 5).map(r => (
              <li key={r.id} className="py-2 first:pt-0">
                <Link href={`/monitor/runs/${encodeURIComponent(r.id)}`} className="block no-underline hover:bg-claude-panel rounded p-1 -mx-1">
                  <div className="flex items-center justify-between">
                    <span className="text-claude-ink-1 text-[12.5px] font-medium">{r.triggerEvent}</span>
                    <ClaudeBadge tone="accent" size="xs">running</ClaudeBadge>
                  </div>
                  <div className="text-claude-ink-3 text-[11.5px]">{r.clientLabel ?? '—'} · {r.id.slice(0, 8)}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </ClaudeCard>
    </div>
  );
}
