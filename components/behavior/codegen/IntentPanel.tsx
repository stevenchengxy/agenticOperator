"use client";

// IntentPanel — Stage-0 input surface for PromptGen.
//
// Operator types a one-line intent, optionally locks fields (trigger event,
// stage, emitEvents) that PromptGen will treat as hard constraints, and
// optionally picks a blueprint agent to imitate. [Generate Prompt] fires
// the /api/codegen/prompt-gen call (managed by the parent CodegenContent).

import React from "react";
import { useApp } from "@/lib/i18n";
import type { AgentFormFields } from "@/lib/agent-codegen/spec-types";

const STAGES = [
  "system", "requirement", "jd", "resume", "match",
  "interview", "eval", "package", "submit",
] as const;

type Props = {
  intent: string;
  onIntentChange: (v: string) => void;
  locked: Partial<AgentFormFields>;
  onLockedChange: (l: Partial<AgentFormFields>) => void;
  eventNames: string[];
  blueprintSlugs: string[];
  onGenerate: () => void;
  loading: boolean;
};

export function IntentPanel({
  intent,
  onIntentChange,
  locked,
  onLockedChange,
  eventNames,
  blueprintSlugs,
  onGenerate,
  loading,
}: Props) {
  const { t } = useApp();

  // Local "lock" checkbox state
  const [lockTrigger, setLockTrigger] = React.useState(false);
  const [lockStage, setLockStage] = React.useState(false);
  const [lockEmits, setLockEmits] = React.useState(false);

  function toggleLock(field: "triggerEvent" | "stage" | "emitEvents", enabled: boolean) {
    if (!enabled) {
      const next = { ...locked };
      delete next[field];
      onLockedChange(next);
    }
    if (field === "triggerEvent") setLockTrigger(enabled);
    if (field === "stage") setLockStage(enabled);
    if (field === "emitEvents") setLockEmits(enabled);
  }

  const canGenerate = intent.trim().length >= 4 && !loading;

  return (
    <div className="flex flex-col gap-3">
      {/* Section header */}
      <div
        className="text-[10px] uppercase tracking-[0.08em] text-ink-4 font-medium"
      >
        Stage 0 — PromptGen
      </div>

      {/* Intent textarea */}
      <div className="flex flex-col gap-1">
        <label className="text-[11px] uppercase tracking-[0.06em] text-ink-4">
          {t("pg_intent_label")}
        </label>
        <textarea
          value={intent}
          onChange={(e) => onIntentChange(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={t("pg_intent_placeholder")}
          disabled={loading}
          className="w-full p-2 bg-panel border border-line rounded-md text-[12px] leading-[1.55] resize-vertical"
          style={{ color: "var(--c-ink-1)" }}
        />
      </div>

      {/* Locked fields */}
      <div
        className="flex flex-col gap-2 px-3 py-2.5 rounded-md border border-line bg-panel"
      >
        <div className="text-[10px] uppercase tracking-[0.06em] text-ink-4 mb-0.5">
          {t("pg_locked_hint")}
        </div>

        {/* Trigger event lock */}
        <LockRow
          label={t("pg_confirm_trigger")}
          checked={lockTrigger}
          onToggle={(v) => toggleLock("triggerEvent", v)}
        >
          {lockTrigger && (
            <select
              value={locked.triggerEvent ?? ""}
              onChange={(e) =>
                onLockedChange({ ...locked, triggerEvent: e.target.value || undefined })
              }
              className="mt-1 w-full px-2 py-1 bg-panel border border-line rounded text-[11.5px]"
              style={{ color: "var(--c-ink-1)" }}
            >
              <option value="">— pick event —</option>
              {eventNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </LockRow>

        {/* Stage lock */}
        <LockRow
          label="Stage"
          checked={lockStage}
          onToggle={(v) => toggleLock("stage", v)}
        >
          {lockStage && (
            <select
              value={locked.stage ?? ""}
              onChange={(e) =>
                onLockedChange({
                  ...locked,
                  stage: (e.target.value as typeof STAGES[number]) || undefined,
                })
              }
              className="mt-1 w-full px-2 py-1 bg-panel border border-line rounded text-[11.5px]"
              style={{ color: "var(--c-ink-1)" }}
            >
              <option value="">— pick stage —</option>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </LockRow>

        {/* Emit events lock */}
        <LockRow
          label="Emit events"
          checked={lockEmits}
          onToggle={(v) => toggleLock("emitEvents", v)}
        >
          {lockEmits && (
            <EmitMultiSelect
              eventNames={eventNames}
              value={locked.emitEvents ?? []}
              onChange={(next) => onLockedChange({ ...locked, emitEvents: next })}
            />
          )}
        </LockRow>
      </div>

      {/* Blueprint */}
      {blueprintSlugs.length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="text-[11px] uppercase tracking-[0.06em] text-ink-4">
            {t("pg_blueprint_label")}
          </label>
          <select
            value={locked.slug ?? ""}
            onChange={(e) =>
              onLockedChange({ ...locked, slug: e.target.value || undefined })
            }
            className="w-full px-2 py-1 bg-panel border border-line rounded text-[11.5px]"
            style={{ color: "var(--c-ink-1)" }}
          >
            <option value="">— none —</option>
            {blueprintSlugs.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Generate button */}
      <button
        onClick={onGenerate}
        disabled={!canGenerate}
        className="h-8 px-4 rounded-md text-[12.5px] font-medium border-0 cursor-pointer self-start"
        style={{
          background: "var(--c-accent)",
          color: "white",
          opacity: canGenerate ? 1 : 0.45,
        }}
      >
        {loading ? t("pg_generating") : t("pg_generate")}
      </button>
    </div>
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────

function LockRow({
  label,
  checked,
  onToggle,
  children,
}: {
  label: string;
  checked: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          className="accent-accent"
        />
        <span className="text-[11.5px] text-ink-3">{label}</span>
      </label>
      {children}
    </div>
  );
}

function EmitMultiSelect({
  eventNames,
  value,
  onChange,
}: {
  eventNames: string[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(name: string) {
    if (value.includes(name)) {
      onChange(value.filter((n) => n !== name));
    } else {
      onChange([...value, name]);
    }
  }
  return (
    <div
      className="mt-1 flex flex-col gap-1 max-h-32 overflow-y-auto px-1"
    >
      {eventNames.map((n) => (
        <label key={n} className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={value.includes(n)}
            onChange={() => toggle(n)}
            className="accent-accent"
          />
          <span className="text-[11px] text-ink-2 mono">{n}</span>
        </label>
      ))}
    </div>
  );
}
