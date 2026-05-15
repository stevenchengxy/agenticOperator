// Embedded in /monitor 'Runs' tab — real Inngest run list (filterable).
//
// Click a run row → opens RunDetailDrawer (existing component) for step trace + retry.

'use client';

import { useEffect, useState } from 'react';
import { RunList } from '@/components/workflow-agents/RunList';
import { RunDetailDrawer } from '@/components/workflow-agents/RunDetailDrawer';
import { useApp } from '@/lib/i18n';
import { statusLabel } from './i18n-utils';
import type { AgentFunction, RunRow } from '@/components/workflow-agents/WorkflowAgentsContent';

const REFRESH_MS = 5000;

export function InngestRunsTab() {
  const { t } = useApp();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [functions, setFunctions] = useState<AgentFunction[]>([]);
  const [filterSlug, setFilterSlug] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  async function load() {
    try {
      const url = filterSlug
        ? `/api/inngest-admin/runs?fn=${encodeURIComponent(filterSlug)}&limit=100`
        : `/api/inngest-admin/runs?limit=100`;
      const [r, fn] = await Promise.all([
        fetch(url).then((res) => res.json()),
        fetch('/api/inngest-admin/functions').then((res) => res.json()),
      ]);
      setRuns(r.runs ?? []);
      setFunctions(fn.functions ?? []);
    } catch {
      /* soft fail */
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [filterSlug]);

  const filtered = filterStatus ? runs.filter((r) => r.status === filterStatus) : runs;

  return (
    <div>
      {/* Filter chip row */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-ink-3 uppercase">{t('monitor_runs_filter_agent')}</span>
          <button
            onClick={() => setFilterSlug(null)}
            className={`text-[11px] px-2 py-1 rounded border ${
              !filterSlug
                ? 'bg-accent-bg border-accent text-accent'
                : 'border-line text-ink-2 hover:bg-surface-hover'
            }`}
          >
            {t('monitor_filter_all')}
          </button>
          {functions.map((fn) => {
            const labelKey =
              fn.slug === 'agentic-operator-main-create-jd-agent'
                ? 'monitor_runs_agent_create_jd'
                : fn.slug === 'agentic-operator-main-resume-parser-agent'
                  ? 'monitor_runs_agent_resume_parser'
                  : fn.slug === 'agentic-operator-main-match-resume-agent'
                    ? 'monitor_runs_agent_match_resume'
                    : null;
            const short = labelKey ? t(labelKey) : fn.name;
            return (
              <button
                key={fn.slug}
                onClick={() => setFilterSlug(fn.slug)}
                className={`text-[11px] px-2 py-1 rounded border ${
                  filterSlug === fn.slug
                    ? 'bg-accent-bg border-accent text-accent'
                    : 'border-line text-ink-2 hover:bg-surface-hover'
                }`}
                title={fn.slug}
              >
                {short}
              </button>
            );
          })}
        </div>
        <div className="w-px h-4 bg-line" />
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-ink-3 uppercase">{t('monitor_runs_filter_status')}</span>
          {['All', 'Completed', 'Failed', 'Running'].map((s) => {
            const active = (s === 'All' && !filterStatus) || filterStatus === s;
            return (
              <button
                key={s}
                onClick={() => setFilterStatus(s === 'All' ? null : s)}
                className={`text-[11px] px-2 py-1 rounded border ${
                  active
                    ? 'bg-accent-bg border-accent text-accent'
                    : 'border-line text-ink-2 hover:bg-surface-hover'
                }`}
            >
                {s === 'All' ? t('monitor_filter_all') : statusLabel(s, t)}
              </button>
            );
          })}
        </div>
        <span className="ml-auto text-[11px] text-ink-4 mono">
          {t('monitor_runs_count').replace('{n}', String(filtered.length))}
        </span>
      </div>

      <RunList runs={filtered} onSelect={setSelectedRunId} />

      {selectedRunId && (
        <RunDetailDrawer runId={selectedRunId} onClose={() => setSelectedRunId(null)} />
      )}
    </div>
  );
}
