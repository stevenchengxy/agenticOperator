"use client";
import React from "react";
import type { AgentDescription } from "@/lib/monitor/agent-descriptions";
import { useApp } from "@/lib/i18n";

export function InternalFlowDiagram({ desc }: { desc: AgentDescription | null }) {
  const { t } = useApp();
  if (!desc || desc.processingLogic.length === 0) {
    return (
      <div className="text-claude-ink-4 text-[12.5px] py-4 text-center">
        {t('monitor_internal_flow_empty')}
      </div>
    );
  }
  const steps = desc.processingLogic;
  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex items-stretch gap-0 min-w-fit">
        {steps.map((step, i) => (
          <React.Fragment key={i}>
            <div className="flex-none w-[170px] rounded-[10px] border border-claude-line bg-claude-surface p-3 relative">
              <div
                className="absolute -top-2 -left-2 w-6 h-6 rounded-full text-white text-[11px] flex items-center justify-center font-medium"
                style={{ background: "var(--c-claude-accent)" }}
              >
                {i + 1}
              </div>
              <div className="text-[12px] text-claude-ink-1 leading-relaxed mt-1">
                {step}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div className="flex items-center px-2 text-claude-ink-3">
                <svg width="20" height="12" viewBox="0 0 20 12" fill="none">
                  <path
                    d="M0 6h17m-4-4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
