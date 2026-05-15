'use client';

import { useApp } from '@/lib/i18n';
import type { AgentFunction } from './WorkflowAgentsContent';

export function AgentCard({
  fn,
  runCount,
  successCount,
  failCount,
  selected,
  onClick,
  onToggle,
}: {
  fn: AgentFunction;
  runCount: number;
  successCount: number;
  failCount: number;
  selected: boolean;
  onClick: () => void;
  onToggle: (paused: boolean) => void;
  /** Reserved — re-enable send-test in a future iteration; currently disabled per UX feedback. */
  onSendTest?: () => void;
}) {
  const { t } = useApp();
  const successRate = runCount > 0 ? Math.round((successCount / runCount) * 100) : null;
  // Status bar:
  //   paused  → red  (agent is OFF, partner events will queue)
  //   active  → green (registered, healthy — individual run failures don't
  //              flip the whole agent to red)
  const statusBar = fn.paused ? 'bg-err' : 'bg-ok';

  return (
    <div
      className={`relative rounded-md border ${
        selected ? 'border-accent shadow-sm' : 'border-line'
      } bg-surface hover:border-ink-3 cursor-pointer transition-all`}
      onClick={onClick}
    >
      {/* status indicator bar(顶部细条)*/}
      <div className={`h-1 w-full rounded-t-md ${statusBar}`} />

      <div className="p-3">
        {/* Title + paused flag */}
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink-1 leading-tight">{fn.name}</div>
            <div className="text-[10.5px] mono text-ink-4 mt-0.5 truncate">{fn.slug}</div>
          </div>
          {fn.paused && (
            <span className="text-[10px] mono px-1.5 py-0.5 rounded bg-warn-bg text-warn shrink-0">
              {t('monitor_agent_card_paused')}
            </span>
          )}
        </div>

        {/* Triggers */}
        <div className="flex flex-wrap gap-1 mt-2 mb-2">
          {fn.triggers.map((t, i) => (
            <span
              key={i}
              className="text-[10px] mono px-1.5 py-0.5 rounded-sm border border-line text-ink-3"
            >
              {t.value}
            </span>
          ))}
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-4 gap-2 mt-3 text-center">
          <Metric label={t('monitor_metric_runs')} value={runCount} />
          <Metric label={t('monitor_metric_ok')} value={successCount} accent="ok" />
          <Metric label={t('monitor_metric_fail')} value={failCount} accent="err" />
          <Metric label={t('monitor_metric_rate')} value={successRate !== null ? `${successRate}%` : '—'} />
        </div>

        {/* Actions — 只保留 pause/resume(发送测试事件 临时移除)*/}
        <div
          className="mt-3 pt-3 border-t border-line"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(!fn.paused);
            }}
            className={`w-full text-[12px] py-1.5 rounded border ${
              fn.paused
                ? 'border-ok text-ok hover:bg-ok-bg'
                : 'border-warn text-warn hover:bg-warn-bg'
            }`}
          >
            {fn.paused ? `▶ ${t('monitor_agent_card_resume')}` : `⏸ ${t('monitor_agent_card_pause')}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: 'ok' | 'err';
}) {
  const color =
    accent === 'ok' ? 'text-ok' : accent === 'err' ? 'text-err' : 'text-ink-1';
  return (
    <div>
      <div className={`text-[14px] mono font-medium ${color}`}>{value}</div>
      <div className="text-[9.5px] text-ink-4 uppercase">{label}</div>
    </div>
  );
}
