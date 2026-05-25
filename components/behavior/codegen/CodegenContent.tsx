"use client";

// Codegen page — Phase 1a skeleton.
//
// Layout: left rail (prompt + pipeline timeline) · middle (Monaco tabs:
// Prompt / Spec / Code / Diff) · right rail (compiler diagnostics).
//
// Phase 1b wires:
//   - "Generate Spec →" button → POST /api/codegen/generate (full pipeline:
//     LLM Call A spec extractor → LLM Call B step body filler → template
//     render → Phase 0c compile). Populates Spec + Code tabs and the
//     right-rail CompilerPanel with the result.
//   - Code tab + "Compile" button still works standalone for hand-editing.
//
// Spec / pipeline / scope by domain: see lib/domains.tsx — current domain
// gates which event/tool registry the LLM will see (Phase 1b).

import React from "react";
import { useApp } from "@/lib/i18n";
import { useDomain, getDomain } from "@/lib/domains";
import { CodeEditor } from "./CodeEditor";
import { CompilerPanel } from "./CompilerPanel";
import { PromptPanel } from "./PromptPanel";
import { PipelineTimeline, type PipelineStage, type StageState } from "./PipelineTimeline";
import type { CompileResult } from "@/lib/agent-codegen/compiler/types";

type Tab = "prompt" | "spec" | "code" | "diff";

const STARTER_CODE = `// Phase 1a placeholder — paste or edit TypeScript here, then click Compile.
//
// Phase 1b will populate this tab with LLM-generated code from your prompt.
// The compiler typechecks AS IF this file lives at the path shown below,
// resolving @/ aliases against the real project.

import { AGENT_MAP } from '@/lib/agent-mapping';

export const _placeholder = AGENT_MAP.length;
`;

const STARTER_PROMPT = `// Describe the agent you want to build, e.g.
//   "When a candidate signs an offer, send a welcome email via the RMS
//    notification API and write a CommunicationLog entry."
`;

const STARTER_SPEC = `{
  "slug": "",
  "displayName": "",
  "stage": "system",
  "triggerEvent": "",
  "emitEvents": [],
  "steps": []
}
`;

