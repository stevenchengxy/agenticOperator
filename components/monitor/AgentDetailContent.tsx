"use client";
import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePoll } from "@/lib/monitor/usePoll";
import { ClaudeCard, ClaudeMetric, ClaudeBadge, ClaudeSectionTitle } from "./atoms";
import { TokenChart } from "./TokenChart";
import { ErrorRateChart } from "./ErrorRateChart";
import { MonitorGraph } from "./MonitorGraph";
import { nodeById } from "@/lib/workflow-graph-meta";
import { useApp } from "@/lib/i18n";
import type { MonitorAgentDetail, MonitorNodeAgg } from "@/lib/monitor/types";

export function AgentDetailContent({ name }: { name: string }) {
  const { t } = useApp();
  const router = useRouter();
  const { data, error } = usePoll<MonitorAgentDetail>(
    `/api/monitor/agents/${encodeURIComponent(name)}`,
    10_000,
  );
  const [tab, setTab] = React.useState<'episodes' | 'tokens' | 'errors' | 'config'>('episodes');

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

      {/* ── Workflow Position ────────────────────────────────────── */}
      <ClaudeSectionTitle>{t('monitor_workflow_position')}</ClaudeSectionTitle>
      <ClaudeCard className="mb-6">
        <p className="text-claude-ink-3 text-[12.5px] mb-3">
          {t('monitor_workflow_position_desc')}
        </p>
        <MonitorGraph
          nodeAggs={workflowNodeAggs}
          selectedNodeId={node?.id}
          graphHeight={480}
        />
      </ClaudeCard>

      {/* Tab bar */}
      <div className="flex items-center gap-2 mb-3 border-b border-claude-line">
        {(['episodes', 'tokens', 'errors', 'config'] as const).map(tb => (
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
                </tr>
              </thead>
              <tbody>
                {data!.recentEpisodes.map(e => (
                  <tr
                    key={e.id}
                    className="border-t border-claude-line cursor-pointer hover:bg-claude-panel"
                    onClick={() => router.push(`/monitor/runs/${encodeURIComponent(e.runId)}`)}
                  >
                    <td className="py-1">
                      <span className="text-claude-accent">{e.runId.slice(0, 8)}…</span>
                    </td>
                    <td className="py-1">{e.clientId ?? '—'}</td>
                    <td className="py-1 text-right tabular-nums">{e.durationMs}ms</td>
                    <td className="py-1 text-right tabular-nums">{e.tokenUsage.total.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums">{e.judgeScore?.toFixed(2) ?? '—'}</td>
                    <td className="py-1 pl-3 text-claude-ink-3">{e.modelUsed ?? '—'}</td>
                    <td className="py-1 pl-3 text-claude-ink-3 tabular-nums">{new Date(e.createdAt).toLocaleTimeString()}</td>
                  </tr>
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
                      <ClaudeBadge tone="err" size="xs">error</ClaudeBadge>
                      <span className="ml-2 text-claude-ink-3">{e.narrative}</span>
                      <span className="ml-2 text-claude-ink-4 tabular-nums">
                        {new Date(e.ts).toLocaleTimeString()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </ClaudeCard>
        </>
      )}

      {/* ── Config (read-only) ────────────────────────────────── */}
      {tab === 'config' && (
        <ClaudeCard>
          {!data?.config ? (
            <div className="text-claude-ink-4 text-[12.5px]">{t('monitor_agent_config_empty')}</div>
          ) : (
            <dl className="grid grid-cols-2 gap-y-2 text-[12.5px]">
              <dt className="text-claude-ink-4">{t('monitor_agent_config_enabled')}</dt>
              <dd>{data.config.enabled ? 'Yes' : 'No'}</dd>
              <dt className="text-claude-ink-4">{t('monitor_agent_config_temperature')}</dt>
              <dd className="tabular-nums">{data.config.temperature ?? '—'}</dd>
              <dt className="text-claude-ink-4">{t('monitor_agent_config_max_retries')}</dt>
              <dd className="tabular-nums">{data.config.maxRetries ?? '—'}</dd>
              <dt className="text-claude-ink-4">{t('monitor_agent_config_tier')}</dt>
              <dd>{data.config.tier ?? '—'}</dd>
              <dt className="text-claude-ink-4">{t('monitor_agent_config_max_output')}</dt>
              <dd className="tabular-nums">{data.config.maxOutputTokens ?? '—'}</dd>
              <dt className="text-claude-ink-4">{t('monitor_agent_config_prompt_append')}</dt>
              <dd className="whitespace-pre-wrap">{data.config.promptAppend ?? '—'}</dd>
            </dl>
          )}
          <div className="mt-4 text-claude-ink-4 text-[11px]">
            {t('monitor_agent_config_readonly')}
          </div>
        </ClaudeCard>
      )}
    </div>
  );
}
