"use client";

import React from "react";
import { Btn } from "@/components/shared/atoms";

const MODELS = [
  { label: 'Gemini-3-flash-preview', value: 'gemini-3-flash-preview' },
  { label: 'Claude Opus 4.7', value: 'claude-opus-4-7' },
  { label: 'Kimi K2.6', value: 'kimi-k2.6' },
];

const CLIENTS = [
  { label: '— No override —', value: '' },
  { label: '字节跳动', value: 'CLI_BYTEDANCE' },
  { label: '腾讯', value: 'CLI_TENCENT_PCG' },
  { label: '华为', value: 'CLI_HUAWEI' },
];

export type TopBarRunItem = { id: string; startedAt: string; model: string; passCount: number; totalScenarios: number };

export type TopBarProps = {
  model: string;
  setModel: (m: string) => void;
  clientOverride: string;
  setClientOverride: (c: string) => void;
  runs: TopBarRunItem[];
  currentRunId: string | null;
  setCurrentRunId: (id: string | null) => void;
  compareRunId: string | null;
  setCompareRunId: (id: string | null) => void;
  isRunning: boolean;
  onRunAll: () => void;
  onReplayFailed: () => void;
  onExport: () => void;
};

export function TopBar(props: TopBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 p-3 border-b border-line bg-surface">
      <Btn variant="primary" onClick={props.onRunAll} disabled={props.isRunning}>
        {props.isRunning ? '⏳ Running…' : '▶ Run All'}
      </Btn>
      <Btn variant="ghost" onClick={props.onReplayFailed} disabled={props.isRunning}>↻ Replay Failed</Btn>
      <Btn variant="ghost" onClick={props.onExport} disabled={props.isRunning}>⤴ Export</Btn>

      <Selector label="Model" value={props.model} onChange={props.setModel} options={MODELS} />
      <Selector label="Client" value={props.clientOverride} onChange={props.setClientOverride} options={CLIENTS} />

      <RunSelector
        label="Run"
        value={props.currentRunId ?? ''}
        onChange={(v) => props.setCurrentRunId(v || null)}
        runs={props.runs}
        placeholder="— latest live —"
      />
      <RunSelector
        label="Compare"
        value={props.compareRunId ?? ''}
        onChange={(v) => props.setCompareRunId(v || null)}
        runs={props.runs.filter((r) => r.id !== props.currentRunId)}
        placeholder="— none —"
      />
    </div>
  );
}

function Selector({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="flex items-center gap-1 text-[11px] text-ink-3">
      <span>{label}</span>
      <select className="bg-surface border border-line rounded px-1 py-0.5 text-ink-1 text-[11px]"
              value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function RunSelector({ label, value, onChange, runs, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  runs: TopBarRunItem[];
  placeholder: string;
}) {
  return (
    <div className="flex items-center gap-1 text-[11px] text-ink-3">
      <span>{label}</span>
      <select className="bg-surface border border-line rounded px-1 py-0.5 text-ink-1 text-[11px] max-w-[260px]"
              value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.startedAt.slice(0, 16)} · {r.model} · {r.passCount}/{r.totalScenarios}
          </option>
        ))}
      </select>
    </div>
  );
}
