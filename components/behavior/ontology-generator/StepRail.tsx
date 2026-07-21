"use client";
import React from "react";
import clsx from "clsx";
import { useApp } from "@/lib/i18n";

// The 推断 → 生成 → 部署 stepper header. `current` is the active step index;
// earlier steps render as done (check), later steps as pending.
export function StepRail({ current }: { current: 0 | 1 | 2 }) {
  const { t } = useApp();
  const steps = [
    { title: t("og_step_infer"), sub: t("og_step_infer_sub") },
    { title: t("og_step_generate"), sub: t("og_step_generate_sub") },
    { title: t("og_step_deploy"), sub: t("og_step_deploy_sub") },
  ];

  return (
    <div className="flex items-center gap-3 py-5">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <React.Fragment key={i}>
            <div className="flex items-center gap-3">
              <div
                className={clsx(
                  "w-9 h-9 rounded-full grid place-items-center text-[13px] font-semibold transition-all flex-none",
                  active && "text-white",
                  done && "text-[color:var(--c-accent)]",
                  !active && !done && "text-ink-4 border border-line",
                )}
                style={
                  active
                    ? { background: "var(--c-accent)", boxShadow: "0 0 0 4px color-mix(in oklab, var(--c-accent) 22%, transparent)" }
                    : done
                      ? { background: "color-mix(in oklab, var(--c-accent) 14%, transparent)" }
                      : undefined
                }
              >
                {done ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              <div className="hidden sm:block">
                <div className={clsx("text-[13.5px] font-semibold", active || done ? "text-ink-1" : "text-ink-3")}>
                  {s.title}
                </div>
                <div className="text-[11px] text-ink-4">{s.sub}</div>
              </div>
            </div>
            {i < steps.length - 1 && (
              <div className="flex-1 h-px min-w-[28px]" style={{ background: i < current ? "color-mix(in oklab, var(--c-accent) 40%, transparent)" : "var(--c-line)" }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
