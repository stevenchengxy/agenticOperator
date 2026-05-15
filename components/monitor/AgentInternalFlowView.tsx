// Internal flow diagram for a single Inngest agent — horizontal pipeline.
//
// Used on /monitor/inngest/[slug] above the flow list. Lets operators understand
// the conceptual internal pipeline (with rule-check, EM audit, etc.) instead of
// just seeing aggregate run counts.
//
// For each step:
//   - Color-coded by kind (guard / fetch / compute / persist / audit / subsystem / emit)
//   - Click to expand description + external call info
//   - "actual ran" markers cross-checked against Inngest history(optional, future)

'use client';

import { useState } from 'react';
import { useApp } from '@/lib/i18n';
import { AGENT_INTERNAL_FLOWS, STEP_KIND_COLOR, type AgentInternalStep } from '@/lib/agent-internal-flow';

const KIND_LABEL_KEY: Record<AgentInternalStep['kind'], string> = {
  guard: 'monitor_step_kind_guard',
  fetch: 'monitor_step_kind_fetch',
  compute: 'monitor_step_kind_compute',
  persist: 'monitor_step_kind_persist',
  audit: 'monitor_step_kind_audit',
  subsystem: 'monitor_step_kind_subsystem',
  emit: 'monitor_step_kind_emit',
};

export function AgentInternalFlowView({ slug }: { slug: string }) {
  const { t } = useApp();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const flow = AGENT_INTERNAL_FLOWS[slug];

  if (!flow) {
    return null;
  }

  return (
    <div className="border border-line rounded-md bg-panel p-4 mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-[12px] uppercase tracking-wide text-ink-2 font-semibold">
            🔧 {t('monitor_internal_flow_heading')}
          </div>
          <div className="text-[11px] text-ink-4 mt-0.5">
            {t('monitor_internal_flow_hint')}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-ink-4">
          <span>{t('monitor_internal_flow_steps').replace('{n}', String(flow.steps.length))}</span>
          <span>·</span>
          <span>{t('monitor_internal_flow_inputs').replace('{n}', String(flow.inputs.length))}</span>
          <span>·</span>
          <span>{t('monitor_internal_flow_outputs').replace('{n}', String(flow.outputs.length))}</span>
        </div>
      </div>

      {/* I/O event bar */}
      <div className="flex items-center gap-3 mb-3 text-[11px]">
        <span className="text-ink-4 uppercase">{t('monitor_internal_flow_input_label')}</span>
        {flow.inputs.map((e) => (
          <span
            key={e}
            className="mono px-1.5 py-0.5 rounded-sm border border-accent text-accent bg-accent-bg/30"
          >
            {e}
          </span>
        ))}
        <span className="text-ink-4">→</span>
        <span className="text-ink-4 uppercase">{t('monitor_internal_flow_output_label')}</span>
        {flow.outputs.map((e) => (
          <span
            key={e}
            className="mono px-1.5 py-0.5 rounded-sm border border-ok text-ok bg-ok-bg/30"
          >
            {e}
          </span>
        ))}
      </div>

      {/* Pipeline (horizontal scroll on small screens) */}
      <div className="overflow-x-auto pb-2">
        <div className="flex items-stretch gap-1.5 min-w-fit">
          {flow.steps.map((step, idx) => {
            const isExpanded = expandedId === step.id;
            const colors = STEP_KIND_COLOR[step.kind];
            return (
              <div key={step.id} className="flex items-center shrink-0">
                <button
                  onClick={() => setExpandedId(isExpanded ? null : step.id)}
                  className={`relative shrink-0 w-[150px] h-[78px] text-left rounded-md border ${colors.border} ${colors.fill} hover:shadow-sm transition-all ${
                    isExpanded ? 'ring-2 ring-accent' : ''
                  } ${step.kind === 'subsystem' ? 'shadow-sm' : ''}`}
                >
                  <div className="p-2 h-full flex flex-col">
                    <div className="flex items-start gap-1 mb-0.5">
                      <span className="text-[11px] shrink-0">{colors.icon}</span>
                      <span className="text-[11.5px] font-semibold text-ink-1 leading-tight">
                        {step.label}
                      </span>
                    </div>
                    <span className="text-[9px] mono text-ink-4 truncate mt-auto">
                      {step.name}
                    </span>
                    <span className="text-[9px] uppercase text-ink-3 tracking-wide">
                      {t(KIND_LABEL_KEY[step.kind])}
                    </span>
                  </div>
                  {step.kind === 'subsystem' && (
                    <span className="absolute -top-1 -right-1 text-[8.5px] mono font-bold px-1 py-px rounded bg-warn text-white">
                      ★
                    </span>
                  )}
                </button>
                {idx < flow.steps.length - 1 && (
                  <span className="text-ink-3 mx-0.5 shrink-0">→</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Expanded step detail */}
      {expandedId && (() => {
        const step = flow.steps.find((s) => s.id === expandedId);
        if (!step) return null;
        const colors = STEP_KIND_COLOR[step.kind];
        return (
          <div className={`mt-3 p-3 rounded-md border ${colors.border} ${colors.fill}`}>
            <div className="flex items-start gap-2">
              <span className="text-[14px]">{colors.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[14px] font-semibold text-ink-1">{step.label}</span>
                  <span className="text-[9px] uppercase tracking-wide text-ink-3 px-1.5 py-0.5 rounded border border-line">
                    {t(KIND_LABEL_KEY[step.kind])}
                  </span>
                </div>
                <div className="text-[11px] mono text-ink-4 mb-1.5">{step.name}</div>
                <div className="text-[12px] text-ink-2 leading-relaxed whitespace-pre-wrap">
                  {step.description}
                </div>
                {step.externalCall && (
                  <div className="text-[11px] mt-2 flex items-center gap-1.5">
                    <span className="text-ink-4 uppercase">{t('monitor_internal_flow_external_call')}</span>
                    <span className="mono text-accent">{step.externalCall}</span>
                  </div>
                )}
                {step.note && (
                  <div className="text-[11px] mt-1.5 text-warn">⚠ {step.note}</div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
