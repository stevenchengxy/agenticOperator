"use client";

// Codegen page — v2 (form-first).
//
// Layout:
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ Hero header (serif title + subtitle + domain badge)                  │
//   │ Horizontal pipeline stepper                                          │
//   ├─────────────┬───────────────────────────────────────┬───────────────┤
//   │ Left rail   │ Middle (Monaco tabs)                  │ Right rail    │
//   │ AgentConfig │ Spec / Code / Diff                    │ Compiler +    │
//   │ Form        │                                       │ Save button   │
//   └─────────────┴───────────────────────────────────────┴───────────────┘
//
// v2 reframe:
//   - Operator fills slug / displayName / stage / owner / trigger / emits /
//     retries / errorHandling in the FORM (left rail) — not free-form prompt.
//   - LLM only writes the steps[] array and per-step bodies.
//   - "Regenerate existing" mode lets the operator pick from AGENT_MAP and
//     prefills the form, so save-as-version reliably round-trips.

import React from "react";
import { useApp } from "@/lib/i18n";
import { useDomain, getDomain } from "@/lib/domains";
import { byInngestSlug, AGENT_MAP } from "@/lib/agent-mapping";
import { getEventRegistry } from "@/lib/agent-codegen/registries";
import { CodeEditor } from "./CodeEditor";
import { CompilerPanel } from "./CompilerPanel";
import {
  AgentConfigForm,
  emptyFormState,
  toApiPayload,
  type AgentConfigFormState,
} from "./AgentConfigForm";
import {
  PipelineTimeline,
  type PipelineStage,
  type StageState,
} from "./PipelineTimeline";
import { DiffViewer } from "./DiffViewer";
import { SaveAsVersionButton } from "./SaveAsVersionButton";
import { EvaluationPanel } from "./EvaluationPanel";
import { CodeFixerDialog, type FixSuggestion } from "./CodeFixerDialog";
import { AutoIterateDialog, type OnAdoptArgs } from "./AutoIterateDialog";
import { IntentPanel } from "./IntentPanel";
import { AgentPromptView } from "./AgentPromptView";
import type { AgentPrompt } from "@/lib/agent-codegen/prompt-gen/prompt-types";
import type { AgentFormFields } from "@/lib/agent-codegen/spec-types";
import { toCodegenInput } from "@/lib/agent-codegen/prompt-gen/to-codegen-input";
import { serializePromptText } from "@/lib/agent-codegen/prompt-gen/prompt-version";
import type { AutoIterateRunResult } from "@/lib/agent-codegen/eval/auto-iterate";
import type { CompileResult } from "@/lib/agent-codegen/compiler/types";
import type { AgentSpec } from "@/lib/agent-codegen/spec-types";
import type { EvaluationReport } from "@/lib/agent-codegen/eval/evaluation-report";
import type { VersionsListResponse } from "@/lib/agent-versions/types";

type Tab = "spec" | "code" | "diff" | "evaluation";

const STARTER_BUSINESS_LOGIC = `每一步该做的事(自然语言,LLM 看这部分):

1. 收到事件后,从 partner Postgres 拉相关上下文
2. 把上下文镜像写到图引擎实例库
3. 调 RoboHire 完成主业务动作 (4xx 失败走 NonRetriableError)
4. 把结果落回 partner Postgres
5. emit 下游事件
`;

const STARTER_CODE = `// 用左侧 Form 填好 → 点 "生成 Agent →"
//   或者 直接在这里粘代码 → 点 右侧 Compile
//
// 编译器会把这段视作真实文件,@/ 别名按真实项目解析。

import { AGENT_MAP } from '@/lib/agent-mapping';

export const _placeholder = AGENT_MAP.length;
`;

const DIFF_EMPTY_LEFT = `// No saved version yet for this agent.
// Generate, compile clean, then click "Save as version" — the next
// generation diffs against what you just saved.
`;

