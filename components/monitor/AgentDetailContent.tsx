"use client";
import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePoll } from "@/lib/monitor/usePoll";
import { ClaudeCard, ClaudeMetric, ClaudeBadge, ClaudeSectionTitle } from "./atoms";
import { TokenChart } from "./TokenChart";
import { ErrorRateChart } from "./ErrorRateChart";
import { MonitorGraph } from "./MonitorGraph";
import { InternalFlowDiagram } from "./InternalFlowDiagram";
import { nodeById } from "@/lib/workflow-graph-meta";
import { getAgentDescriptionFull } from "@/lib/monitor/agent-descriptions";
import { useApp } from "@/lib/i18n";
import { formatTime } from "./i18n-utils";
import type { MonitorAgentDetail, MonitorNodeAgg } from "@/lib/monitor/types";
import { AgentConfigEditor } from "./AgentConfigEditor";
import { HelpTip } from "@/components/shared/HelpTip";

export function AgentDetailContent({ name }: { name: string }) {
  const { t, lang } = useApp();
  const router = useRouter();
  const { data, error } = usePoll<MonitorAgentDetail>(
    `/api/monitor/agents/${encodeURIComponent(name)}`,
    10_000,
  );
  const [tab, setTab] = React.useState<'episodes' | 'tokens' | 'errors' | 'config' | 'events'>('episodes');

  if (error && !data) {
    return (
      <div className="p-6">
        <p className="text-claude-err">{t('monitor_agent_failed_load')} {error}</p>
        <Link href="/monitor" className="text-claude-accent">{t('monitor_back_to_monitor')}</Link>
      </div>
    );
  }

  const tokensTotal   = data ? data.tokenSpend.reduce((s, b) => s + b.total, 0) : 0;
  const errorsTotal   = data ? data.errorRate.reduce((s, b) => s + b.failed, 0) : 0;
  const attemptsTotal = data ? data.errorRate.reduce((s, b) => s + b.total, 0) : 0;
  const successRate   = attemptsTotal > 0 ? 1 - errorsTotal / attemptsTotal : 1;

  // Resolve the workflow node for this agent (name is node id)
  const node = nodeById(name);

  // Resolve the agent description for internal flow + description text
  const agentDesc = data ? getAgentDescriptionFull(data.title) : getAgentDescriptionFull(name);

  // Build nodeAggs from candidateDistribution for the workflow position graph
  const workflowNodeAggs: MonitorNodeAgg[] = React.useMemo(() => {
    if (!data?.candidateDistribution) return [];
    return data.candidateDistribution.map(entry => ({
      name: entry.nodeId,
      running: entry.activeCount,
      completedInWindow: entry.passedCount24h,
      failedInWindow: 0,
      hitlPending: 0,
      successRate1h: 1,
      queueDepth: 0,
      tokensInWindow: { prompt: 0, completion: 0, total: 0 },
      avgDurationMs: 0,
      status: entry.activeCount > 0 ? 'healthy' : (entry.passedCount24h > 0 ? 'idle' : 'idle') as MonitorNodeAgg['status'],
      pulse: entry.activeCount > 0,
    }));
  }, [data?.candidateDistribution]);

  const TAB_LABELS: Record<typeof tab, string> = {
    episodes: t('monitor_agent_tab_episodes'),
    tokens:   t('monitor_agent_tab_tokens'),
    errors:   t('monitor_agent_tab_errors'),
    config:   t('monitor_agent_tab_config'),
    events:   t('monitor_agent_tab_events'),
  };

  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      <div className="mb-4">
        <Link href="/monitor" className="text-claude-accent text-[12.5px] no-underline">
          {t('monitor_back_to_monitor')}
        </Link>
      </div>

      <div className="mb-4">
        <h1 className="text-[24px] font-medium leading-tight">{data?.title ?? '—'}</h1>
        <div className="text-claude-ink-3 text-[12.5px] mt-1">{name}</div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <ClaudeMetric label={t('monitor_agent_tokens_24h')}  value={tokensTotal.toLocaleString()} />
        <ClaudeMetric
          label={t('monitor_agent_errors_24h')}
          value={errorsTotal}
          emphasis={errorsTotal > 0 ? 'err' : 'normal'}
        />
        <ClaudeMetric
          label={t('monitor_agent_success_rate')}
          value={`${(successRate * 100).toFixed(1)}%`}
          emphasis={successRate >= 0.95 ? 'ok' : 'warn'}
        />
      </div>

      {/* ── Internal Flow ─────────────────────────────────────────── */}
      <ClaudeSectionTitle>
        <span className="inline-flex items-center gap-2">
          {t('monitor_internal_flow_title')}
          <HelpTip tip={agentDesc?.description ?? '—'} />
        </span>
      </ClaudeSectionTitle>
      <ClaudeCard className="mb-6">
        <InternalFlowDiagram desc={agentDesc} />
      </ClaudeCard>

      {/* ── Workflow Position ────────────────────────────────────── */}
      <ClaudeSectionTitle>
        <span className="inline-flex items-center gap-2">
          {t('monitor_workflow_position')}
          <HelpTip tip={t('monitor_workflow_position_desc')} />
        </span>
      </ClaudeSectionTitle>
      <ClaudeCard className="mb-6">
        <MonitorGraph
          nodeAggs={workflowNodeAggs}
          selectedNodeId={node?.id}
          graphHeight={480}
        />
      </ClaudeCard>

      {/* Tab bar */}
      <div className="flex items-center gap-2 mb-3 border-b border-claude-line">
        {(['episodes', 'tokens', 'errors', 'config', 'events'] as const).map(tb => (
          <button
            key={tb}
            type="button"
            onClick={() => setTab(tb)}
            className={
              "px-3 py-2 text-[13px] " +
              (tab === tb
                ? "text-claude-ink-1 border-b-2 border-claude-accent -mb-px"
                : "text-claude-ink-3 hover:text-claude-ink-1")
            }
          >
            {TAB_LABELS[tb]}
          </button>
        ))}
      </div>

      {/* ── Episodes ─────────────────────────────────────────── */}
      {tab === 'episodes' && (
        <ClaudeCard>
          {(data?.recentEpisodes ?? []).length === 0 ? (
            <div className="text-claude-ink-4 text-[12.5px]">
              {t('monitor_agent_episodes_empty')}
            </div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead className="text-claude-ink-4">
                <tr>
                  <th className="text-left py-1">{t('monitor_agent_col_run')}</th>
                  <th className="text-left py-1">{t('monitor_agent_col_client')}</th>
                  <th className="text-right py-1">{t('monitor_agent_col_duration')}</th>
                  <th className="text-right py-1">{t('monitor_agent_col_tokens')}</th>
                  <th className="text-right py-1">{t('monitor_agent_col_score')}</th>
                  <th className="text-left py-1 pl-3">{t('monitor_agent_col_model')}</th>
                  <th className="text-left py-1 pl-3">{t('monitor_agent_col_when')}</th>
                  <th className="text-right py-1 pl-3 w-[60px]">↺</th>
                </tr>
              </thead>
              <tbody>
                {data!.recentEpisodes.map(e => (
                  <EpisodeRow
                    key={e.id}
                    episode={e}
                    lang={lang}
                    onOpen={() => router.push(`/monitor/runs/${encodeURIComponent(e.runId)}`)}
                    t={t}
                  />
                ))}
              </tbody>
            </table>
          )}
        </ClaudeCard>
      )}

      {/* ── Tokens ────────────────────────────────────────────── */}
      {tab === 'tokens' && (
        <ClaudeCard>
          <ClaudeSectionTitle>{t('monitor_agent_tokens_chart_title')}</ClaudeSectionTitle>
          {data && <TokenChart data={data.tokenSpend} />}
        </ClaudeCard>
      )}

      {/* ── Errors ────────────────────────────────────────────── */}
      {tab === 'errors' && (
        <>
          <ClaudeCard className="mb-3">
            <ClaudeSectionTitle>{t('monitor_agent_errors_chart_title')}</ClaudeSectionTitle>
            {data && <ErrorRateChart data={data.errorRate} />}
          </ClaudeCard>
          <ClaudeCard>
            <ClaudeSectionTitle>{t('monitor_agent_errors_recent_title')}</ClaudeSectionTitle>
            {(data?.recentErrors ?? []).length === 0 ? (
              <div className="text-claude-ink-4 text-[12.5px]">{t('monitor_agent_no_errors')}</div>
            ) : (
              <ul className="flex flex-col divide-y divide-claude-line">
                {data!.recentErrors.map((e, i) => (
                  <li key={i} className="py-2 text-[12.5px]">
                    <Link
                      href={`/monitor/runs/${encodeURIComponent(e.runId)}`}
                      className="text-claude-ink-1 no-underline hover:underline"
                    >
                      <ClaudeBadge tone="err" size="xs">{t('monitor_timeline_filter_errors')}</ClaudeBadge>
                      <span className="ml-2 text-claude-ink-3">{e.narrative}</span>
                      <span className="ml-2 text-claude-ink-4 tabular-nums">
                        {formatTime(e.ts, lang)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </ClaudeCard>
        </>
      )}

      {/* ── Config (editable) ─────────────────────────────────── */}
      {tab === 'config' && (
        <ClaudeCard>
          <AgentConfigEditor
            agentName={name}
            initialConfig={data?.config ?? null}
          />
        </ClaudeCard>
      )}

      {/* ── Events ────────────────────────────────────────────── */}
      {tab === 'events' && (
        <ClaudeCard>
          {(data?.recentEventActivity ?? []).length === 0 ? (
            <div className="text-claude-ink-4 text-[12.5px]">
              {t('agent_no_events')}
            </div>
          ) : (
            <ul className="space-y-2">
              {data!.recentEventActivity.map((ev, i) => (
                <li
                  key={i}
                  className="flex items-center gap-3 text-[12.5px] border-b border-claude-line pb-2 last:border-b-0"
                >
                  <ClaudeBadge
                    tone={ev.type === 'event_emitted' ? 'accent' : 'neutral'}
                    size="xs"
                  >
                    {ev.type === 'event_emitted' ? '↑ emit' : '↓ recv'}
                  </ClaudeBadge>
                  {ev.eventName ? (
                    <Link
                      href={`/events/${encodeURIComponent(ev.eventName)}`}
                      className="font-mono text-claude-accent no-underline hover:underline"
                    >
                      {ev.eventName}
                    </Link>
                  ) : (
                    <span className="font-mono text-claude-ink-3">—</span>
                  )}
                  <span className="text-claude-ink-3 flex-1 truncate">{ev.narrative}</span>
                  <span className="text-claude-ink-4 tabular-nums text-[10.5px]">
                    {formatTime(ev.ts, lang)}
                  </span>
                  {ev.runId && (
                    <Link
                      href={`/monitor/runs/${encodeURIComponent(ev.runId)}`}
                      className="text-claude-accent text-[11px] no-underline hover:underline"
                    >
                      {t('monitor_agent_col_run')} →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </ClaudeCard>
      )}
    </div>
  );
}

// ── Episode row with inline rerun (重新触发) ───────────────────────────
// Episodes 表里每行加 ↺ 重跑按钮.  AgentEpisode.runId 是 Inngest run id;
// 没有 eventId,所以 click → fetch /api/inngest-admin/runs/{runId} 拿 event.id
// → POST /api/inngest-admin/replay.
function EpisodeRow({
  episode,
  lang,
  onOpen,
  t,
}: {
  episode: MonitorAgentDetail['recentEpisodes'][number];
  lang: 'zh' | 'en';
  onOpen: () => void;
  t: (k: string) => string;
}) {
  const [rerunning, setRerunning] = React.useState(false);

  async function rerun(e: React.MouseEvent) {
    e.stopPropagation();
    setRerunning(true);
    try {
      const r1 = await fetch(`/api/inngest-admin/runs/${encodeURIComponent(episode.runId)}`);
      const d = await r1.json();
      const eventId = d?.event?.id as string | undefined;
      if (!eventId) {
        alert(t('monitor_detail_retry_failed').replace('{message}', 'no eventId on this run — cannot rerun'));
        return;
      }
      const r2 = await fetch('/api/inngest-admin/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId }),
      });
      const b = await r2.json();
      alert(
        b.ok
          ? t('monitor_detail_retry_success').replace('{id}', b.new_event_id)
          : t('monitor_detail_retry_failed').replace('{message}', b.message ?? b.error),
      );
    } catch (err) {
      alert(t('monitor_detail_retry_failed').replace('{message}', (err as Error).message));
    } finally {
      setRerunning(false);
    }
  }

  return (
    <tr
      className="border-t border-claude-line cursor-pointer hover:bg-claude-panel"
      onClick={onOpen}
    >
      <td className="py-1">
        <span className="text-claude-accent">{episode.runId.slice(0, 8)}…</span>
      </td>
      <td className="py-1">{episode.clientId ?? '—'}</td>
      <td className="py-1 text-right tabular-nums">{episode.durationMs}ms</td>
      <td className="py-1 text-right tabular-nums">{episode.tokenUsage.total.toLocaleString()}</td>
      <td className="py-1 text-right tabular-nums">{episode.judgeScore?.toFixed(2) ?? '—'}</td>
      <td className="py-1 pl-3 text-claude-ink-3">{episode.modelUsed ?? '—'}</td>
      <td className="py-1 pl-3 text-claude-ink-3 tabular-nums">{formatTime(episode.createdAt, lang)}</td>
      <td className="py-1 pl-3 text-right">
        <button
          type="button"
          onClick={rerun}
          disabled={rerunning}
          title={t('mox_rerun_run_title').replace('{run}', episode.runId.slice(0, 8) + '…')}
          className="text-[11px] px-1.5 py-0.5 rounded border border-claude-accent text-claude-accent hover:bg-claude-accent-bg disabled:opacity-40 disabled:cursor-not-allowed leading-none"
        >
          {rerunning ? '⏳' : '↺'}
        </button>
      </td>
    </tr>
  );
}
