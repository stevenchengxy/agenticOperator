"use client";
import React from "react";
import type { MonitorAgentDetail } from "@/lib/monitor/types";

const W = 720;
const H = 180;
const PAD = { top: 20, right: 20, bottom: 28, left: 48 };

export function TokenChart({ data }: { data: MonitorAgentDetail['tokenSpend'] }) {
  const peak = Math.max(1, ...data.map(d => Math.max(d.prompt, d.completion)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const xStep = data.length > 1 ? innerW / (data.length - 1) : innerW;

  const xy = (i: number, v: number) => ({
    x: PAD.left + i * xStep,
    y: PAD.top + innerH * (1 - v / peak),
  });

  const promptPath = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${xy(i, d.prompt).x} ${xy(i, d.prompt).y}`)
    .join(' ');
  const completionPath = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${xy(i, d.completion).x} ${xy(i, d.completion).y}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* Axes */}
      <line
        x1={PAD.left} y1={PAD.top + innerH}
        x2={W - PAD.right} y2={PAD.top + innerH}
        stroke="var(--c-claude-line)"
      />
      <text
        x={PAD.left - 6} y={PAD.top + 6}
        fontSize={10} textAnchor="end" fill="var(--c-claude-ink-4)"
      >
        {peak.toLocaleString()}
      </text>
      <text
        x={PAD.left - 6} y={PAD.top + innerH + 4}
        fontSize={10} textAnchor="end" fill="var(--c-claude-ink-4)"
      >
        0
      </text>
      {/* Series */}
      <path d={promptPath}     stroke="var(--c-claude-accent)" fill="none" strokeWidth={1.5} />
      <path d={completionPath} stroke="var(--c-claude-ok)"      fill="none" strokeWidth={1.5} strokeDasharray="4 3" />
      {/* Legend */}
      <g transform={`translate(${PAD.left}, ${H - 10})`}>
        <circle r={3} cx={4} cy={-3} fill="var(--c-claude-accent)" />
        <text x={12} y={0} fontSize={10} fill="var(--c-claude-ink-3)">Prompt</text>
        <circle r={3} cx={70} cy={-3} fill="var(--c-claude-ok)" />
        <text x={78} y={0} fontSize={10} fill="var(--c-claude-ink-3)">Completion</text>
      </g>
    </svg>
  );
}
