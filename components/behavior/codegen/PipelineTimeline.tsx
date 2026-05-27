"use client";

// Horizontal pipeline stepper at the top of the codegen page.
//
// Six stages laid out left-to-right with progress connectors between them.
// State per stage:
//   idle    — not started
//   active  — running now (pulsing)
//   ok      — completed cleanly
//   err     — completed with an error (compile failed, schema rejected, …)
//
// Phase 1b: stages light up as the pipeline advances (spec → bodies → compile).
// "review" lights green once compile.ok && code present, signalling
// "ready to save as version".

import React from "react";
import { useApp } from "@/lib/i18n";

export type PipelineStage =
  | "promptgen"
  | "prompt"
  | "spec"
  | "render"
  | "body"
  | "compile"
  | "review";

export type StageState = "idle" | "active" | "ok" | "err";

const STAGE_ORDER: PipelineStage[] = ["promptgen", "prompt", "spec", "render", "body", "compile", "review"];

export function PipelineTimeline({
  states,
}: {
  states: Partial<Record<PipelineStage, StageState>>;
}) {
  const { t } = useApp();
  return (
    <ol className="m-0 p-0 list-none flex items-center gap-0 w-full">
      {STAGE_ORDER.map((s, i) => {
        const state = states[s] ?? "idle";
        const isLast = i === STAGE_ORDER.length - 1;
        return (
          <React.Fragment key={s}>
            <li className="flex items-center gap-2 px-1">
              <StageDot state={state} index={i + 1} />
              <span
                className="text-[11.5px] whitespace-nowrap"
                style={{
                  color: stateText(state),
                  fontWeight: state === "active" ? 600 : 500,
                  letterSpacing: state === "active" ? "0.005em" : 0,
                }}
              >
                {t(`codegen_stage_${s}`)}
              </span>
            </li>
            {!isLast && <Connector left={state} right={states[STAGE_ORDER[i + 1]] ?? "idle"} />}
          </React.Fragment>
        );
      })}
    </ol>
  );
}

function StageDot({ state, index }: { state: StageState; index: number }) {
  const bg = stateColor(state);
  const ring = state === "idle" ? "transparent" : `color-mix(in oklab, ${bg} 20%, transparent)`;
  return (
    <span
      className={state === "active" ? "anim-pulse" : ""}
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        background: state === "idle" ? "var(--c-panel)" : bg,
        border: state === "idle" ? "1px solid var(--c-line)" : "none",
        color: state === "idle" ? "var(--c-ink-4)" : state === "ok" || state === "err" ? "white" : "white",
        boxShadow: state === "idle" ? "none" : `0 0 0 4px ${ring}`,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        fontWeight: 600,
        transition: "background-color 200ms ease, box-shadow 200ms ease",
      }}
    >
      {state === "ok" ? "✓" : state === "err" ? "!" : index}
    </span>
  );
}

function Connector({ left, right }: { left: StageState; right: StageState }) {
  // Bright when the LEFT side is finished — signals "data has flowed past here".
  const lit = left === "ok" || left === "err" || (left === "active" && right !== "idle");
  return (
    <div
      className="flex-1 mx-1"
      style={{
        height: 2,
        minWidth: 14,
        borderRadius: 1,
        background: lit ? "var(--c-accent)" : "var(--c-line)",
        opacity: lit ? 0.55 : 1,
        transition: "background-color 200ms ease",
      }}
    />
  );
}

function stateColor(s: StageState): string {
  switch (s) {
    case "ok":
      return "var(--c-ok)";
    case "err":
      return "var(--c-err, oklch(0.5 0.2 25))";
    case "active":
      return "var(--c-accent)";
    case "idle":
    default:
      return "var(--c-ink-4)";
  }
}

function stateText(s: StageState): string {
  switch (s) {
    case "ok":
      return "var(--c-ink-1)";
    case "err":
      return "var(--c-err, oklch(0.5 0.2 25))";
    case "active":
      return "var(--c-accent)";
    case "idle":
    default:
      return "var(--c-ink-4)";
  }
}