export function CodegenContent() {
  const { t } = useApp();
  const { domain } = useDomain();
  const domainMeta = getDomain(domain);

  // State -------------------------------------------------------------------
  const [tab, setTab] = React.useState<Tab>("code");
  const [form, setForm] = React.useState<AgentConfigFormState>(() => emptyFormState());
  const [businessLogic, setBusinessLogic] = React.useState(STARTER_BUSINESS_LOGIC);
  const [spec, setSpec] = React.useState<AgentSpec | null>(null);
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
  const [savedActiveCode, setSavedActiveCode] = React.useState<string | null>(null);
  // Evaluation panel state — populated by /api/codegen/evaluate. Auto-runs
  // after a successful pipeline generation; can be manually re-run via the
  // panel's "Re-evaluate" button.
  const [evalReport, setEvalReport] = React.useState<EvaluationReport | null>(null);
  const [evalRunning, setEvalRunning] = React.useState(false);
  const [evalError, setEvalError] = React.useState<string | null>(null);
  // AI code-fixer state. Opens the modal + fires the LLM call when the
  // operator clicks ✨ Suggest fix in the CompilerPanel.
  const [fixerOpen, setFixerOpen] = React.useState(false);
  const [fixerSuggestion, setFixerSuggestion] = React.useState<FixSuggestion | null>(null);
  const [fixerRunning, setFixerRunning] = React.useState(false);
  const [fixerError, setFixerError] = React.useState<string | null>(null);
  // Stage-0 PromptGen state ─────────────────────────────────────────────────
  const [intent, setIntent] = React.useState("");
  const [locked, setLocked] = React.useState<Partial<AgentFormFields>>({});
  const [blueprintSlug, setBlueprintSlug] = React.useState<string | undefined>(undefined);
  const [agentPrompt, setAgentPrompt] = React.useState<AgentPrompt | null>(null);
  const [missingTools, setMissingTools] = React.useState<string[]>([]);
  const [pgLoading, setPgLoading] = React.useState(false);
  const [pgError, setPgError] = React.useState<string | null>(null);

  // Blueprint slugs from AGENT_MAP (domain-filtered) + event names for IntentPanel
  const eventNames = React.useMemo(
    () => getEventRegistry(domain).map((e) => e.name),
    [domain],
  );
  const blueprintSlugs = React.useMemo(
    () =>
      AGENT_MAP.filter((a) => a.domain === domain).map(
        (a) =>
          a.inngestId ??
          a.short.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase() + "-agent",
      ),
    [domain],
  );

  // Bundle M — AI auto-iteration loop. Triggered from EvaluationPanel.
  const [autoIterOpen, setAutoIterOpen] = React.useState(false);
  const [autoIterRunning, setAutoIterRunning] = React.useState(false);
  const [autoIterResult, setAutoIterResult] = React.useState<AutoIterateRunResult | null>(null);
  const [autoIterError, setAutoIterError] = React.useState<string | null>(null);

  // When the form points at a registered agent, pre-fetch its saved
  // codegen versions so the Diff tab has a real left side.
  React.useEffect(() => {
    const slug = form.slug;
    if (!slug) return setSavedActiveCode(null);
    const meta = byInngestSlug(slug);
    if (!meta) return setSavedActiveCode(null);
    let cancelled = false;
    fetch(`/api/agents/${encodeURIComponent(meta.short)}/versions`)
      .then((r) => r.json())
      .then((j: VersionsListResponse) => {
        if (cancelled) return;
        const latest =
          j.versions.find((v) => v.id === j.activeVersionId) ?? j.versions[0];
        const codeBlob = (latest as unknown as { codeBlob?: string })?.codeBlob;
        setSavedActiveCode(typeof codeBlob === "string" ? codeBlob : null);
      })
      .catch(() => setSavedActiveCode(null));
    return () => {
      cancelled = true;
    };
  }, [form.slug, pipelineTimings]);

  // Pipeline state derivation ----------------------------------------------
  const pipelineStates: Partial<Record<PipelineStage, StageState>> =
    React.useMemo(() => {
      const s: Partial<Record<PipelineStage, StageState>> = {};
      // Stage 0 — promptgen
      if (pgLoading) s.promptgen = "active";
      else if (agentPrompt) s.promptgen = "ok";
      // Stage 1 — form filled (slug + trigger required as proxy for "configured")
      if (form.slug && form.triggerEvent) s.prompt = "ok";
      // Stage 2-4 — generated artifacts present
      if (spec) {
        s.spec = "ok";
        s.render = "ok";
        if (spec.steps.length > 0) s.body = "ok";
      }
      // Stage 5 — compile
      if (compiling) s.compile = "active";
      else if (compileResult) s.compile = compileResult.ok ? "ok" : "err";
      // Stage 6 — ready to save
      if (compileResult?.ok && spec) s.review = "ok";
      // Active LLM round-trip overrides
      if (pipelineStage) s[pipelineStage] = "active";
      return s;
    }, [form.slug, form.triggerEvent, spec, pipelineStage, compiling, compileResult, pgLoading, agentPrompt]);

  // Actions -----------------------------------------------------------------

  // Stage-0: generate a structured AgentPrompt from intent + locked fields
  const handleGeneratePrompt = React.useCallback(async () => {
    setPgError(null);
    setPgLoading(true);
    try {
      const r = await fetch("/api/codegen/prompt-gen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent, domain, locked, blueprintSlug }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      }
      const result = await r.json() as {
        prompt: AgentPrompt;
        missingTools: string[];
        modelUsed: string;
      };
      setAgentPrompt(result.prompt);
      setMissingTools(result.missingTools ?? []);
      // Seed form from inferred fields (without confirming trigger/slug).
      // Also seed displayName and ownerTeam defaults so the Accept gate
      // (AgentFormFieldsSchema) doesn't 400 on the happy path (C1 fix).
      setForm((prev) => {
        const suggestedSlug: string = result.prompt.trigger.event
          ? result.prompt.trigger.event
              .replace(/\//g, "-")
              .replace(/[^a-z0-9-]/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "") + "-agent"
          : prev.slug && /^[a-z][a-z0-9-]*-agent$/.test(prev.slug)
          ? prev.slug
          : prev.slug && prev.slug.trim()
          ? (/^[a-z][a-z0-9-]*$/.test(prev.slug.trim())
              ? prev.slug.trim() + "-agent"
              : prev.slug.trim())
          : prev.slug;
        const nextSlug = prev.slug ? prev.slug : suggestedSlug;
        const normalizedSlug =
          nextSlug && !nextSlug.endsWith("-agent") && /^[a-z][a-z0-9-]*$/.test(nextSlug)
            ? nextSlug + "-agent"
            : nextSlug;
        const defaultDisplayName = normalizedSlug
          ? normalizedSlug
              .replace(/-agent$/, "")
              .split("-")
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" ") + " Agent"
          : "";
        return {
          ...prev,
          triggerEvent: result.prompt.trigger.event || prev.triggerEvent,
          emitEvents: result.prompt.emits.length > 0 ? result.prompt.emits : prev.emitEvents,
          slug: normalizedSlug || prev.slug,
          displayName: prev.displayName.trim() ? prev.displayName : defaultDisplayName,
          ownerTeam: prev.ownerTeam.trim() ? prev.ownerTeam : "recruiting",
        };
      });
    } catch (e) {
      setPgError(e instanceof Error ? e.message : String(e));
    } finally {
      setPgLoading(false);
    }
  }, [intent, domain, locked, blueprintSlug]);

  const runPipeline = React.useCallback(async (blOverride?: string) => {
    const effectiveBl = blOverride ?? businessLogic;
    setPipelineError(null);
    setPipelineTimings(null);
    setCompileError(null);
    setCompileResult(null);
    setPipelineStage("spec");
    try {
      const r = await fetch("/api/codegen/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          form: toApiPayload(form),
          businessLogic: effectiveBl,
          domain,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      }
      const result = await r.json();
      setSpec(result.spec as AgentSpec);
      setCode(result.code.content);
      setVirtualPath(result.code.path);
      setCompileResult(result.compile);
      setPipelineTimings({
        totalMs: result.timings.totalMs,
        modelUsed: result.modelUsed,
      });
      setTab("code");

      // Auto-fire evaluation against the freshly-generated artifacts.
      // Pass them explicitly because the state setters above haven't flushed yet.
      void (async () => {
        setEvalReport(null);
        setEvalRunning(true);
        setEvalError(null);
        try {
          const er = await fetch("/api/codegen/evaluate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              spec: result.spec,
              code: result.code.content,
              prompt: effectiveBl,
              domain,
              modelUsed: result.modelUsed,
              pipelineTotalMs: result.timings.totalMs,
              form: toApiPayload(form),
            }),
          });
          if (!er.ok) {
            const j = (await er.json().catch(() => ({}))) as { message?: string; error?: string };
            throw new Error(j.message ?? j.error ?? `HTTP ${er.status}`);
          }
          setEvalReport((await er.json()) as EvaluationReport);
        } catch (e) {
          setEvalError(e instanceof Error ? e.message : String(e));
        } finally {
          setEvalRunning(false);
        }
      })();
    } catch (e) {
      setPipelineError(e instanceof Error ? e.message : String(e));
    } finally {
      setPipelineStage(null);
    }
  }, [form, businessLogic, domain]);

  // Stage-0 → Stage-1: accept the reviewed AgentPrompt and feed existing pipeline
  const handleAcceptPrompt = React.useCallback(async () => {
    if (!agentPrompt) return;
    if (!agentPrompt.trigger.confirmed) return;
    if (!form.slug?.trim()) return;
    const { businessLogic: bl } = toCodegenInput(agentPrompt, toApiPayload(form));
    setBusinessLogic(bl);
    await runPipeline(bl);
  }, [agentPrompt, form, runPipeline]);

  const runEvaluation = React.useCallback(async () => {
    if (!spec) return;
    setEvalRunning(true);
    setEvalError(null);
    try {
      const r = await fetch("/api/codegen/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spec,
          code,
          prompt: businessLogic,
          domain,
          modelUsed: pipelineTimings?.modelUsed,
          pipelineTotalMs: pipelineTimings?.totalMs,
          form: toApiPayload(form),
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      }
      setEvalReport((await r.json()) as EvaluationReport);
    } catch (e) {
      setEvalError(e instanceof Error ? e.message : String(e));
    } finally {
      setEvalRunning(false);
    }
  }, [spec, code, businessLogic, domain, pipelineTimings, form]);

  const requestAutoIterate = React.useCallback(async () => {
    setAutoIterOpen(true);
    setAutoIterRunning(true);
    setAutoIterError(null);
    setAutoIterResult(null);
    try {
      const r = await fetch("/api/codegen/auto-iterate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          form: toApiPayload(form),
          initialBusinessLogic: businessLogic,
          domain,
          maxIterations: 3,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      }
      setAutoIterResult((await r.json()) as AutoIterateRunResult);
    } catch (e) {
      setAutoIterError(e instanceof Error ? e.message : String(e));
    } finally {
      setAutoIterRunning(false);
    }
  }, [form, businessLogic, domain]);

  const adoptAutoIterRound = React.useCallback(
    (args: OnAdoptArgs) => {
      setBusinessLogic(args.businessLogic);
      setCode(args.code);
      setVirtualPath(args.codePath);
      setAutoIterOpen(false);
      // Final round of the loop already produced a fresh EvaluationReport
      // server-side; we'd ideally fetch it back, but for simplicity let
      // the operator click Re-evaluate manually.
    },
    [],
  );

  const requestFixSuggestion = React.useCallback(async () => {
    if (!compileResult || compileResult.diagnostics.length === 0) return;
    setFixerOpen(true);
    setFixerRunning(true);
    setFixerError(null);
    setFixerSuggestion(null);
    try {
      const r = await fetch("/api/codegen/fix-suggestion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: virtualPath,
          code,
          diagnostics: compileResult.diagnostics,
          domain,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      }
      setFixerSuggestion((await r.json()) as FixSuggestion);
    } catch (e) {
      setFixerError(e instanceof Error ? e.message : String(e));
    } finally {
      setFixerRunning(false);
    }
  }, [compileResult, code, virtualPath, domain]);

  const applyFix = React.useCallback(
    (patched: string) => {
      setCode(patched);
      setFixerOpen(false);
      setFixerSuggestion(null);
      // Immediately retest — operator sees if the fix worked.
      void (async () => {
        setCompiling(true);
        setCompileError(null);
        try {
          const r = await fetch("/api/codegen/compile", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              files: [{ path: virtualPath, content: patched }],
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
        } finally {
          setCompiling(false);
        }
      })();
    },
    [virtualPath, domain],
  );

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
        const j = (await r.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
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

  const specJsonText = React.useMemo(
    () => (spec ? JSON.stringify(spec, null, 2) : "{}"),
    [spec],
  );

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
              {t("codegen_hero_blurb_v2")}
            </p>
          </div>
          <DomainBadge color={domainMeta.color} label={domainMeta.name} />
        </div>

        <PipelineTimeline states={pipelineStates} />
      </header>

      {/* Three-column body */}
      <div className="flex-1 min-h-0 flex">
        {/* Left rail — the form (scrollable) */}
        <aside
          className="border-r border-line bg-surface p-4 flex flex-col gap-4 overflow-auto"
          style={{ width: 320, minWidth: 320 }}
        >
          {/* Stage-0: IntentPanel */}
          <IntentPanel
            intent={intent}
            onIntentChange={setIntent}
            locked={locked}
            onLockedChange={setLocked}
            eventNames={eventNames}
            blueprintSlugs={blueprintSlugs}
            onGenerate={handleGeneratePrompt}
            loading={pgLoading}
          />

          {pgError && (
            <ErrorCard label="PromptGen failed" message={pgError} />
          )}

          {/* Stage-0 output: AgentPromptView (shown once a prompt is generated) */}
          {agentPrompt && (
            <div
              className="border-t border-line pt-3"
            >
              <AgentPromptView
                prompt={agentPrompt}
                onChange={setAgentPrompt}
                missingTools={missingTools}
                onRegenerate={handleGeneratePrompt}
                form={toApiPayload(form)}
                onFormChange={(f) =>
                  setForm((prev) => ({ ...prev, ...f }))
                }
                onAccept={handleAcceptPrompt}
                busy={pipelineStage !== null}
              />
            </div>
          )}

          {/* Divider */}
          <div className="border-t border-line" />

          <AgentConfigForm
            state={form}
            setState={setForm}
            businessLogic={businessLogic}
            setBusinessLogic={setBusinessLogic}
            onGenerate={runPipeline}
            busy={pipelineStage !== null}
          />

          {pipelineError && (
            <ErrorCard label={t("codegen_pipeline_error")} message={pipelineError} />
          )}

          {pipelineTimings && !pipelineError && (
            <div className="px-3 py-2 rounded-md border border-line bg-panel">
              <div className="text-[10px] uppercase tracking-[0.06em] text-ink-4 mb-1">
                {t("codegen_pipeline_last_run")}
              </div>
              <div className="flex items-center gap-2 text-[11.5px]">
                <span className="text-ink-1 font-medium mono">
                  {pipelineTimings.totalMs} ms
                </span>
                <span className="text-ink-4">·</span>
                <span className="text-ink-3 mono text-[10.5px]">
                  {pipelineTimings.modelUsed}
                </span>
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
            <TabBtn id="spec" current={tab} setTab={setTab} label={t("codegen_tab_spec")} />
            <TabBtn id="code" current={tab} setTab={setTab} label={t("codegen_tab_code")} />
            <TabBtn id="diff" current={tab} setTab={setTab} label={t("codegen_tab_diff")} />
            <TabBtn
              id="evaluation"
              current={tab}
              setTab={setTab}
              label={t("codegen_tab_evaluation")}
              badge={
                evalReport
                  ? evalReport.finalVerdict === "FULL"
                    ? "✓"
                    : evalReport.finalVerdict === "PARTIAL"
                    ? "~"
                    : "!"
                  : evalRunning
                  ? "…"
                  : undefined
              }
              badgeColor={
                evalReport?.finalVerdict === "FULL"
                  ? "var(--c-ok)"
                  : evalReport?.finalVerdict === "PARTIAL"
                  ? "var(--c-warn, oklch(0.65 0.14 75))"
                  : evalReport?.finalVerdict === "DRAFT"
                  ? "var(--c-err, oklch(0.5 0.2 25))"
                  : undefined
              }
            />
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
            {tab === "spec" && (
              <CodeEditor
                value={specJsonText}
                language="json"
                path="spec.json"
                height="100%"
                readOnly
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
            {tab === "evaluation" && (
              <EvaluationPanel
                report={evalReport}
                running={evalRunning}
                error={evalError}
                onRun={runEvaluation}
                canRun={!!spec}
                generatedCode={code}
                onAutoIterate={requestAutoIterate}
                autoIterateBusy={autoIterRunning}
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
          onSuggestFix={requestFixSuggestion}
          saveButton={
            <SaveAsVersionButton
              slug={spec?.slug ?? form.slug ?? null}
              prompt={agentPrompt ? serializePromptText(agentPrompt) : businessLogic}
              spec={specJsonText}
              code={code}
              modelUsed={pipelineTimings?.modelUsed ?? null}
              canSave={!!compileResult?.ok && !!spec}
            />
          }
        />
      </div>

      {fixerOpen && (
        <CodeFixerDialog
          currentCode={code}
          suggestion={fixerSuggestion}
          running={fixerRunning}
          error={fixerError}
          onApply={applyFix}
          onClose={() => {
            setFixerOpen(false);
            setFixerSuggestion(null);
            setFixerError(null);
          }}
        />
      )}

      {autoIterOpen && (
        <AutoIterateDialog
          running={autoIterRunning}
          result={autoIterResult}
          error={autoIterError}
          onClose={() => {
            setAutoIterOpen(false);
            setAutoIterResult(null);
            setAutoIterError(null);
          }}
          onAdopt={adoptAutoIterRound}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────

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
  badge,
  badgeColor,
}: {
  id: Tab;
  current: Tab;
  setTab: (t: Tab) => void;
  label: string;
  /** Small char in the tab pill (✓ / ~ / ! / … ) for evaluation feedback. */
  badge?: string;
  badgeColor?: string;
}) {
  const active = id === current;
  return (
    <button
      onClick={() => setTab(id)}
      className="h-7 px-3 rounded-md text-[12px] border-0 cursor-pointer transition-colors inline-flex items-center gap-1.5"
      style={{
        background: active ? "var(--c-accent-bg)" : "transparent",
        color: active ? "var(--c-accent)" : "var(--c-ink-3)",
        fontWeight: active ? 500 : 400,
      }}
    >
      {label}
      {badge && (
        <span
          className="inline-flex items-center justify-center mono"
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: badgeColor ?? "var(--c-ink-4)",
            color: "white",
            fontSize: 9,
            fontWeight: 700,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function ErrorCard({ label, message }: { label: string; message: string }) {
  return (
    <div
      className="px-3 py-2.5 text-[11.5px] rounded-md border"
      style={{
        background:
          "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 6%, var(--c-panel))",
        borderColor:
          "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 30%, var(--c-line))",
        color: "var(--c-err, oklch(0.5 0.2 25))",
      }}
    >
      <div className="font-medium text-[10px] uppercase tracking-[0.06em] mb-1">
        {label}
      </div>
      <div className="leading-snug">{message}</div>
    </div>
  );
}
