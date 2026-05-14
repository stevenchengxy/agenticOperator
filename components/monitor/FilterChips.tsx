"use client";
import React from "react";
import { ClaudeChip } from "./atoms";

const WINDOW_OPTIONS: Array<{ id: string; ms: number; label: string }> = [
  { id: '5m',  ms: 5 * 60 * 1000,                label: '5min' },
  { id: '1h',  ms: 60 * 60 * 1000,               label: '1h' },
  { id: '24h', ms: 24 * 60 * 60 * 1000,          label: '24h' },
  { id: '7d',  ms: 7 * 24 * 60 * 60 * 1000,      label: '7d' },
];

export function FilterChips({
  windowMs,
  onWindowChange,
  status,
  onStatusChange,
  search,
  onSearchChange,
}: {
  windowMs: number;
  onWindowChange: (ms: number) => void;
  status?: string;
  onStatusChange: (s: string | undefined) => void;
  search: string;
  onSearchChange: (s: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11px] uppercase tracking-[0.08em] text-claude-ink-4">Time</span>
      {WINDOW_OPTIONS.map(opt => (
        <ClaudeChip
          key={opt.id}
          active={Math.abs(windowMs - opt.ms) < 1}
          onClick={() => onWindowChange(opt.ms)}
        >
          {opt.label}
        </ClaudeChip>
      ))}
      <span className="text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 ml-3">Status</span>
      <ClaudeChip active={!status} onClick={() => onStatusChange(undefined)}>All</ClaudeChip>
      <ClaudeChip active={status === 'running'} onClick={() => onStatusChange('running')}>Running</ClaudeChip>
      <ClaudeChip active={status === 'failed'} onClick={() => onStatusChange('failed')}>Failed</ClaudeChip>
      <ClaudeChip active={status === 'completed'} onClick={() => onStatusChange('completed')}>Completed</ClaudeChip>
      <div className="ml-auto">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="run / candidate / jd id…"
          className="rounded-full border border-claude-line bg-claude-surface px-3 py-1 text-[12.5px] w-[260px] focus:outline-none focus:ring-1 focus:ring-claude-accent"
        />
      </div>
    </div>
  );
}
