"use client";

// Right-rail compiler diagnostics panel. Reused by Phase 1a (manual compile
// from the code tab) and Phase 1b (pipeline auto-compile after LLM body fill).

import React from "react";
import type { CompileResult, Diagnostic } from "@/lib/agent-codegen/compiler/types";
import { useApp } from "@/lib/i18n";

export function CompilerPanel({
  result,
  running,
  error,
  onCompile,
  onJumpToLine,
}: {
  result: CompileResult | null;
  running: boolean;
  error: string | null;
  onCompile: () => void;
  /** When supplied, diagnostic rows become click-to-jump (passes 1-indexed line). */
  onJumpToLine?: (file: string, line: number, column: number) => void;
}) {
  const { t } = useApp();
  const okColor = result?.ok ? "var(--c-ok)" : "var(--c-err, oklch(0.5 0.2 25))";

  return (
    <aside
      className="border-l border-line bg-surface flex flex-col"
      style={{ width: 320, minWidth: 320 }}
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <span className="text-[11px] uppercase tracking-[0.06em] text-ink-4">
          {t("codegen_compiler_title")}
        </span>
        <button
          onClick={onCompile}
          disabled={running}
          className="ml-auto h-6 px-2.5 rounded-md text-[11px] font-medium border-0 cursor-pointer"
          style={{
            background: "var(--c-accent)",
            color: "white",
            opacity: running ? 0.6 : 1,
          }}
        >
          {running ? t("codegen_compiling") : t("codegen_compile")}
        </button>
      </header>

      {error ? (
        <div className="px-3 py-3 text-[12px]" style={{ color: "var(--c-err, oklch(0.5 0.2 25))" }}>
          {t("codegen_compiler_failure")}: {error}
        </div>
      ) : !result ? (
        <div className="px-3 py-3 text-[12px] text-ink-4">{t("codegen_compiler_empty")}</div>
      ) : (
        <>
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-panel text-[11px]">
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: okColor,
                boxShadow: `0 0 0 3px color-mix(in oklab, ${okColor} 18%, transparent)`,
              }}
            />
            <span className="font-medium text-ink-1">
              {result.ok ? t("codegen_compile_ok") : t("codegen_compile_err")}
            </span>
            <span className="text-ink-4">·</span>
            <span className="mono text-ink-3">{result.diagnostics.length}</span>
            <span className="text-ink-4">·</span>
            <span className="mono text-ink-3">{result.durationMs} ms</span>
          </div>
          {result.diagnostics.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-ink-4">
              {t("codegen_no_diagnostics")}
            </div>
          ) : (
            <ul className="m-0 p-0 list-none overflow-auto flex-1">
              {result.diagnostics.map((d, i) => (
                <DiagnosticRow key={i} d={d} onJump={onJumpToLine} />
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

function DiagnosticRow({
  d,
  onJump,
}: {
  d: Diagnostic;
  onJump?: (file: string, line: number, column: number) => void;
}) {
  const sevColor =
    d.severity === "error"
      ? "var(--c-err, oklch(0.5 0.2 25))"
      : "var(--c-warn, oklch(0.65 0.14 75))";

  const clickable = !!onJump;
  return (
    <li
      className={
        "px-3 py-2 border-b border-line text-[12px] flex flex-col gap-0.5 " +
        (clickable ? "cursor-pointer hover:bg-panel" : "")
      }
      onClick={clickable ? () => onJump!(d.file, d.line, d.column) : undefined}
    >
      <div className="flex items-center gap-2 mono text-ink-4 text-[10.5px]">
        <span style={{ color: sevColor }}>{d.severity}</span>
        <span>TS{d.code}</span>
        <span className="px-1.5 py-px rounded bg-panel border border-line text-[9.5px] uppercase">
          {d.category}
        </span>
        <span className="ml-auto text-ink-4">{d.line}:{d.column}</span>
      </div>
      <div className="text-ink-1 whitespace-pre-wrap leading-snug">{d.message}</div>
    </li>
  );
}
