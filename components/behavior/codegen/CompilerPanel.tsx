"use client";

// Right-rail compiler diagnostics panel. Reused by the Code tab manual
// compile flow and by the Phase 1b pipeline auto-compile.
//
// When a successful compile + an AgentSpec are both present, the panel
// surfaces "Save as version" — captures the (prompt, spec, code, modelUsed)
// tuple into AgentVersion via /api/agents/[short]/versions.

import React from "react";
import type { CompileResult, Diagnostic } from "@/lib/agent-codegen/compiler/types";
import { useApp } from "@/lib/i18n";

export function CompilerPanel({
  result,
  running,
  error,
  onCompile,
  onSuggestFix,
  saveButton,
}: {
  result: CompileResult | null;
  running: boolean;
  error: string | null;
  onCompile: () => void;
  /** Optional: when provided AND there are error diagnostics, surfaces a
   *  "✨ Suggest fix" button. Click opens the CodeFixerDialog. */
  onSuggestFix?: () => void;
  /** Optional save affordance rendered at the bottom when relevant. */
  saveButton?: React.ReactNode;
}) {
  const { t } = useApp();
  const okColor = result?.ok ? "var(--c-ok)" : "var(--c-err, oklch(0.5 0.2 25))";

  // Group diagnostics by category for compact display
  const grouped = React.useMemo(() => {
    if (!result) return null;
    const buckets: Record<string, Diagnostic[]> = {};
    for (const d of result.diagnostics) {
      const key = d.category;
      (buckets[key] ||= []).push(d);
    }
    return buckets;
  }, [result]);

  return (
    <aside
      className="border-l border-line bg-surface flex flex-col"
      style={{ width: 340, minWidth: 340 }}
    >
      <header className="flex items-center gap-2 px-4 py-3 border-b border-line">
        <div className="flex flex-col min-w-0">
          <span className="text-[10.5px] uppercase tracking-[0.08em] text-ink-4">
            {t("codegen_compiler_section")}
          </span>
          <span className="text-[13px] font-medium text-ink-1 leading-tight mt-px">
            {t("codegen_compiler_title")}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {onSuggestFix && result && !result.ok && result.diagnostics.some((d) => d.severity === "error") && (
            <button
              onClick={onSuggestFix}
              disabled={running}
              className="h-7 px-2.5 rounded-md text-[11px] font-medium border cursor-pointer inline-flex items-center gap-1"
              style={{
                background: "transparent",
                color: "var(--c-accent)",
                borderColor: "color-mix(in oklab, var(--c-accent) 35%, var(--c-line))",
              }}
              title={t("codegen_suggest_fix_tooltip")}
            >
              ✨ {t("codegen_suggest_fix")}
            </button>
          )}
          <button
            onClick={onCompile}
            disabled={running}
            className="h-7 px-3 rounded-md text-[11.5px] font-medium border-0 cursor-pointer"
            style={{
              background: running ? "var(--c-panel)" : "var(--c-accent)",
              color: running ? "var(--c-ink-3)" : "white",
              opacity: running ? 0.8 : 1,
            }}
          >
            {running ? t("codegen_compiling") : t("codegen_compile")}
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {error ? (
          <div
            className="m-3 px-3 py-2.5 text-[12px] rounded-md border"
            style={{
              borderColor: "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 30%, var(--c-line))",
              background: "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 6%, var(--c-panel))",
              color: "var(--c-err, oklch(0.5 0.2 25))",
            }}
          >
            <div className="font-medium text-[11px] uppercase tracking-[0.06em] mb-1">
              {t("codegen_compiler_failure")}
            </div>
            <div className="leading-snug">{error}</div>
          </div>
        ) : !result ? (
          <EmptyState />
        ) : (
          <>
            <div
              className="flex items-center gap-2 px-4 py-2.5 border-b border-line text-[11.5px]"
              style={{ background: "var(--c-panel)" }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: okColor,
                  boxShadow: `0 0 0 4px color-mix(in oklab, ${okColor} 18%, transparent)`,
                }}
              />
              <span className="font-semibold text-ink-1">
                {result.ok ? t("codegen_compile_ok") : t("codegen_compile_err")}
              </span>
              <span className="text-ink-4">·</span>
              <span className="mono text-ink-3">
                {result.diagnostics.length} {t("codegen_compile_diag")}
              </span>
              <span className="ml-auto mono text-ink-4 text-[10.5px]">{result.durationMs} ms</span>
            </div>

            {result.diagnostics.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <div className="text-[12.5px] text-ink-2 mb-1">✓</div>
                <div className="text-[11.5px] text-ink-4 leading-snug">
                  {t("codegen_no_diagnostics")}
                </div>
              </div>
            ) : (
              <div className="overflow-auto flex-1">
                {grouped &&
                  Object.entries(grouped).map(([cat, ds]) => (
                    <DiagnosticGroup key={cat} category={cat} items={ds} />
                  ))}
              </div>
            )}
          </>
        )}
      </div>

      {saveButton && (
        <footer className="border-t border-line p-3 bg-surface">{saveButton}</footer>
      )}
    </aside>
  );
}

function EmptyState() {
  const { t } = useApp();
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 text-center gap-3">
      <div
        className="w-10 h-10 rounded-full grid place-items-center"
        style={{
          background: "var(--c-panel)",
          color: "var(--c-ink-4)",
          fontSize: 18,
        }}
      >
        ⌥
      </div>
      <div className="text-[11.5px] text-ink-4 leading-snug max-w-[240px]">
        {t("codegen_compiler_empty")}
      </div>
    </div>
  );
}

function DiagnosticGroup({ category, items }: { category: string; items: Diagnostic[] }) {
  const { t } = useApp();
  return (
    <div>
      <div
        className="px-4 py-1.5 text-[10px] uppercase tracking-[0.08em] text-ink-4 sticky top-0 z-10"
        style={{ background: "var(--c-surface)" }}
      >
        {t(`codegen_diag_cat_${category}`)} · {items.length}
      </div>
      {items.map((d, i) => (
        <DiagnosticRow key={`${category}-${i}`} d={d} />
      ))}
    </div>
  );
}

function DiagnosticRow({ d }: { d: Diagnostic }) {
  const sevColor =
    d.severity === "error"
      ? "var(--c-err, oklch(0.5 0.2 25))"
      : "var(--c-warn, oklch(0.65 0.14 75))";
  return (
    <div className="px-4 py-2 border-b border-line text-[12px] flex flex-col gap-1">
      <div className="flex items-center gap-2 mono text-[10px] text-ink-4">
        <span
          style={{
            color: sevColor,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {d.severity}
        </span>
        <span>TS{d.code}</span>
        <span className="ml-auto">L{d.line}:{d.column}</span>
      </div>
      <div className="text-ink-1 whitespace-pre-wrap leading-snug">{d.message}</div>
    </div>
  );
}
