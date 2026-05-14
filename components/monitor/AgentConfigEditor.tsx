"use client";
import React from "react";
import { ClaudeButton } from "./atoms";
import { useApp } from "@/lib/i18n";
import type { MonitorAgentDetail } from "@/lib/monitor/types";

type Props = {
  agentName: string;
  initialConfig: MonitorAgentDetail['config'];
  onSaved?: () => void;
};

export function AgentConfigEditor({ agentName, initialConfig, onSaved }: Props) {
  const { t } = useApp();
  const [draft, setDraft] = React.useState({
    temperature: initialConfig?.temperature ?? null,
    maxRetries: initialConfig?.maxRetries ?? null,
    tier: initialConfig?.tier ?? '',
    maxOutputTokens: initialConfig?.maxOutputTokens ?? null,
    promptAppend: initialConfig?.promptAppend ?? '',
  });
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [isError, setIsError] = React.useState(false);

  const update = <K extends keyof typeof draft>(key: K, val: (typeof draft)[K]) => {
    setDraft(prev => ({ ...prev, [key]: val }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    setIsError(false);
    try {
      const body: Record<string, unknown> = {};
      if (draft.temperature !== null) body.temperature = draft.temperature;
      if (draft.maxRetries !== null) body.maxRetries = draft.maxRetries;
      if (draft.tier) body.tier = draft.tier;
      if (draft.maxOutputTokens !== null) body.maxOutputTokens = draft.maxOutputTokens;
      // Always send promptAppend (even empty string = clearing it)
      body.promptAppend = draft.promptAppend || null;

      const res = await fetch(`/api/manage/agents/${encodeURIComponent(agentName)}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? `HTTP ${res.status}`);
      }
      setDirty(false);
      setMessage(t('manage_config_saved'));
      onSaved?.();
      setTimeout(() => setMessage(null), 3000);
    } catch (e) {
      setIsError(true);
      setMessage((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label={t('agent_config_temperature')}
          value={draft.temperature}
          onChange={v => update('temperature', v)}
          step={0.1}
          min={0}
          max={2}
        />
        <NumberField
          label={t('agent_config_max_retries')}
          value={draft.maxRetries}
          onChange={v => update('maxRetries', v)}
          step={1}
          min={0}
          max={10}
        />
        <SelectField
          label={t('agent_config_tier')}
          value={draft.tier ?? ''}
          options={['', 'lite', 'standard', 'pro']}
          onChange={v => update('tier', v)}
        />
        <NumberField
          label={t('agent_config_max_output_tokens')}
          value={draft.maxOutputTokens}
          onChange={v => update('maxOutputTokens', v)}
          step={100}
          min={0}
          max={32000}
        />
      </div>
      <TextAreaField
        label={t('agent_config_prompt_append')}
        value={draft.promptAppend ?? ''}
        onChange={v => update('promptAppend', v)}
      />
      <div className="flex items-center gap-2">
        <ClaudeButton
          variant="primary"
          size="sm"
          onClick={save}
          disabled={!dirty || saving}
        >
          {saving ? '…' : t('manage_save')}
        </ClaudeButton>
        {message && (
          <span className={`text-[12px] ${isError ? 'text-claude-err' : 'text-claude-ok'}`}>
            {message}
          </span>
        )}
      </div>
      <div className="text-[11px] text-claude-ink-4 mt-1">
        Changes take effect on the next run. In-flight runs use the previous config.
        <br />
        tier and maxOutputTokens are stored but require a deployment to fully take effect.
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step: number;
  min: number;
  max: number;
}) {
  return (
    <label className="block">
      <span className="text-[10.5px] uppercase tracking-[0.08em] text-claude-ink-4">{label}</span>
      <input
        type="number"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        step={step}
        min={min}
        max={max}
        className="block w-full mt-1 rounded border border-claude-line bg-claude-bg px-2 py-1 text-[12.5px] text-claude-ink-1"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10.5px] uppercase tracking-[0.08em] text-claude-ink-4">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full mt-1 rounded border border-claude-line bg-claude-bg px-2 py-1 text-[12.5px] text-claude-ink-1"
      >
        {options.map(o => (
          <option key={o} value={o}>{o || '—'}</option>
        ))}
      </select>
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10.5px] uppercase tracking-[0.08em] text-claude-ink-4">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className="block w-full mt-1 rounded border border-claude-line bg-claude-bg px-2 py-1 text-[12px] font-mono text-claude-ink-1"
      />
    </label>
  );
}
