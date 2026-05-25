"use client";

// Left-column prompt input. Phase 1a: just collects text. Phase 1b: clicking
// "Generate Spec" calls /api/codegen/generate (LLM Call A → AgentSpec JSON).

import React from "react";
import { useApp } from "@/lib/i18n";

export function PromptPanel({
  value,
  onChange,
  onGenerateSpec,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onGenerateSpec: () => void;
  disabled?: boolean;
}) {
  const { t } = useApp();
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[11px] uppercase tracking-[0.06em] text-ink-4">
        {t("codegen_prompt_label")}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        spellCheck={false}
        placeholder={t("codegen_prompt_placeholder")}
        className="w-full p-2 bg-panel border border-line rounded-md text-[12px] leading-[1.55] resize-vertical"
      />
      <button
        onClick={onGenerateSpec}
        disabled={disabled || !value.trim()}
        className="h-7 px-3 rounded-md text-[12px] font-medium border-0 cursor-pointer self-start"
        style={{
          background: "var(--c-accent)",
          color: "white",
          opacity: disabled || !value.trim() ? 0.5 : 1,
        }}
        title={disabled ? t("codegen_disabled_phase1a") : undefined}
      >
        {t("codegen_generate_spec")}
      </button>
      {disabled && (
        <p className="text-[10.5px] text-ink-4 m-0 leading-snug">
          {t("codegen_disabled_phase1a")}
        </p>
      )}
    </div>
  );
}
