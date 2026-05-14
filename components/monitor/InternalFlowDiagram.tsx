"use client";
import React from "react";
import type { AgentDescriptionFull } from "@/lib/monitor/agent-descriptions";
import type { AgentDescription } from "@/lib/monitor/agent-descriptions";
import { ClaudeCard } from "./atoms";
import { useApp } from "@/lib/i18n";

// Accept either the full or base description so legacy callers still work.
type Props = {
  desc: AgentDescriptionFull | AgentDescription | null;
};

export function InternalFlowDiagram({ desc }: Props) {
  const { t } = useApp();
  const [expandedIndex, setExpandedIndex] = React.useState<number | null>(null);

  if (!desc || desc.processingLogic.length === 0) {
    return (
      <div className="text-claude-ink-4 text-[12.5px] py-4 text-center">
        {t('monitor_internal_flow_empty')}
      </div>
    );
  }

  // Determine whether we have full action data
  const fullDesc = 'actions' in desc ? (desc as AgentDescriptionFull) : null;
  const steps = desc.processingLogic;

  return (
    <div>
      <div className="overflow-x-auto pb-2">
        <div className="flex items-stretch gap-0 min-w-fit">
          {steps.map((step, i) => (
            <React.Fragment key={i}>
              <div
                className="flex-none w-[170px] rounded-[10px] border border-claude-line bg-claude-surface p-3 relative cursor-pointer hover:bg-claude-panel transition-colors"
                onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}
              >
                <div
                  className="absolute -top-2 -left-2 w-6 h-6 rounded-full text-white text-[11px] flex items-center justify-center font-medium"
                  style={{ background: "var(--c-claude-accent)" }}
                >
                  {i + 1}
                </div>
                <div className="text-[12px] text-claude-ink-1 leading-relaxed mt-1">
                  {fullDesc ? fullDesc.actions[i]?.name ?? step.split(':')[0] : step}
                </div>
                {fullDesc && fullDesc.actions[i] && (
                  <div className="text-[10.5px] text-claude-ink-3 mt-1 truncate">
                    {fullDesc.actions[i].type}
                  </div>
                )}
                <div className="text-claude-ink-4 mt-1 text-[10px] select-none">
                  {expandedIndex === i ? '▴' : '▾'}
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

      {/* Expanded step detail — shown below the horizontal strip */}
      {expandedIndex !== null && (
        <ClaudeCard className="mt-3 bg-claude-panel/30">
          {fullDesc && fullDesc.actions[expandedIndex] ? (
            <>
              <div className="text-[10.5px] uppercase tracking-[0.08em] text-claude-ink-4 mb-1">
                Step {expandedIndex + 1}: {fullDesc.actions[expandedIndex].name}
              </div>
              <div className="text-[12.5px] text-claude-ink-1 mb-2">
                {fullDesc.actions[expandedIndex].description}
              </div>
              <div className="text-[11px] text-claude-ink-3">
                <span className="font-medium">Type:</span> {fullDesc.actions[expandedIndex].type}
              </div>
              <div className="text-[11px] text-claude-ink-3">
                <span className="font-medium">Condition:</span> {fullDesc.actions[expandedIndex].condition}
              </div>
            </>
          ) : (
            <div className="text-[12.5px] text-claude-ink-1">
              {steps[expandedIndex]}
            </div>
          )}
        </ClaudeCard>
      )}
    </div>
  );
}
