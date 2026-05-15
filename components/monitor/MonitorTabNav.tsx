// Tab nav for the unified Monitor dashboard.
//
// 5 tabs covering all observation needs:
//   - 拓扑 (default): topology with live overlay + failure/HITL side panels
//   - Agents: 3 real PRA agent cards + pause toggle
//   - Runs: real Inngest run list (filterable by function + status)
//   - Events: Inngest event firehose(★ 用于 RAAS 对接调试,看所有入站/出站事件 + payload)
//   - DLQ: failed runs + retry buttons

'use client';

import { useApp } from '@/lib/i18n';

export type MonitorTab = 'topology' | 'agents' | 'runs' | 'events' | 'dlq';

export function MonitorTabNav({
  tab,
  onChange,
  counts,
}: {
  tab: MonitorTab;
  onChange: (t: MonitorTab) => void;
  counts: {
    agents: number;
    runs: number;
    events: number;
    dlq: number;
  };
}) {
  const { t } = useApp();
  const tabs: Array<{ id: MonitorTab; label: string; count?: number; accent?: 'err' }> = [
    { id: 'topology', label: t('monitor_tab_topology') },
    { id: 'agents', label: t('monitor_tab_agents'), count: counts.agents },
    { id: 'runs', label: t('monitor_tab_runs'), count: counts.runs },
    { id: 'events', label: t('monitor_tab_events'), count: counts.events },
    { id: 'dlq', label: t('monitor_tab_dlq'), count: counts.dlq, accent: counts.dlq > 0 ? 'err' : undefined },
  ];
  return (
    <div className="flex items-center gap-0 border-b border-line mb-3 -mt-1">
      {tabs.map((t) => {
        const active = t.id === tab;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`relative px-4 py-2 text-[13px] font-medium transition-colors ${
              active
                ? 'text-ink-1'
                : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <span>{t.label}</span>
            {typeof t.count === 'number' && (
              <span
                className={`ml-1.5 text-[11px] mono font-medium ${
                  t.accent === 'err' ? 'text-err' : 'text-ink-4'
                }`}
              >
                {t.count}
              </span>
            )}
            {active && (
              <div className="absolute bottom-[-1px] left-0 right-0 h-[2px] bg-accent" />
            )}
          </button>
        );
      })}
    </div>
  );
}
