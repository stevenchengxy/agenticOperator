"use client";
import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePoll } from "@/lib/monitor/usePoll";
import { ClaudeCard, ClaudeMetric, ClaudeBadge, ClaudeSectionTitle } from "./atoms";
import { TokenChart } from "./TokenChart";
import { ErrorRateChart } from "./ErrorRateChart";
import type { MonitorAgentDetail } from "@/lib/monitor/types";

export function AgentDetailContent({ name }: { name: string }) {
  const router = useRouter();
  const { data, error } = usePoll<MonitorAgentDetail>(
    `/api/monitor/agents/${encodeURIComponent(name)}`,
    10_000,
  );
  const [tab, setTab] = React.useState<'episodes' | 'tokens' | 'errors' | 'config'>('episodes');

  if (error && !data) {
    return (
      <div className="p-6">
        <p className="text-claude-err">Failed to load agent: {error}</p>
        <Link href="/monitor" className="text-claude-accent">Back to Monitor</Link>
      </div>
    );
  }

  const tokensTotal   = data ? data.tokenSpend.reduce((s, b) => s + b.total, 0) : 0;
  const errorsTotal   = data ? data.errorRate.reduce((s, b) => s + b.failed, 0) : 0;
  const attemptsTotal = data ? data.errorRate.reduce((s, b) => s + b.total, 0) : 0;
  const successRate   = attemptsTotal > 0 ? 1 - errorsTotal / attemptsTotal : 1;

  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      <div className="mb-4">
        <Link href="/monitor" className="text-claude-accent text-[12.5px] no-underline">
          ← Monitor
        </Link>
      </div>

      <div className="mb-4">
        <h1 className="text-[24px] font-medium leading-tight">{data?.title ?? '—'}</h1>
        <div className="text-claude-ink-3 text-[12.5px] mt-1">{name}</div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <ClaudeMetric label="Tokens (24h)"  value={tokensTotal.toLocaleString()} />
        <ClaudeMetric
          label="Errors (24h)"
          value={errorsTotal}
          emphasis={errorsTotal > 0 ? 'err' : 'normal'}
        />
        <ClaudeMetric
          label="Success rate"
          value={`${(successRate * 100).toFixed(1)}%`}
          emphasis={successRate >= 0.95 ? 'ok' : 'warn'}
        />
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-2 mb-3 border-b border-claude-line">
        {(['episodes', 'tokens', 'errors', 'config'] as const).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              "px-3 py-2 text-[13px] " +
              (tab === t
                ? "text-claude-ink-1 border-b-2 border-claude-accent -mb-px"
                : "text-claude-ink-3 hover:text-claude-ink-1")
            }
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Episodes ─────────────────────────────────────────── */}
      {tab === 'episodes' && (
        <ClaudeCard>
          {(data?.recentEpisodes ?? []).length === 0 ? (
            <div className="text-claude-ink-4 text-[12.5px]">
              No episodes recorded for this agent. (AgentEpisode is currently unwritten on this branch.)
            </div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead className="text-claude-ink-4">
                <tr>
                  <th className="text-left py-1">Run</th>
                  <th className="text-left py-1">Client</th>
                  <th className="text-right py-1">Duration</th>
                  <th className="text-right py-1">Tokens</th>
                  <th className="text-right py-1">Score</th>
                  <th className="text-left py-1 pl-3">Model</th>
                  <th className="text-left py-1 pl-3">When</th>
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
          <ClaudeSectionTitle>24h hourly token usage</ClaudeSectionTitle>
          {data && <TokenChart data={data.tokenSpend} />}
        </ClaudeCard>
      )}

      {/* ── Errors ────────────────────────────────────────────── */}
      {tab === 'errors' && (
        <>
          <ClaudeCard className="mb-3">
            <ClaudeSectionTitle>24h hourly attempts vs failures</ClaudeSectionTitle>
            {data && <ErrorRateChart data={data.errorRate} />}
          </ClaudeCard>
          <ClaudeCard>
            <ClaudeSectionTitle>Recent errors</ClaudeSectionTitle>
            {(data?.recentErrors ?? []).length === 0 ? (
              <div className="text-claude-ink-4 text-[12.5px]">No errors in 24h.</div>
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
            <div className="text-claude-ink-4 text-[12.5px]">No AgentConfig row for this agent.</div>
          ) : (
            <dl className="grid grid-cols-2 gap-y-2 text-[12.5px]">
              <dt className="text-claude-ink-4">Enabled</dt>
              <dd>{data.config.enabled ? 'Yes' : 'No'}</dd>
              <dt className="text-claude-ink-4">Temperature</dt>
              <dd className="tabular-nums">{data.config.temperature ?? '—'}</dd>
              <dt className="text-claude-ink-4">Max retries</dt>
              <dd className="tabular-nums">{data.config.maxRetries ?? '—'}</dd>
              <dt className="text-claude-ink-4">Tier</dt>
              <dd>{data.config.tier ?? '—'}</dd>
              <dt className="text-claude-ink-4">Max output tokens</dt>
              <dd className="tabular-nums">{data.config.maxOutputTokens ?? '—'}</dd>
              <dt className="text-claude-ink-4">Prompt append</dt>
              <dd className="whitespace-pre-wrap">{data.config.promptAppend ?? '—'}</dd>
            </dl>
          )}
          <div className="mt-4 text-claude-ink-4 text-[11px]">
            Read-only. Editing AgentConfig is part of the Manage axis (separate spec).
          </div>
        </ClaudeCard>
      )}
    </div>
  );
}