export function CodegenContent() {
  const { t, lang } = useApp();
  const { domain } = useDomain();
  const domainMeta = getDomain(domain);

  // State -------------------------------------------------------------------
  const [tab, setTab] = React.useState<Tab>("code");
  const [prompt, setPrompt] = React.useState(STARTER_PROMPT);
  const [spec, setSpec] = React.useState(STARTER_SPEC);
  const [code, setCode] = React.useState(STARTER_CODE);
  const [virtualPath, setVirtualPath] = React.useState(
    "server/inngest/agents/__scratch.ts",
  );
  const [compileResult, setCompileResult] = React.useState<CompileResult | null>(null);
  const [compileError, setCompileError] = React.useState<string | null>(null);
  const [compiling, setCompiling] = React.useState(false);
  // Phase 1b — full-pipeline progress / errors. Distinct from `compiling`
  // because pipeline drives multiple stages and may take 30-90s.
  const [pipelineStage, setPipelineStage] = React.useState<PipelineStage | null>(null);
  const [pipelineError, setPipelineError] = React.useState<string | null>(null);
  const [pipelineTimings, setPipelineTimings] = React.useState<{ totalMs: number; modelUsed: string } | null>(null);

  // Pipeline stage indicator -----------------------------------------------
  const pipelineStates: Partial<Record<PipelineStage, StageState>> = React.useMemo(() => {
    const s: Partial<Record<PipelineStage, StageState>> = {};
    if (prompt.trim()) s.prompt = "ok";
    if (spec.trim() && spec.trim() !== STARTER_SPEC.trim()) s.spec = "ok";
    if (pipelineStage) s[pipelineStage] = "active";
    if (compiling) s.compile = "active";
    else if (compileResult) s.compile = compileResult.ok ? "ok" : "err";
    if (compileResult?.ok && !pipelineStage) s.review = "ok";
    return s;
  }, [prompt, spec, pipelineStage, compiling, compileResult]);

  // Actions -----------------------------------------------------------------
  // Phase 1b — full pipeline: prompt → spec → step bodies → render → compile.
  // On success, populates Spec + Code tabs and the right-rail compiler panel.
  const runPipeline = React.useCallback(async () => {
    setPipelineError(null);
    setPipelineTimings(null);
    setCompileError(null);
    setCompileResult(null);
    setPipelineStage("spec");
    try {
      const r = await fetch("/api/codegen/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, domain }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      }
      const result = await r.json();
      // Populate downstream surfaces. UI now reflects the generated artifacts;
      // operator can still edit the code tab and re-compile manually.
      setSpec(JSON.stringify(result.spec, null, 2));
      setCode(result.code.content);
      setVirtualPath(result.code.path);
      setCompileResult(result.compile);
      setPipelineTimings({ totalMs: result.timings.totalMs, modelUsed: result.modelUsed });
      setTab("code");
    } catch (e) {
      setPipelineError(e instanceof Error ? e.message : String(e));
    } finally {
      setPipelineStage(null);
    }
  }, [prompt, domain]);

  const runCompile = React.useCallback(async () => {
    setCompiling(true);
    setCompileError(null);
    try {
      const r = await fetch("/api/codegen/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          files: [{ path: virtualPath, content: code }],
          domain,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      }
      setCompileResult((await r.json()) as CompileResult);
    } catch (e) {
      setCompileError(e instanceof Error ? e.message : String(e));
      setCompileResult(null);
    } finally {
      setCompiling(false);
    }
  }, [code, virtualPath, domain]);

  // Render ------------------------------------------------------------------
  return (
    <div className="flex flex-col h-full min-h-0 bg-bg">
      {/* Header */}
      <header className="px-6 py-4 border-b border-line flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <h1
            className="m-0 text-ink-1"
            style={{
              fontFamily: 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif',
              fontWeight: 500,
              fontSize: 22,
              letterSpacing: "-0.01em",
            }}
          >
            {t("codegen_title")}
          </h1>
          <p className="text-[11.5px] tracking-[0.04em] text-ink-4 m-0 mt-1">
            {t("codegen_subtitle")}
          </p>
        </div>
        <span
          className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[11px] bg-panel border border-line text-ink-2"
          title={t("codegen_scoped_to_domain")}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: domainMeta.color,
            }}
          />
          {t("codegen_scoped_to_domain")}: <span className="font-medium text-ink-1">{domainMeta.label[lang]}</span>
        </span>
      </header>

      {/* Body — three columns */}
      <div className="flex-1 min-h-0 flex">
        {/* Left rail */}
        <aside
          className="border-r border-line bg-surface p-3 flex flex-col gap-5 overflow-auto"
          style={{ width: 280, minWidth: 280 }}
        >
          <PromptPanel
            value={prompt}
            onChange={setPrompt}
            onGenerateSpec={runPipeline}
            disabled={pipelineStage !== null}
          />
          {pipelineError && (
            <div
              className="px-2 py-1.5 text-[11px] rounded-md border border-line bg-panel leading-snug"
              style={{ color: "var(--c-err, oklch(0.5 0.2 25))" }}
            >
              {t("codegen_pipeline_error")}: {pipelineError}
            </div>
          )}
          {pipelineTimings && (
            <div className="px-2 py-1.5 text-[11px] text-ink-4 rounded-md border border-line bg-panel mono">
              ✓ {pipelineTimings.totalMs} ms · {pipelineTimings.modelUsed}
            </div>
          )}
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] text-ink-4 mb-2">
              {t("codegen_pipeline_title")}
            </div>
            <PipelineTimeline states={pipelineStates} />
          </div>
        </aside>

        {/* Middle — editor tabs */}
        <main className="flex-1 min-w-0 flex flex-col">
          {/* Tab strip */}
          <div className="flex items-center border-b border-line bg-surface px-2 gap-1 h-[34px]">
            <Tab id="prompt" current={tab} setTab={setTab} label={t("codegen_tab_prompt")} />
            <Tab id="spec" current={tab} setTab={setTab} label={t("codegen_tab_spec")} />
            <Tab id="code" current={tab} setTab={setTab} label={t("codegen_tab_code")} />
            <Tab id="diff" current={tab} setTab={setTab} label={t("codegen_tab_diff")} />
            {tab === "code" && (
              <input
                value={virtualPath}
                onChange={(e) => setVirtualPath(e.target.value)}
                spellCheck={false}
                className="ml-3 h-6 px-2 bg-panel border border-line rounded-md text-[11px] mono"
                style={{ minWidth: 360 }}
                title={t("codegen_virtual_path_hint")}
              />
            )}
          </div>

          {/* Tab body */}
          <div className="flex-1 min-h-0">
            {tab === "prompt" && (
              <CodeEditor
                value={prompt}
                onChange={setPrompt}
                language="markdown"
                path="prompt.md"
                height="100%"
              />
            )}
            {tab === "spec" && (
              <CodeEditor
                value={spec}
                onChange={setSpec}
                language="json"
                path="spec.json"
                height="100%"
              />
            )}
            {tab === "code" && (
              <CodeEditor
                value={code}
                onChange={setCode}
                language="typescript"
                path={virtualPath}
                height="100%"
              />
            )}
            {tab === "diff" && (
              <div className="p-6 text-[12px] text-ink-4">
                {t("codegen_diff_placeholder")}
              </div>
            )}
          </div>
        </main>

        {/* Right rail */}
        <CompilerPanel
          result={compileResult}
          running={compiling}
          error={compileError}
          onCompile={runCompile}
        />
      </div>
    </div>
  );
}

function Tab({
  id,
  current,
  setTab,
  label,
}: {
  id: Tab;
  current: Tab;
  setTab: (t: Tab) => void;
  label: string;
}) {
  const active = id === current;
  return (
    <button
      onClick={() => setTab(id)}
      className="h-7 px-3 rounded-md text-[12px] border-0 cursor-pointer"
      style={{
        background: active ? "var(--c-accent-bg)" : "transparent",
        color: active ? "var(--c-accent)" : "var(--c-ink-2)",
        fontWeight: active ? 500 : 400,
      }}
    >
      {label}
    </button>
  );
}
