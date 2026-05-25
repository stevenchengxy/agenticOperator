"use client";

// Codegen page — Phase 1c polish pass.
//
// Layout:
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ Hero header (serif title + subtitle + domain badge)                  │
//   │ Horizontal pipeline stepper                                          │
//   ├─────────────┬───────────────────────────────────────┬───────────────┤
//   │ Left rail   │ Middle (Monaco tabs)                  │ Right rail    │
//   │ Prompt      │ Prompt / Spec / Code / Diff           │ Compiler +    │
//   │ + meta      │                                       │ Save button   │
//   └─────────────┴───────────────────────────────────────┴───────────────┘
//
// What the operator gets end-to-end:
//   1. write a business prompt → click "Generate agent"
//   2. pipeline runs: LLM Call A (spec) → LLM Call B (step bodies) →
//      template render → in-process tsc compile
//   3. Spec / Code / Diff tabs populate; right rail shows diagnostics
//   4. when compile.ok and slug matches AGENT_MAP, "Save as version" persists
//      to AgentVersion (capturedFrom='codegen')
//
// Side flow: Code tab + Compile button still works standalone for hand-edits.

import React from "react";
import { useApp } from "@/lib/i18n";
import { useDomain, getDomain } from "@/lib/domains";
import { byInngestSlug } from "@/lib/agent-mapping";
import { CodeEditor } from "./CodeEditor";
import { CompilerPanel } from "./CompilerPanel";
import { PromptPanel } from "./PromptPanel";
import { PipelineTimeline, type PipelineStage, type StageState } from "./PipelineTimeline";
import { DiffViewer } from "./DiffViewer";
import { SaveAsVersionButton } from "./SaveAsVersionButton";
import type { CompileResult } from "@/lib/agent-codegen/compiler/types";
import type { AgentSpec } from "@/lib/agent-codegen/spec-types";
import type { VersionsListResponse } from "@/lib/agent-versions/types";

type Tab = "prompt" | "spec" | "code" | "diff";

const STARTER_CODE = `// Edit and click Compile, or use the prompt on the left to generate one.
//
// The compiler typechecks this AS IF the file lives at the path shown below,
// resolving @/ aliases against the real AO project.

import { AGENT_MAP } from '@/lib/agent-mapping';

export const _placeholder = AGENT_MAP.length;
`;

