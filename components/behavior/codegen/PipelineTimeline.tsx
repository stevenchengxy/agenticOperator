"use client";

// Left-rail 6-stage pipeline indicator.
//   1 Prompt  → 2 Spec  → 3 Template render  → 4 Step body  → 5 Compile  → 6 Review/save
// Phase 1a: all stages are read-only placeholders (no LLM yet).
// Phase 1b: pipeline state lifts to CodegenContent and stages light up as
//           the orchestrator advances.

import React from "react";
import { useApp } from "@/lib/i18n";

export type PipelineStage = "prompt" | "spec" | "render" | "body" | "compile" | "review";

export type StageState = "idle" | "active" | "ok" | "err";

const STAGE_ORDER: PipelineStage[] = ["prompt", "spec", "render", "body", "compile", "review"];

export function PipelineTimeline({
  states,
}: {
  /** Map stage → state. Missing entries default to 'idle'. */
  states: Partial<Record<PipelineStage, StageState>>;
}) {
  const { t } = useApp();
  return (
    <ol className="m-0 p-0 list-none flex flex-col gap-[2px]">
      {STAGE_ORDER.map((s, i) => {
        const state = states[s] ?? "idle";
        return (
          <li
            key={s}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md"
            style={{
              background: state === "active" ? "var(--c-accent-bg)" : "transparent",
            }}
          >
            <span
              className="mono text-[10px] w-[14px] text-center"
              style={{ color: state === "idle" ? "var(--c-ink-4)" : "var(--c-ink-2)" }}
            >
              {i + 1}
            </span>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background:
                  state === "ok"
                    ? "var(--c-ok)"
                    : state === "err"
                    ? "var(--c-err, oklch(0.5 0.2 25))"
                    : state === "active"
                    ? "var(--c-accent)"
                    : "var(--c-ink-4)",
                opacity: state === "idle" ? 0.4 : 1,
              }}
            />
            <span
              className="text-[12px]"
              style={{
                color:
                  state === "active"
                    ? "var(--c-accent)"
                    : state === "idle"
                    ? "var(--c-ink-3)"
                    : "var(--c-ink-1)",
                fontWeight: state === "active" ? 500 : 400,
              }}
            >
              {t(`codegen_stage_${s}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
