"use client";
import React from "react";
import { useApp } from "@/lib/i18n";

// Idle hero (step 1, right panel): centered node-graph icon + title + blurb +
// the primary "推断智能体" call to action.
export function InferIntro({ onInfer }: { onInfer: () => void }) {
  const { t } = useApp();
  return (
    <div className="rounded-2xl border border-line bg-bg/40 grid place-items-center text-center px-8 py-16" style={{ minHeight: 520 }}>
      <div className="max-w-[440px]">
        <div
          className="mx-auto w-[88px] h-[88px] rounded-[22px] grid place-items-center text-white"
          style={{
            background: "linear-gradient(150deg, oklch(0.7 0.13 280), var(--c-accent))",
            boxShadow: "0 8px 30px color-mix(in oklab, var(--c-accent) 40%, transparent)",
          }}
        >
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="2.4" />
            <circle cx="18" cy="9" r="2.4" />
            <circle cx="9" cy="18" r="2.4" />
            <path d="M8 7l8 1.4M7.5 16l1-7.4M11 17l6-6.6" />
          </svg>
        </div>

        <h2 className="mt-6 text-[19px] font-semibold text-ink-1">{t("og_intro_title")}</h2>
        <p className="mt-2.5 text-[13px] text-ink-3 leading-relaxed">{t("og_intro_blurb")}</p>

        <button
          type="button"
          onClick={onInfer}
          className="mt-7 inline-flex items-center gap-2 h-10 px-5 rounded-lg text-[13.5px] font-semibold text-white transition-opacity hover:opacity-90"
          style={{
            background: "var(--c-accent)",
            boxShadow: "0 6px 22px color-mix(in oklab, var(--c-accent) 45%, transparent)",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
            <circle cx="12" cy="12" r="3.2" />
          </svg>
          {t("og_infer_cta")}
        </button>
      </div>
    </div>
  );
}
