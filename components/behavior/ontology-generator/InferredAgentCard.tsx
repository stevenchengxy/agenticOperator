"use client";
import React from "react";
import clsx from "clsx";
import { useApp } from "@/lib/i18n";
import type { InferredAgentCandidate } from "@/lib/ontology-generator/types";
import { ConfidenceRing } from "./ConfidenceRing";

// One inferred agent: avatar chip, bilingual name + monospace agent id, the
// event transition (A → B), the 「本体依据」 ontology-gap rationale, a confidence
// ring, and a selection checkbox. Staggered entrance via --og-i.
export function InferredAgentCard({
  candidate,
  index,
  selected,
  onToggle,
}: {
  candidate: InferredAgentCandidate;
  index: number;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t, lang } = useApp();
  const name = lang === "zh" ? candidate.nameZh : candidate.nameEn;
  const desc = lang === "zh" ? candidate.descZh : candidate.descEn;
  const rationale = lang === "zh" ? candidate.rationaleZh : candidate.rationaleEn;

  return (
    <div
      className={clsx(
        "og-card-in rounded-xl border p-4 transition-colors",
        selected
          ? "border-[color:var(--c-accent)] bg-[color:var(--c-accent-bg)]/40"
          : "border-line bg-panel/40 hover:border-line-strong",
      )}
      style={{ ["--og-i" as string]: index }}
    >
      <div className="flex items-start gap-3.5">
        {/* Avatar chip */}
        <div
          className="flex-none w-11 h-11 rounded-lg grid place-items-center text-[17px] font-semibold text-white shadow-sh-1"
          style={{ background: candidate.iconColor }}
        >
          {candidate.iconChar}
        </div>

        {/* Body */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-semibold text-ink-1">{name}</span>
            <span className="mono text-[12px] text-ink-4">{candidate.agentId}</span>
          </div>
          <p className="mt-1 text-[12.5px] text-ink-2 leading-relaxed">{desc}</p>

          {/* Event transition badges */}
          <div className="mt-2.5 flex items-center gap-2 flex-wrap">
            <span className="mono text-[11px] px-2 py-1 rounded bg-surface border border-line text-ink-2">
              {candidate.triggerEvent}
            </span>
            <span className="text-ink-4">→</span>
            <span className="mono text-[11px] px-2 py-1 rounded bg-surface border border-line text-ink-2">
              {candidate.emitEvent}
            </span>
          </div>

          {/* Ontology basis (本体依据) */}
          <div className="mt-3 rounded-lg bg-bg/60 border border-line px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] text-ink-3 font-medium">
              <span className="text-[color:var(--c-accent)]">⌥</span>
              {t("og_rationale_label")}
            </div>
            <p className="mt-1 text-[12px] text-ink-2 leading-relaxed">{rationale}</p>
          </div>
        </div>

        {/* Confidence + checkbox */}
        <div className="flex-none flex flex-col items-center gap-2">
          <ConfidenceRing value={candidate.confidence} />
          <span className="text-[10.5px] text-ink-4">{t("og_confidence")}</span>
          <button
            type="button"
            onClick={onToggle}
            role="checkbox"
            aria-checked={selected}
            aria-label={name}
            className={clsx(
              "w-6 h-6 rounded-md grid place-items-center border transition-colors",
              selected
                ? "bg-[color:var(--c-accent)] border-[color:var(--c-accent)] text-white"
                : "bg-surface border-line text-transparent hover:border-line-strong",
            )}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
