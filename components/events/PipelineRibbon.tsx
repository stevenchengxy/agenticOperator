"use client";
import React from "react";
import { STAGE_META, eventToStage, type PipelineStage } from "@/lib/events/pipeline-stages";

export function PipelineRibbon({
  current,
  eventsByName,
  lang,
}: {
  current: PipelineStage;
  eventsByName: Record<string, number>;
  lang: "zh" | "en";
}) {
  const stages: PipelineStage[] = ["intake", "parse", "rule_check", "match", "interview", "evaluate", "submit"];
  const reachedStages = new Set<PipelineStage>();
  for (const name of Object.keys(eventsByName)) reachedStages.add(eventToStage(name));

  return (
    <div className="flex items-center gap-0 overflow-x-auto">
      {stages.map((s, i) => {
        const meta = STAGE_META[s];
        const reached = reachedStages.has(s);
        const isCurrent = s === current;
        return (
          <React.Fragment key={s}>
            <div className="flex flex-col items-center gap-1 flex-shrink-0" style={{ minWidth: 78 }}>
              <div
                className="rounded-full grid place-items-center transition-all"
                style={{
                  width: isCurrent ? 28 : 22,
                  height: isCurrent ? 28 : 22,
                  background: reached ? meta.color : "var(--c-line)",
                  color: "white",
                  fontSize: 10,
                  fontWeight: 600,
                  boxShadow: isCurrent ? `0 0 0 4px color-mix(in oklab, ${meta.color} 20%, transparent)` : "none",
                }}
                aria-hidden="true"
              >
                {meta.order}
              </div>
              <div
                className="text-[10.5px] text-center"
                style={{
                  color: reached ? "var(--c-ink-1)" : "var(--c-ink-4)",
                  fontWeight: isCurrent ? 600 : 400,
                  whiteSpace: "nowrap",
                }}
              >
                {lang === "zh" ? meta.zh : meta.en}
              </div>
            </div>
            {i < stages.length - 1 && (
              <div
                className="flex-shrink-0"
                style={{
                  height: 2,
                  width: 24,
                  background: reachedStages.has(stages[i + 1]) ? meta.color : "var(--c-line)",
                  marginTop: -16,
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
