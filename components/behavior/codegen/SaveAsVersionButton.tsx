"use client";

// Save the (prompt, spec, code) tuple from the current codegen session into
// the AgentVersion table as a new draft. Only enabled when:
//   - compile.ok                            (no errors blocking save)
//   - the generated slug maps to an AGENT_MAP entry (otherwise the codegen
//     output is for a brand-new agent that hasn't been registered yet)
//
// On success the button collapses to a confirmation pill with the new
// version label. On 409 (duplicate) we surface that message inline.

import React from "react";
import { byInngestSlug, type AgentMeta } from "@/lib/agent-mapping";
import { useApp } from "@/lib/i18n";
import type { CaptureVersionResponse } from "@/lib/agent-versions/types";

export function SaveAsVersionButton({
  slug,
  prompt,
  spec,
  code,
  modelUsed,
  canSave,
}: {
  slug: string | null;
  prompt: string;
  spec: string;
  code: string;
  modelUsed: string | null;
  /** Gate from caller — typically `compileResult?.ok === true`. */
  canSave: boolean;
}) {
  const { t } = useApp();
  const [status, setStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedLabel, setSavedLabel] = React.useState<string | null>(null);
  const [errMsg, setErrMsg] = React.useState<string | null>(null);

  const meta: AgentMeta | undefined = slug ? byInngestSlug(slug) : undefined;
  const eligible = canSave && !!meta && !!code && !!spec && !!modelUsed;

  // Reset confirmation when inputs change (operator regenerates).
  React.useEffect(() => {
    setStatus("idle");
    setSavedLabel(null);
    setErrMsg(null);
  }, [code, spec]);

  const save = async () => {
    if (!meta || !modelUsed) return;
    setStatus("saving");
    setErrMsg(null);
    try {
      const r = await fetch(
        `/api/agents/${encodeURIComponent(meta.short)}/versions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            codegen: { codeBlob: code, specJson: spec, promptText: prompt, modelUsed },
          }),
        },
      );
      const j = (await r.json()) as CaptureVersionResponse;
      if (!r.ok || !j.ok) {
        setStatus("error");
        setErrMsg("message" in j ? j.message : `HTTP ${r.status}`);
        return;
      }
      setStatus("saved");
      setSavedLabel(j.version.versionLabel);
    } catch (e) {
      setStatus("error");
      setErrMsg(e instanceof Error ? e.message : String(e));
    }
  };

  if (status === "saved" && savedLabel) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-md border text-[11.5px]"
        style={{
          background: "color-mix(in oklab, var(--c-ok) 8%, var(--c-panel))",
          borderColor: "color-mix(in oklab, var(--c-ok) 30%, var(--c-line))",
          color: "var(--c-ink-1)",
        }}
      >
        <span style={{ color: "var(--c-ok)", fontWeight: 600 }}>✓</span>
        <span className="font-medium">
          {t("codegen_save_success")} ·{" "}
          <span className="mono">{savedLabel}</span>
        </span>
      </div>
    );
  }

  if (!eligible) {
    return (
      <div className="text-[10.5px] text-ink-4 px-2 leading-snug">
        {!meta && slug
          ? t("codegen_save_unknown_slug").replace("{slug}", slug)
          : !canSave
          ? t("codegen_save_need_clean_compile")
          : t("codegen_save_need_generation")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={save}
        disabled={status === "saving"}
        className="h-8 px-3 rounded-md text-[12px] font-medium border-0 cursor-pointer w-full text-left"
        style={{
          background: "var(--c-accent)",
          color: "white",
          opacity: status === "saving" ? 0.7 : 1,
        }}
      >
        {status === "saving" ? t("codegen_saving") : t("codegen_save_as_version")}
        {meta && (
          <span className="ml-2 opacity-80 mono text-[10.5px]">
            → {meta.short}
          </span>
        )}
      </button>
      {errMsg && (
        <div
          className="text-[10.5px] leading-snug px-1"
          style={{ color: "var(--c-err, oklch(0.5 0.2 25))" }}
        >
          {errMsg}
        </div>
      )}
    </div>
  );
}
