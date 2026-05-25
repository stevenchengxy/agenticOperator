"use client";

// Operator-facing editor for one or more CurlExample seeds. Each entry has
// verb + path + description, with optional request/response sample JSON for
// type inference. The order operator drags-or-types them in is the order
// LLM Call C emits methods.

import React from "react";
import type { CurlExample } from "@/lib/agent-codegen/library/lib-spec-types";
import { useApp } from "@/lib/i18n";

const VERBS: CurlExample["httpVerb"][] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function CurlExamplesInput({
  examples,
  setExamples,
}: {
  examples: CurlExample[];
  setExamples: React.Dispatch<React.SetStateAction<CurlExample[]>>;
}) {
  const { t } = useApp();

  const addExample = () =>
    setExamples((xs) => [
      ...xs,
      { httpVerb: "GET", httpPath: "/", description: "" },
    ]);

  const updateExample = (i: number, patch: Partial<CurlExample>) =>
    setExamples((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const removeExample = (i: number) =>
    setExamples((xs) => xs.filter((_, j) => j !== i));

  return (
    <div className="flex flex-col gap-3">
      {examples.length === 0 && (
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