const STARTER_PROMPT = `Describe the agent you want to build. Example:

"When a candidate's match score is high enough to need an interview, call
RoboHire to send an AI video interview invitation to their email, then
mirror the communication into the Allmeta Neo4j ontology and emit
INTERVIEW_INVITATION_SENT."
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

const DIFF_EMPTY_LEFT = `// No saved version yet for this agent.
// Generate, compile clean, then click "Save as version" — the next
// generation diffs against what you just saved.
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
  const [pipelineStage, setPipelineStage] = React.useState<PipelineStage | null>(null);
  const [pipelineError, setPipelineError] = React.useState<string | null>(null);
  const [pipelineTimings, setPipelineTimings] = React.useState<
    { totalMs: number; modelUsed: string } | null
  >(null);
  const [parsedSpec, setParsedSpec] = React.useState<AgentSpec | null>(null);
  const [savedActiveCode, setSavedActiveCode] = React.useState<string | null>(null);

  // Try to keep parsedSpec in sync with the Spec tab text, so the save flow
  // can read spec.slug without round-tripping through the pipeline.
  React.useEffect(() => {
    try {
      const j = JSON.parse(spec);
      setParsedSpec(j);
    } catch {
      setParsedSpec(null);
    }
  }, [spec]);

  // When the parsed spec points at a known agent, pre-fetch its saved
  // versions so the Diff tab has a real left side.
  React.useEffect(() => {
    const slug = parsedSpec?.slug;
    if (!slug) return setSavedActiveCode(null);
    const meta = byInngestSlug(slug);
    if (!meta) return setSavedActiveCode(null);
    let cancelled = false;
    fetch(`/api/agents/${encodeURIComponent(meta.short)}/versions`)
      .then((r) => r.json())
      .then((j: VersionsListResponse) => {
        if (cancelled) return;
        // Prefer the active version; fall back to the newest codegen version.
        const latest =
          j.versions.find((v) => v.id === j.activeVersionId) ??
          j.versions[0];
        // Existing version rows only have configJson today; codegen-saved
        // ones have codeBlob via the extended POST. Read it off the raw
        // row — types might lag.
        const code = (latest as unknown as { codeBlob?: string })?.codeBlob;
        setSavedActiveCode(typeof code === "string" ? code : null);
      })
      .catch(() => setSavedActiveCode(null));
    return () => {
      cancelled = true;
    };
  }, [parsedSpec?.slug, pipelineTimings]);

  // Pipeline state derivation ----------------------------------------------
  const pipelineStates: Partial<Record<PipelineStage, StageState>> = React.useMemo(() => {
    const s: Partial<Record<PipelineStage, StageState>> = {};
    if (prompt.trim() && prompt.trim() !== STARTER_PROMPT.trim()) s.prompt = "ok";
    if (parsedSpec && parsedSpec.slug) s.spec = "ok";
    if (parsedSpec) s.render = "ok";
    if (parsedSpec && parsedSpec.steps?.length > 0) s.body = "ok";
    if (compiling) s.compile = "active";
    else if (compileResult) s.compile = compileResult.ok ? "ok" : "err";
    if (compileResult?.ok && parsedSpec) s.review = "ok";
    if (pipelineStage) s[pipelineStage] = "active";
    return s;
  }, [prompt, parsedSpec, pipelineStage, compiling, compileResult]);

  // Actions -----------------------------------------------------------------
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
      {/* Hero header */}
      <header
        className="border-b border-line bg-surface"
        style={{ padding: "28px 32px 20px" }}
      >
        <div className="flex items-start gap-6 mb-6">
          <div className="flex-1 min-w-0">
            <h1
              className="m-0 text-ink-1"
              style={{
                fontFamily:
                  'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif',
                fontWeight: 500,
                fontSize: 30,
                letterSpacing: "-0.02em",
                lineHeight: 1.1,
              }}
            >
              {t("codegen_title")}
            </h1>
            <p className="text-[12.5px] text-ink-3 m-0 mt-2 leading-relaxed max-w-[640px]">
              {t("codegen_hero_blurb")}
            </p>
          </div>
          <DomainBadge color={domainMeta.color} label={domainMeta.label[lang]} />
        </div>

        <PipelineTimeline states={pipelineStates} />
      </header>

      {/* Three-column body */}
      <div className="flex-1 min-h-0 flex">
        {/* Left rail */}
        <aside
          className="border-r border-line bg-surface p-4 flex flex-col gap-4 overflow-auto"
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
              className="px-3 py-2.5 text-[11.5px] rounded-md border"
              style={{
                background: "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 6%, var(--c-panel))",
                borderColor: "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 30%, var(--c-line))",
                color: "var(--c-err, oklch(0.5 0.2 25))",
              }}
            >
              <div className="font-medium text-[10px] uppercase tracking-[0.06em] mb-1">
                {t("codegen_pipeline_error")}
              </div>
              <div className="leading-snug">{pipelineError}</div>
            </div>
          )}

          {pipelineTimings && !pipelineError && (
            <div className="px-3 py-2 rounded-md border border-line bg-panel">
              <div className="text-[10px] uppercase tracking-[0.06em] text-ink-4 mb-1">
                {t("codegen_pipeline_last_run")}
              </div>
              <div className="flex items-center gap-2 text-[11.5px]">
                <span className="text-ink-1 font-medium mono">{pipelineTimings.totalMs} ms</span>
                <span className="text-ink-4">·</span>
                <span className="text-ink-3 mono text-[10.5px]">{pipelineTimings.modelUsed}</span>
              </div>
            </div>
          )}

          {parsedSpec && (
            <div className="px-3 py-2.5 rounded-md border border-line bg-panel flex flex-col gap-1.5">
              <div className="text-[10px] uppercase tracking-[0.06em] text-ink-4">
                {t("codegen_current_spec")}
              </div>
              <div className="text-[12px] font-medium text-ink-1 truncate" title={parsedSpec.displayName}>
                {parsedSpec.displayName || "—"}
              </div>
              <div className="text-[10.5px] text-ink-4 mono truncate" title={parsedSpec.slug}>
                {parsedSpec.slug || "—"}
              </div>
              <div className="text-[10.5px] text-ink-3 mt-1">
                <span className="mono">{parsedSpec.steps?.length ?? 0}</span> steps ·{" "}
                <span className="mono">{parsedSpec.emitEvents?.length ?? 0}</span> emits
              </div>
            </div>
          )}
        </aside>

        {/* Middle — editor tabs */}
        <main className="flex-1 min-w-0 flex flex-col">
          <div
            className="flex items-center border-b border-line bg-surface px-3 gap-1"
            style={{ height: 36 }}
          >
            <TabBtn id="prompt" current={tab} setTab={setTab} label={t("codegen_tab_prompt")} />
            <TabBtn id="spec" current={tab} setTab={setTab} label={t("codegen_tab_spec")} />
            <TabBtn id="code" current={tab} setTab={setTab} label={t("codegen_tab_code")} />
            <TabBtn id="diff" current={tab} setTab={setTab} label={t("codegen_tab_diff")} />
            {tab === "code" && (
              <input
                value={virtualPath}
                onChange={(e) => setVirtualPath(e.target.value)}
                spellCheck={false}
                className="ml-3 h-6 px-2 bg-panel border border-line rounded-md text-[10.5px] mono"
                style={{ minWidth: 360, color: "var(--c-ink-3)" }}
                title={t("codegen_virtual_path_hint")}
              />
            )}
          </div>

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
              <DiffViewer
                original={savedActiveCode ?? DIFF_EMPTY_LEFT}
                modified={code}
                language="typescript"
                height="100%"
              />
            )}
          </div>
        </main>

        {/* Right rail */}
        <CompilerPanel
          result={compileResult}
          running={compiling}
          error={compileError}
          onCompile={runCompile}
          saveButton={
            <SaveAsVersionButton
              slug={parsedSpec?.slug ?? null}
              prompt={prompt}
              spec={spec}
              code={code}
              modelUsed={pipelineTimings?.modelUsed ?? null}
              canSave={!!compileResult?.ok}
            />
          }
        />
      </div>
    </div>
  );
}

function DomainBadge({ color, label }: { color: string; label: string }) {
  const { t } = useApp();
  return (
    <div
      className="flex flex-col items-end px-3 py-2 rounded-lg border border-line bg-panel"
      style={{ minWidth: 160 }}
    >
      <span className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4">
        {t("codegen_scoped_to_domain")}
      </span>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            boxShadow: `0 0 0 3px color-mix(in oklab, ${color} 18%, transparent)`,
          }}
        />
        <span className="text-[12.5px] font-medium text-ink-1">{label}</span>
      </div>
    </div>
  );
}

function TabBtn({
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
      className="h-7 px-3 rounded-md text-[12px] border-0 cursor-pointer transition-colors"
      style={{
        background: active ? "var(--c-accent-bg)" : "transparent",
        color: active ? "var(--c-accent)" : "var(--c-ink-3)",
        fontWeight: active ? 500 : 400,
      }}
    >
      {label}
    </button>
  );
}
