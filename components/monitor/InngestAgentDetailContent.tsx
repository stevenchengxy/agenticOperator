'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/i18n';
import { formatDateTime, statusLabel } from './i18n-utils';
import { AgentInternalFlowView } from './AgentInternalFlowView';

type AgentDetail = {
  agent: {
    id: string;
    name: string;
    slug: string;
    triggers: Array<{ type: string; value: string }>;
    paused: boolean;
  };
  stats: { total: number; completed: number; failed: number; running: number; successRate: number | null };
  cachedSummary: string | null;
  flows: Array<{
    flowId: string;
    latestStartedAt: string;
    runCount: number;
    status: string;
    durationMs: number | null;
    label: { candidateName?: string; jdTitle?: string; candidateId?: string; jrId?: string };
    eventName: string;
    eventId: string;
    runs: Array<{ id: string; status: string; startedAt: string; durationMs: number | null }>;
  }>;
};

type SummaryResp = {
  text: string;
  model: string;
  durationMs: number;
  cached: boolean;
  generatedAt?: string;
  ageMs?: number;
  promptContextChars?: number;
  error?: string;
};

export function InngestAgentDetailContent({ slug }: { slug: string }) {
  const { t } = useApp();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [summary, setSummary] = useState<SummaryResp | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [regenBusy, setRegenBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);

  async function loadDetail() {
    try {
      const r = await fetch(`/api/inngest-admin/agents/${slug}`);
      const b = await r.json();
      if (b.agent) setDetail(b);
    } catch {
      /* soft */
    }
  }
  async function loadSummary() {
    setSummaryLoading(true);
    try {
      const r = await fetch(`/api/inngest-admin/agents/${slug}/summary`);
      const b = await r.json();
      setSummary(b);
    } catch {
      /* soft */
    }
    setSummaryLoading(false);
  }
  async function regenerateSummary() {
    setRegenBusy(true);
    try {
      const r = await fetch(`/api/inngest-admin/agents/${slug}/summary`, { method: 'POST' });
      const b = await r.json();
      setSummary(b);
    } catch {
      /* soft */
    }
    setRegenBusy(false);
  }
  async function togglePause() {
    if (!detail) return;
    setToggleBusy(true);
    await fetch(`/api/inngest-admin/functions/${slug}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: !detail.agent.paused }),
    });
    setToggleBusy(false);
    loadDetail();
  }

  useEffect(() => {
    loadDetail();
    loadSummary();
    const t = setInterval(loadDetail, 5000);
    return () => clearInterval(t);
  }, [slug]);

  if (!detail) {
    return <div className="p-6 text-[12px] text-ink-3">{t('monitor_inngest_loading_agent').replace('{slug}', slug)}</div>;
  }

  const { agent, stats, flows } = detail;

  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      {/* Back link */}
      <div className="mb-3">
        <Link href="/monitor?tab=agents" className="text-[12px] text-accent hover:underline">
          ← {t('monitor_inngest_back_agents')}
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-4">{t('monitor_inngest_agent')}</div>
          <div className="flex items-center gap-2 mt-1">
            <h1 className="text-[28px] font-medium leading-tight">{agent.name}</h1>
            {agent.paused ? (
              <span className="text-[10px] mono font-bold px-2 py-0.5 rounded bg-warn-bg text-warn">
                ⏸ {t('monitor_agent_card_paused')}
              </span>
            ) : (
              <span className="text-[10px] mono font-bold px-2 py-0.5 rounded bg-ok-bg text-ok">● {t('monitor_agent_card_live')}</span>
            )}
          </div>
          <div className="text-[11px] mono text-ink-4 mt-1">{agent.slug}</div>
          <div className="flex flex-wrap gap-1 mt-2">
            {agent.triggers.map((t) => (
              <span
                key={t.value}
                className="text-[10px] mono px-1.5 py-0.5 rounded-sm border border-line text-ink-3"
              >
                {t.value}
              </span>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={togglePause}
            disabled={toggleBusy}
            className={`text-[12px] px-3 py-1.5 rounded border ${
              agent.paused
                ? 'border-ok text-ok hover:bg-ok-bg'
                : 'border-warn text-warn hover:bg-warn-bg'
            } disabled:opacity-50`}
          >
            {agent.paused ? `▶ ${t('monitor_agent_card_resume')}` : `⏸ ${t('monitor_agent_card_pause')}`}
          </button>
          <Link
            href="/monitor?tab=topology"
            className="text-[12px] px-3 py-1.5 rounded border border-line text-ink-2 hover:bg-surface-hover"
          >
            ⤢ {t('monitor_inngest_topology_view')}
          </Link>
        </div>
      </div>

      {/* AI Summary */}
      <div className="border border-line rounded-md p-4 mb-6 bg-panel relative">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[16px]">✨</span>
            <span className="text-[12px] uppercase tracking-wide text-ink-2 font-semibold">
              {t('monitor_inngest_ai_summary')}
            </span>
            {summary?.model && summary.model !== 'static-fallback' ? (
              <span className="text-[10px] mono font-medium px-1.5 py-0.5 rounded bg-accent-bg text-accent border border-accent">
                ✓ LLM · {summary.model}
              </span>
            ) : summary?.model === 'static-fallback' ? (
              <span className="text-[10px] mono px-1.5 py-0.5 rounded border border-warn text-warn bg-warn-bg/40">
                ⚠ {t('monitor_inngest_static_fallback')}
              </span>
            ) : null}
            {summary && summary.durationMs > 0 && (
              <span className="text-[10px] mono text-ink-4">{summary.durationMs}ms</span>
            )}
            {summary?.cached && summary.ageMs != null && (
              <span className="text-[10px] mono text-ink-4">
                {t('monitor_inngest_cached').replace('{m}', String(Math.round(summary.ageMs / 60_000)))}
              </span>
            )}
            {summary?.promptContextChars != null && summary.promptContextChars > 0 && (
              <span className="text-[10px] mono text-ink-4" title={t('monitor_inngest_prompt_chars_title')}>
                {t('monitor_inngest_prompt_chars').replace('{n}', String(summary.promptContextChars))}
              </span>
            )}
          </div>
          <button
            onClick={regenerateSummary}
            disabled={regenBusy}
            className="text-[11px] text-accent hover:underline disabled:opacity-50 shrink-0"
          >
            {regenBusy ? t('monitor_inngest_generating') : `🔄 ${t('monitor_inngest_regenerate')}`}
          </button>
        </div>
        {summaryLoading && !summary && (
          <div className="text-[12px] text-ink-3">{t('monitor_inngest_summary_loading')}</div>
        )}
        {summary && (
          <div className="text-[13px] text-ink-1 leading-relaxed whitespace-pre-wrap">
            {summary.text}
          </div>
        )}
        {summary?.error && (
          <div className="text-[10.5px] mono text-err mt-2 px-2 py-1 bg-err-bg/30 rounded">
            {t('monitor_audit_error')} {summary.error}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-3 mb-6">
        <StatCard label={t('monitor_inngest_total_runs_24h')} value={stats.total} />
        <StatCard label={t('monitor_inngest_completed')} value={stats.completed} accent="ok" />
        <StatCard label={t('monitor_inngest_failed')} value={stats.failed} accent="err" />
        <StatCard label={t('monitor_inngest_running')} value={stats.running} accent="warn" />
        <StatCard label={t('monitor_inngest_success_rate')} value={stats.successRate !== null ? `${stats.successRate}%` : '—'} />
      </div>

      {/* ★ Internal pipeline diagram — shows the agent's internal steps (rule-check etc.) */}
      <AgentInternalFlowView slug={slug} />

      {/* Flows section */}
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[16px] font-medium">
          {t('monitor_inngest_flows')} <span className="text-ink-4">· {flows.length}</span>
        </h2>
        <div className="text-[11px] text-ink-4">
          {t('monitor_inngest_flows_hint')}
        </div>
      </div>

      {flows.length === 0 ? (
        <div className="border border-dashed border-line rounded p-8 text-center text-[12px] text-ink-3">
          {t('monitor_inngest_no_flows_24h')}
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {flows.map((f) => (
            <FlowCard key={f.flowId} flow={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: 'ok' | 'err' | 'warn';
}) {
  const color =
    accent === 'ok' ? 'text-ok' : accent === 'err' ? 'text-err' : accent === 'warn' ? 'text-warn' : 'text-ink-1';
  return (
    <div className="border border-line rounded p-3 bg-surface">
      <div className="text-[10px] text-ink-4 uppercase">{label}</div>
      <div className={`text-[22px] mono font-medium mt-1 ${color}`}>{value}</div>
    </div>
  );
}

function FlowCard({
  flow,
}: {
  flow: AgentDetail['flows'][0];
}) {
  const { t, lang } = useApp();
  const statusColor =
    flow.status === 'Completed'
      ? 'bg-ok'
      : flow.status === 'Failed'
      ? 'bg-err'
      : flow.status === 'Running'
      ? 'bg-warn'
      : 'bg-ink-4';
  const time = formatDateTime(flow.latestStartedAt, lang);
  const flowKind = flow.flowId.startsWith('upload:')
    ? 'upload'
    : flow.flowId.startsWith('jr:')
    ? 'jr'
    : 'evt';
  return (
    <Link
      href={`/monitor/flows/${encodeURIComponent(flow.flowId)}`}
      className="border border-line rounded-md bg-surface hover:border-ink-3 p-3 block transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`w-2 h-2 rounded-full ${statusColor} shrink-0`} />
            <span className="text-[10px] mono px-1.5 py-0.5 rounded-sm border border-line text-ink-4">
              {flowKind}
            </span>
            <span className="text-[10px] text-ink-4 truncate flex-1">
              {flow.flowId.split(':')[1]?.slice(0, 18)}...
            </span>
          </div>
          {(flow.label.candidateName || flow.label.jdTitle) && (
            <div className="text-[13px] text-ink-1 font-medium leading-tight">
              {flow.label.candidateName ?? `(${t('monitor_inngest_no_candidate')})`}
              {flow.label.jdTitle && (
                <span className="text-ink-3 font-normal"> → {flow.label.jdTitle.slice(0, 24)}</span>
              )}
            </div>
          )}
          <div className="text-[10px] text-ink-4 mt-1.5 mono">
            {time} · {t('monitor_flow_runs').replace('{n}', String(flow.runCount))}
            {flow.durationMs != null && ` · ${flow.durationMs}ms`}
          </div>
        </div>
        <span
          className={`text-[10px] mono font-medium ${
            flow.status === 'Completed'
              ? 'text-ok'
              : flow.status === 'Failed'
              ? 'text-err'
              : 'text-warn'
          }`}
        >
          {statusLabel(flow.status, t)}
        </span>
      </div>
    </Link>
  );
}
