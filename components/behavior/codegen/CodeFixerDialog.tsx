"use client";

// CodeFixerDialog — operator-reviewable diff after the LLM proposes a
// patch for the current diagnostics. Renders:
//   - Plain-language explanation (2-5 sentences from the LLM)
//   - Bulleted change summary
//   - Confidence badge
//   - Monaco DiffEditor side-by-side: current code vs patched code
//   - Apply / Discard buttons; Apply replaces the source in the Code tab
//     and triggers a recompile so the operator immediately sees if the
//     fix worked.

import React from "react";
import { useApp } from "@/lib/i18n";
import { DiffViewer } from "./DiffViewer";

export type FixSuggestion = {
  explanation: string;
  patchedCode: string;
  changeSummary: string[];
  confidence: "high" | "medium" | "low";
  modelUsed: string;
  durationMs: number;
};

export function CodeFixerDialog({
  currentCode,
  suggestion,
  running,
  error,
  onApply,
  onClose,
}: {
  currentCode: string;
  suggestion: FixSuggestion | null;
  running: boolean;
  error: string | null;
  onApply: (patched: string) => void;
  onClose: () => void;
}) {
  const { t } = useApp();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="rounded-lg border border-line bg-surface flex flex-col"
        style={{
          width: "min(1200px, 96vw)",
          height: "min(800px, 92vh)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center gap-3 px-5 py-4 border-b border-line">
          <span className="text-[18px]">✨</span>
          <div className="flex-1 min-w-0">
            <div
              className="text-ink-1"
              style={{
                fontFamily:
                  'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif',
                fontWeight: 500,
                fontSize: 20,
                letterSpacing: "-0.01em",
              }}
            >
              {t("fix_title")}
            </div>
            {suggestion && (
              <div className="text-[11px] text-ink-4 mt-1 flex items-center gap-2">
                <span>{suggestion.modelUsed}</span>
                <span>·</span>
                <span>{suggestion.durationMs} ms</span>
                <span>·</span>
                <ConfidenceBadge confidence={suggestion.confidence} />
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md grid place-items-center cursor-pointer border-0 bg-transparent text-ink-3 hover:text-ink-1 hover:bg-panel"
            title="close"
          >
            ×
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 min-h-0 flex flex-col">
          {error ? (
            <ErrorState message={error} />
          ) : running && !suggestion ? (
            <LoadingState />
          ) : !suggestion ? null : (
            <>
              {/* Explanation + summary strip (fixed height) */}
              <div className="px-5 py-3 border-b border-line bg-panel flex flex-col gap-2.5">
                <div>
                  <div className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4 font-medium mb-1">
                    {t("fix_explanation")}
                  </div>
                  <p className="text-[12.5px] text-ink-1 m-0 leading-relaxed">
                    {suggestion.explanation}
                  </p>
                </div>
                {suggestion.changeSummary.length > 0 && (
                  <div>
                    <div className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4 font-medium mb-1">
                      {t("fix_changes")}
                    </div>
                    <ul className="m-0 pl-4 text-[11.5px] text-ink-2 leading-relaxed">
                      {suggestion.changeSummary.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Diff viewer */}
              <div className="flex-1 min-h-0">
                <DiffViewer
                  original={currentCode}
                  modified={suggestion.patchedCode}
                  language="typescript"
                  height="100%"
                />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <footer className="px-5 py-3 border-t border-line flex items-center justify-between gap-2">
          <span className="text-[10.5px] text-ink-4">{t("fix_review_warning")}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="h-8 px-4 rounded-md text-[12px] font-medium border-0 cursor-pointer bg-panel text-ink-2 hover:bg-surface"
            >
              {t("fix_discard")}
            </button>
            <button
              onClick={() => suggestion && onApply(suggestion.patchedCode)}
              disabled={!suggestion || running}
              className="h-8 px-4 rounded-md text-[12px] font-medium border-0 cursor-pointer"
              style={{
                background:
                  !suggestion || running ? "var(--c-panel)" : "var(--c-accent)",
                color: !suggestion || running ? "var(--c-ink-4)" : "white",
              }}
            >
              {t("fix_apply")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────

function LoadingState() {
  const { t } = useApp();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-ink-3">
      <div
        className="w-8 h-8 rounded-full anim-pulse"
        style={{ background: "var(--c-accent)" }}
      />
      <div className="text-[12.5px]">{t("fix_running")}</div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  const { t } = useApp();
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 gap-3 text-center max-w-[520px] mx-auto">
      <div
        className="w-12 h-12 rounded-full grid place-items-center text-[20px]"
        style={{
          background:
            "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 12%, transparent)",
          color: "var(--c-err, oklch(0.5 0.2 25))",
        }}
      >
        ✗
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[14px] font-medium text-ink-1">{t("fix_failed")}</div>
        <div className="text-[12px] text-ink-3 leading-relaxed">{message}</div>
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: "high" | "medium" | "low" }) {
  const { t } = useApp();
  const map: Record<typeof confidence, { color: string; label: string }> = {
    high: { color: "var(--c-ok)", label: t("fix_conf_high") },
    medium: { color: "var(--c-warn, oklch(0.65 0.14 75))", label: t("fix_conf_medium") },
    low: { color: "var(--c-err, oklch(0.5 0.2 25))", label: t("fix_conf_low") },
  };
  const c = map[confidence];
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] mono uppercase tracking-[0.06em]"
      style={{
        background: `color-mix(in oklab, ${c.color} 12%, transparent)`,
        color: c.color,
        border: `1px solid color-mix(in oklab, ${c.color} 30%, transparent)`,
      }}
    >
      {c.label}
    </span>
  );
}
