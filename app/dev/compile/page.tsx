"use client";

// Minimal smoke UI for the AO codegen compiler (Phase 0c).
// Paste a TS snippet → POST /api/codegen/compile → render diagnostics.
//
// Intentionally plain (textarea, not Monaco) so the compiler ships before
// Phase 1a brings the full codegen page. /dev/* is the convention for
// internal smoke surfaces — see app/dev/generate-prompt for prior art.

import React from "react";
import type { CompileResult, Diagnostic } from "@/lib/agent-codegen/compiler/types";

const DEFAULT_PATH = "server/inngest/agents/__scratch.ts";
const SAMPLE = `// Edit, then click Compile.
import { AGENT_MAP } from '@/lib/agent-mapping';

export const count = AGENT_MAP.length;
`;

export default function DevCompilePage() {
  const [path, setPath] = React.useState(DEFAULT_PATH);
  const [content, setContent] = React.useState(SAMPLE);
  const [result, setResult] = React.useState<CompileResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);

  const compile = React.useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await fetch("/api/codegen/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: [{ path, content }] }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message || j.error || `HTTP ${r.status}`);
      }
      setResult((await r.json()) as CompileResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [path, content]);

  return (
    <div className="p-6 max-w-[1100px] mx-auto">
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold text-ink-1 m-0">Codegen Compiler · /dev smoke</h1>
        <p className="text-[12px] text-ink-4 mt-1">
          POST <code className="mono">/api/codegen/compile</code> with one virtual file. Diagnostics filtered to the file you submit. <code className="mono">@/</code> aliases resolve against the real project.
        </p>
      </header>

      <div className="grid gap-3" style={{ gridTemplateColumns: "240px 1fr" }}>
        <label className="text-[12px] text-ink-2 flex flex-col gap-1">
          <span>Virtual path</span>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="h-7 px-2 bg-panel border border-line rounded-md text-[12px] mono"
          />
        </label>
        <div className="flex items-end justify-end gap-2">
          <button
            onClick={compile}
            disabled={running}
            className="h-7 px-3 rounded-md text-[12px] font-medium border-0 cursor-pointer"
            style={{ background: "var(--c-accent)", color: "white", opacity: running ? 0.6 : 1 }}
          >
            {running ? "Compiling…" : "Compile"}
          </button>
        </div>
      </div>

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={14}
        spellCheck={false}
        className="mt-3 w-full p-3 bg-panel border border-line rounded-md text-[12px] mono leading-[1.5]"
      />

      <ResultPanel result={result} error={error} />
    </div>
  );
}

function ResultPanel({ result, error }: { result: CompileResult | null; error: string | null }) {
  if (error) {
    return (
      <div className="mt-4 p-3 border border-line rounded-md bg-panel text-[12px]" style={{ color: "var(--c-err, oklch(0.5 0.2 25))" }}>
        Compiler failure: {error}
      </div>
    );
  }
  if (!result) {
    return (
      <div className="mt-4 p-3 border border-line rounded-md bg-panel text-[12px] text-ink-4">
        No result yet.
      </div>
    );
  }

  const okColor = result.ok ? "var(--c-ok)" : "var(--c-err, oklch(0.5 0.2 25))";
  return (
    <div className="mt-4 border border-line rounded-md bg-surface overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-line bg-panel text-[12px]">
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: okColor,
            boxShadow: `0 0 0 3px color-mix(in oklab, ${okColor} 18%, transparent)`,
          }}
        />
        <span className="font-medium text-ink-1">{result.ok ? "OK" : "Errors"}</span>
        <span className="text-ink-4">·</span>
        <span className="text-ink-3 mono">{result.diagnostics.length} diagnostic{result.diagnostics.length === 1 ? "" : "s"}</span>
        <span className="text-ink-4">·</span>
        <span className="text-ink-3 mono">{result.filesCompiled} file</span>
        <span className="text-ink-4">·</span>
        <span className="text-ink-3 mono">{result.durationMs} ms</span>
      </div>
      {result.diagnostics.length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-ink-4">Clean compile — no diagnostics.</div>
      ) : (
        <ul className="m-0 p-0 list-none">
          {result.diagnostics.map((d, i) => (
            <DiagnosticRow key={i} d={d} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DiagnosticRow({ d }: { d: Diagnostic }) {
  const sevColor = d.severity === "error" ? "var(--c-err, oklch(0.5 0.2 25))" : "var(--c-warn, oklch(0.65 0.14 75))";
  return (
    <li className="px-3 py-2 border-b border-line text-[12px] flex flex-col gap-0.5">
      <div className="flex items-center gap-2 mono text-ink-4 text-[11px]">
        <span style={{ color: sevColor }}>{d.severity}</span>
        <span>TS{d.code}</span>
        <span className="px-1.5 py-px rounded bg-panel border border-line text-[10px] uppercase">{d.category}</span>
        <span className="ml-auto text-ink-4">{d.file}:{d.line}:{d.column}</span>
      </div>
      <div className="text-ink-1 whitespace-pre-wrap">{d.message}</div>
    </li>
  );
}
