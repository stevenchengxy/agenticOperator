"use client";

// Library Codegen page — Phase 2 MVP (curl-examples mode only).
//
// Same form-first principle as the agent codegen page:
//   - left rail: LibraryFormFields (name / baseUrl / auth / env vars) +
//     CurlExamplesInput list (operator pastes/types one entry per endpoint)
//   - middle: Monaco tabs (Code generated client.ts · Registry suggested
//     TOOL_REGISTRY entries)
//   - right: Compiler diagnostics for the generated client.ts
//
// Save path is "manual paste for now": after a successful compile, operator
// copies the rendered client.ts into `lib/generated/<name>/client.ts` and
// pastes the suggested registry entries into tool-registry.raas.ts. Phase 2.5
// will automate both (research doc §B.6).

import React from "react";
import { useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { CodeEditor } from "../CodeEditor";
import { CompilerPanel } from "../CompilerPanel";
import { CurlExamplesInput } from "./CurlExamplesInput";
import type { CompileResult } from "@/lib/agent-codegen/compiler/types";
import type {
  CurlExample,
  LibraryFormFields,
  LibraryGenerationOutput,
} from "@/lib/agent-codegen/library/lib-spec-types";

type Tab = "code" | "registry" | "spec";

const EMPTY_FORM: LibraryFormFields = {
  name: "",
  description: "",
  baseUrl: "",
  authStyle: "bearer",
  envVarsRequired: ["BASE_URL", "API_KEY"],
};

const STARTER_CODE = `// Fill the form on the left + paste a few endpoint examples,
// then click "Generate library →" to produce lib/generated/<name>/client.ts.
`;

export function LibraryCodegenContent() {
  return (
    <React.Suspense fallback={null}>
      <LibraryCodegenInner />
    </React.Suspense>
  );
}

function LibraryCodegenInner() {
  const { t } = useApp();
  const searchParams = useSearchParams();
  const fromPromptGen = searchParams?.get("from") === "promptgen";
  const needParam = searchParams?.get("need") ?? null;
  const needDecoded = needParam ? decodeURIComponent(needParam) : null;

  const [form, setForm] = React.useState<LibraryFormFields>(EMPTY_FORM);
  const [examples, setExamples] = React.useState<CurlExample[]>([]);
  const [code, setCode] = React.useState(STARTER_CODE);
  const [registrySuggestion, setRegistrySuggestion] = React.useState<
    Array<{ id: string; importFrom: string; importName: string; signature: string; summary: string }>
  >([]);
  const [output, setOutput] = React.useState<LibraryGenerationOutput | null>(null);
  const [tab, setTab] = React.useState<Tab>("code");
  const [compileResult, setCompileResult] = React.useState<CompileResult | null>(null);
  const [compileError, setCompileError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [pipelineError, setPipelineError] = React.useState<string | null>(null);
  const [timings, setTimings] = React.useState<{ totalMs: number; modelUsed: string } | null>(null);

  // Pre-seed form when arriving from PromptGen tool-gap link
  React.useEffect(() => {
    if (!fromPromptGen || !needDecoded) return;
    // Only pre-seed if form is still in its initial empty state
    setForm((current) => {
      const isEmpty = current.name === "" && current.description === "";
      if (!isEmpty) return current;
      const firstToken = needDecoded.split(",")[0].trim();
      // Slugify the first token: lowercase, replace non-alnum with -, trim hyphens
      const slug = firstToken
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      // Convert slug to camelCase for the name field
      const camelName = slug.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      return {
        ...current,
        name: camelName || slug,
        description: `供 PromptGen 使用的工具：${needDecoded}`,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needParam]);

  const canGenerate =
    form.name.length >= 2 &&
    form.baseUrl.length > 0 &&
    examples.length > 0 &&
    examples.every((e) => e.description.length >= 4 && e.httpPath.length > 0) &&
    !busy;

  const runPipeline = React.useCallback(async () => {
    setBusy(true);
    setPipelineError(null);
    setCompileError(null);
    setCompileResult(null);
    try {
      const r = await fetch("/api/codegen/library/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ form, examples }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      }
      const result = await r.json();
      setCode(result.code.content);
      setOutput(result.output);
      setRegistrySuggestion(result.registrySuggestion);
      setCompileResult(result.compile);
      setTimings({ totalMs: result.timings.totalMs, modelUsed: result.modelUsed });
      setTab("code");
    } catch (e) {
      setPipelineError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [form, examples]);

  const runCompile = React.useCallback(async () => {
    setBusy(true);
    setCompileError(null);
    try {
      const r = await fetch("/api/codegen/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          files: [{ path: `lib/generated/${form.name || "scratch"}/client.ts`, content: code }],
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      }
      setCompileResult((await r.json()) as CompileResult);
    } catch (e) {
      setCompileError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [code, form.name]);

  const registryText = React.useMemo(
    () =>
      registrySuggestion.length === 0
        ? "// Run generate first — suggested TOOL_REGISTRY entries appear here."
        : registrySuggestion
            .map(
              (r) =>
                `  {
    id: '${r.id}',
    importFrom: '${r.importFrom}',
    importName: '${r.importName}',
    signature: '${r.signature.replace(/'/g, "\\'")}',
    summary: '${r.summary.replace(/'/g, "\\'")}',
    sideEffects: 'external HTTP',
    category: 'partner-pg', // ← adjust to match the actual category
  },`,
            )
            .join("\n"),
    [registrySuggestion],
  );

  const specText = React.useMemo(
    () => (output ? JSON.stringify(output, null, 2) : "// Output appears here after generate."),
    [output],
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg">
      {/* Hero */}
      <header className="border-b border-line bg-surface" style={{ padding: "28px 32px 20px" }}>
        <div className="flex items-start gap-6">
          <div className="flex-1 min-w-0">
            <h1
              className="m-0 text-ink-1"
              style={{
                fontFamily: 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif',
                fontWeight: 500,
                fontSize: 30,
                letterSpacing: "-0.02em",
                lineHeight: 1.1,
              }}
            >
              {t("lib_title")}
            </h1>
            <p className="text-[12.5px] text-ink-3 m-0 mt-2 leading-relaxed max-w-[720px]">
              {t("lib_blurb")}
            </p>
          </div>
        </div>
      </header>

      {/* Three-column body */}
      <div className="flex-1 min-h-0 flex">
        {/* Left rail — form + examples */}
        <aside
          className="border-r border-line bg-surface p-4 flex flex-col gap-4 overflow-auto"
          style={{ width: 360, minWidth: 360 }}
        >
          {/* PromptGen loop banner */}
          {fromPromptGen && needDecoded && (
            <div className="px-3 py-2.5 rounded-md border border-line bg-accent-bg text-[11.5px]">
              <div className="font-semibold text-ink-2 mb-1">{t("lib_loop_banner")}</div>
              <div className="text-[11px] text-ink-3">
                <span className="font-medium text-ink-3">{t("lib_loop_need")}:</span>{" "}
                <span className="mono">{needDecoded}</span>
              </div>
            </div>
          )}
          <Section title={t("lib_section_identity")}>
            <Field label={t("lib_form_name")}>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="rms-client"
                spellCheck={false}
                className={inputClass}
                style={{ fontFamily: "ui-monospace, monospace" }}
              />
            </Field>
            <Field label={t("lib_form_description")}>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Thin wrapper around RMS REST API"
                className={inputClass}
              />
            </Field>
            <Field label={t("lib_form_base_url")}>
              <input
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                placeholder="https://rms.acme.com"
                spellCheck={false}
                className={inputClass}
                style={{ fontFamily: "ui-monospace, monospace" }}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("lib_form_auth_style")}>
                <select
                  value={form.authStyle}
                  onChange={(e) =>
                    setForm({ ...form, authStyle: e.target.value as LibraryFormFields["authStyle"] })
                  }
                  className={inputClass}
                >
                  <option value="bearer">bearer</option>
                  <option value="api-key">api-key</option>
                  <option value="basic">basic</option>
                  <option value="none">none</option>
                </select>
              </Field>
              <Field label={t("lib_form_env_vars")}>
                <input
                  value={form.envVarsRequired.join(",")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      envVarsRequired: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  spellCheck={false}
                  className={inputClass}
                  style={{ fontFamily: "ui-monospace, monospace" }}
                />
              </Field>
            </div>
          </Section>

          <Section title={t("lib_section_examples")} hint={t("lib_section_examples_hint")}>
            <CurlExamplesInput
              examples={examples}
              setExamples={setExamples}
              baseUrlHint={form.baseUrl || undefined}
            />
          </Section>

          {pipelineError && (
            <ErrorCard label={t("codegen_pipeline_error")} message={pipelineError} />
          )}

          {timings && !pipelineError && (
            <div className="px-3 py-2 rounded-md border border-line bg-panel">
              <div className="text-[10px] uppercase tracking-[0.06em] text-ink-4 mb-1">
                {t("codegen_pipeline_last_run")}
              </div>
              <div className="flex items-center gap-2 text-[11.5px]">
                <span className="text-ink-1 font-medium mono">{timings.totalMs} ms</span>
                <span className="text-ink-4">·</span>
                <span className="text-ink-3 mono text-[10.5px]">{timings.modelUsed}</span>
              </div>
            </div>
          )}

          <button
            onClick={runPipeline}
            disabled={!canGenerate}
            className="h-9 px-3 rounded-md text-[12.5px] font-medium border-0 cursor-pointer w-full"
            style={{
              background: canGenerate ? "var(--c-accent)" : "var(--c-panel)",
              color: canGenerate ? "white" : "var(--c-ink-4)",
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? t("codegen_generating") : t("lib_generate")}
          </button>

          {/* Back link to PromptGen after successful generation */}
          {fromPromptGen && (registrySuggestion.length > 0 || compileResult !== null) && (
            <a
              href="/behavior/codegen"
              className="text-[12px] text-center py-2 px-3 rounded-md border border-line bg-panel text-ink-2 no-underline hover:bg-surface"
              style={{ display: "block" }}
            >
              {t("lib_loop_back")}
            </a>
          )}
        </aside>

        {/* Middle — editor tabs */}
        <main className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center border-b border-line bg-surface px-3 gap-1" style={{ height: 36 }}>
            <TabBtn id="code" current={tab} setTab={setTab} label={t("lib_tab_code")} />
            <TabBtn id="registry" current={tab} setTab={setTab} label={t("lib_tab_registry")} />
            <TabBtn id="spec" current={tab} setTab={setTab} label={t("lib_tab_spec")} />
          </div>
          <div className="flex-1 min-h-0">
            {tab === "code" && (
              <CodeEditor
                value={code}
                onChange={setCode}
                language="typescript"
                path={`lib/generated/${form.name || "scratch"}/client.ts`}
                height="100%"
              />
            )}
            {tab === "registry" && (
              <CodeEditor
                value={registryText}
                language="typescript"
                path="tool-registry-suggestions.ts"
                height="100%"
                readOnly
              />
            )}
            {tab === "spec" && (
              <CodeEditor
                value={specText}
                language="json"
                path="lib-output.json"
                height="100%"
                readOnly
              />
            )}
          </div>
        </main>

        {/* Right rail — Compiler (reused) */}
        <CompilerPanel
          result={compileResult}
          running={busy}
          error={compileError}
          onCompile={runCompile}
        />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────

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

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4 font-medium">
          {title}
        </span>
        {hint && <span className="text-[10px] text-ink-4">{hint}</span>}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] text-ink-3">{label}</span>
      {children}
    </label>
  );
}

function ErrorCard({ label, message }: { label: string; message: string }) {
  return (
    <div
      className="px-3 py-2.5 text-[11.5px] rounded-md border"
      style={{
        background: "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 6%, var(--c-panel))",
        borderColor: "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 30%, var(--c-line))",
        color: "var(--c-err, oklch(0.5 0.2 25))",
      }}
    >
      <div className="font-medium text-[10px] uppercase tracking-[0.06em] mb-1">{label}</div>
      <div className="leading-snug">{message}</div>
    </div>
  );
}

const inputClass =
  "h-7 px-2 bg-panel border border-line rounded-md text-[11.5px] text-ink-1 focus:outline-none focus:border-line-strong";
