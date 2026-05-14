"use client";
import React from "react";

const ITEMS = [
  { id: "idle", label: "idle", color: "var(--c-claude-ink-4)" },
  { id: "running", label: "running", color: "var(--c-claude-warn)" },
  { id: "completed", label: "completed", color: "var(--c-claude-ok)" },
  { id: "failed", label: "failed", color: "var(--c-claude-err)" },
];

export function NodeStateLegend() {
  return (
    <div className="absolute bottom-3 right-3 inline-flex items-center gap-3 rounded-full bg-claude-surface/80 backdrop-blur-sm border border-claude-line px-3 py-1.5 text-[11px] text-claude-ink-3">
      {ITEMS.map((it) => (
        <span key={it.id} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}
