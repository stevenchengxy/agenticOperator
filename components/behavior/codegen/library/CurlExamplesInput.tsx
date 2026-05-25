"use client";

// Operator-facing editor for one or more CurlExample seeds. Each entry has
// verb + path + description, with optional request/response sample JSON for
// type inference. The order operator drags-or-types them in is the order
// LLM Call C emits methods.
//
// Two seed input modes:
//   📋 Examples (default): structured entry — operator types verb/path/sample
//   💬 NL: free text → LLM drafts CurlExample[] for operator to refine
//        (draft mode never bypasses human review — drafted entries land in
//         the structured list and are editable before running lib codegen)

import React from "react";
import type { CurlExample } from "@/lib/agent-codegen/library/lib-spec-types";
import { useApp } from "@/lib/i18n";

const VERBS: CurlExample["httpVerb"][] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function CurlExamplesInput({
  examples,
  setExamples,
  baseUrlHint,
}: {
  examples: CurlExample[];
  setExamples: React.Dispatch<React.SetStateAction<CurlExample[]>>;
  /** Operator-supplied base URL — passed to NL drafter so LLM doesn't invent host. */
  baseUrlHint?: string;
}) {
  const { t } = useApp();
  const [mode, setMode] = React.useState<"examples" | "nl">("examples");
  const [nlText, setNlText] = React.useState("");
  const [drafting, setDrafting] = React.useState(false);
  const [draftError, setDraftError] = React.useState<string | null>(null);

  const addExample = () =>
    setExamples((xs) => [
      ...xs,
      { httpVerb: "GET", httpPath: "/", description: "" },
    ]);

  const draftFromNL = async () => {
    setDrafting(true);
    setDraftError(null);
    try {
      const r = await fetch("/api/codegen/library/draft-examples", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: nlText, baseUrlHint }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { examples: CurlExample[] };
      // Append drafted examples to whatever the operator already has —
      // they review and edit BEFORE running the full lib codegen.
      setExamples((xs) => [...xs, ...j.examples]);
      // Switch back to examples view so operator immediately sees + reviews.
      setMode("examples");
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };

  const updateExample = (i: number, patch: Partial<CurlExample>) =>
    setExamples((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const removeExample = (i: number) =>
    setExamples((xs) => xs.filter((_, j) => j !== i));

  return (
    <div className="flex flex-col gap-3">
      {/* Mode toggle */}
      <div className="flex gap-1 p-0.5 bg-panel border border-line rounded-md">
        <ModeChip active={mode === "examples"} onClick={() => setMode("examples")}>
          📋 {t("lib_mode_examples")}
        </ModeChip>
        <ModeChip active={mode === "nl"} onClick={() => setMode("nl")}>
          💬 {t("lib_mode_nl")}
        </ModeChip>
      </div>

      {/* NL drafter */}
      {mode === "nl" && (
        <div className="flex flex-col gap-2 p-2 rounded-md border border-line bg-panel">
          <span className="text-[10px] uppercase tracking-[0.08em] text-ink-4">
            {t("lib_nl_prompt_label")}
          </span>
          <textarea
            value={nlText}
            onChange={(e) => setNlText(e.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={t("lib_nl_placeholder")}
            disabled={drafting}
            className="w-full p-2 bg-surface border border-line rounded-md text-[11.5px] leading-[1.5]"
          />
          <button
            onClick={draftFromNL}
            disabled={drafting || nlText.trim().length < 12}
            className="h-7 px-3 rounded-md text-[11.5px] font-medium border-0 cursor-pointer self-start"
            style={{
              background:
                drafting || nlText.trim().length < 12 ? "var(--c-panel)" : "var(--c-accent)",
              color:
                drafting || nlText.trim().length < 12 ? "var(--c-ink-4)" : "white",
            }}
          >
            {drafting ? t("lib_drafting") : t("lib_draft_action")}
          </button>
          {draftError && (
            <div className="text-[10.5px] leading-snug" style={{ color: "var(--c-err, oklch(0.5 0.2 25))" }}>
              {draftError}
            </div>
          )}
          <p className="text-[10px] text-ink-4 leading-snug m-0">
            {t("lib_nl_review_note")}
          </p>
        </div>
      )}

      {examples.length === 0 && mode === "examples" && (
        <div className="text-[11px] text-ink-4 leading-snug px-2">
          {t("lib_examples_empty")}
        </div>
      )}

      {examples.map((ex, i) => (
        <div
          key={i}
          className="rounded-md border border-line bg-panel p-3 flex flex-col gap-2"
        >
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.08em] text-ink-4 mono">
              #{i + 1}
            </span>
            <select
              value={ex.httpVerb}
              onChange={(e) =>
                updateExample(i, { httpVerb: e.target.value as CurlExample["httpVerb"] })
              }
              className="h-6 px-1.5 bg-surface border border-line rounded-md text-[11px] mono"
            >
              {VERBS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <input
              value={ex.httpPath}
              onChange={(e) => updateExample(i, { httpPath: e.target.value })}
              placeholder="/api/v1/applications/:id"
              spellCheck={false}
              className="flex-1 h-6 px-2 bg-surface border border-line rounded-md text-[11px] mono"
            />
            <button
              onClick={() => removeExample(i)}
              className="text-ink-4 hover:text-ink-1 border-0 bg-transparent cursor-pointer px-1"
              title="remove"
            >
              ×
            </button>
          </div>

          <input
            value={ex.description}
            onChange={(e) => updateExample(i, { description: e.target.value })}
            placeholder={t("lib_example_desc_placeholder")}
            spellCheck={false}
            className="h-6 px-2 bg-surface border border-line rounded-md text-[11px]"
          />

          {(ex.httpVerb === "POST" || ex.httpVerb === "PUT" || ex.httpVerb === "PATCH") && (
            <SampleArea
              label={t("lib_example_request")}
              value={ex.requestSample ?? ""}
              onChange={(v) => updateExample(i, { requestSample: v })}
              placeholder='{"title": "Senior SRE", "level": 4}'
            />
          )}
          <SampleArea
            label={t("lib_example_response")}
            value={ex.responseSample ?? ""}
            onChange={(v) => updateExample(i, { responseSample: v })}
            placeholder='{"id": "job_123", "title": "Senior SRE", "createdAt": "2026-..."}'
          />
        </div>
      ))}

      <button
        onClick={addExample}
        className="h-7 px-2 rounded-md border border-line bg-panel text-[11.5px] text-ink-2 cursor-pointer hover:bg-surface"
      >
        + {t("lib_add_example")}
      </button>
    </div>
  );
}

function ModeChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex-1 h-6 px-2 rounded-sm text-[11px] border-0 cursor-pointer"
      style={{
        background: active ? "var(--c-surface)" : "transparent",
        color: active ? "var(--c-ink-1)" : "var(--c-ink-3)",
        fontWeight: active ? 500 : 400,
        boxShadow: active ? "var(--shadow-sh-1, 0 1px 2px rgba(0,0,0,0.04))" : "none",
      }}
    >
      {children}
    </button>
  );
}

function SampleArea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4 mono">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={3}
        placeholder={placeholder}
        className="w-full p-1.5 bg-surface border border-line rounded-md text-[10.5px] mono leading-[1.45] resize-vertical"
      />
    </div>
  );
}
