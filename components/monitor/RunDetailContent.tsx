"use client";
import React from "react";
import Link from "next/link";
import { usePoll } from "@/lib/monitor/usePoll";
import { MonitorGraph } from "./MonitorGraph";
import { ClaudeCard, ClaudeMetric, ClaudeBadge, ClaudeSectionTitle } from "./atoms";
import type { MonitorRunDetail } from "@/lib/monitor/types";

const STATUS_TONE: Record<string, 'accent' | 'ok' | 'err' | 'warn' | 'neutral'> = {
  running:   'accent',
  completed: 'ok',
  failed:    'err',
  suspended: 'warn',
  paused:    'warn',
};

export function RunDetailContent({ runId }: { runId: string }) {
  const { data, error } = usePoll<MonitorRunDetail>(
    `/api/monitor/runs/${encodeURIComponent(runId)}`,
    4_000,
  );
  const [tab, setTab] = React.useState<'timeline' | 'events' | 'tokens' | 'hitl'>('timeline');

  if (error && !data) {
    return (
      <div className="p-6 max-w-[1620px] mx-auto">
        <p className="text-claude-err mb-2">Failed to load run: {error}</p>
        <Link href="/monitor" className="text-claude-accent text-[12.5px]">
          ← Back to Monitor
        </Link>
      </div>
    );
  }

  // Build the trail map for the graph: nodeId → { result, current }
  const trailMap = new Map(
    (data?.trail ?? []).map((t, i, arr) => {
      // The "current" node is the last pending step while the run is still running
      const current =
        data?.run.status === 'running' &&
        i === arr.length - 1 &&
        t.result === 'pending';
      return [t.nodeId, { result: t.result, current }] as [
        string,
        { result: typeof t.result; current: boolean },
      ];
    }),
  );

  const totalTokens = data
    ? Object.values(data.tokensByAgent).reduce((s, t) => s + t.total, 0)
    : 0;

  const failureCount = data ? data.trail.filter(t => t.result === 'failure').length : 0;

  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      {/* Breadcrumb */}
      <div className="mb-4">
        <Link href="/monitor" className="text-claude-accent text-[12.5px] no-underline">
          ← Monitor
        </Link>
      </div>

      {/* Run header */}
      <div className="mb-4">
        <h1 className="text-[24px] font-medium leading-tight">
          {data?.run.triggerEvent ?? '—'}
        </h1>
        <div className="flex items-center gap-2 mt-1 text-[12.5px] text-claude-ink-3 flex-wrap">
          <code className="tabular-nums">{runId}</code>
          <span>·</span>
          {data && (
            <ClaudeBadge tone={STATUS_TONE[data.run.status] ?? 'neutral'}>
              {data.run.status}
            </ClaudeBadge>
          )}
          {data?.run.startedAt && (
            <>
              <span>·</span>
              <span>started {new Date(data.run.startedAt).toLocaleString()}</span>
            </>
          )}
          {data?.run.completedAt && (
            <>
              <span>·</span>
              <span>completed {new Date(data.run.completedAt).toLocaleString()}</span>
            </>
          )}
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <ClaudeMetric
          label="Agents touched"
          value={data ? data.trail.length : '—'}
        />
        <ClaudeMetric
          label="Tokens used"
          value={data ? totalTokens.toLocaleString() : '—'}
        />
        <ClaudeMetric
          label="Failures"
          value={data ? failureCount : '—'}
          emphasis={failureCount > 0 ? 'err' : 'normal'}
        />
        <ClaudeMetric
          label="HITL tasks"
          value={data ? data.hitl.length : '—'}
        />
      </div>

      {/* Trail graph */}
      <div className="mb-6">
        <MonitorGraph trail={trailMap} />
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0 mb-4 border-b border-claude-line">
        {(['timeline', 'events', 'tokens', 'hitl'] as const).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              "px-4 py-2 text-[13px] capitalize transition-colors " +
              (tab === t
                ? "text-claude-ink-1 border-b-2 border-claude-accent -mb-px"
                : "text-claude-ink-3 hover:text-claude-ink-1")
            }
          >
            {t}
          </button>
        ))}
      </div>

      {/* Timeline tab */}
      {tab === 'timeline' && (
        <ClaudeCard>
          <ul className="flex flex-col divide-y divide-claude-line">
            {(data?.activity ?? []).map((a, i) => (
              <li key={i} className="py-2 first:pt-0 last:pb-0 text-[12.5px]">
                <span className="text-claude-ink-4 tabular-nums mr-2">
                  {new Date(a.ts).toLocaleTimeString()}
                </span>
                <span className="text-claude-ink-1 font-medium">{a.agent}</span>
                <span className="text-claude-ink-3">
                  {' '}— {a.type}: {a.narrative}
                </span>
              </li>
            ))}
            {(!data || data.activity.length === 0) && (
              <li className="text-claude-ink-4 text-[12.5px]">No activity yet.</li>
            )}
          </ul>
        </ClaudeCard>
      )}

      {/* Events tab */}
      {tab === 'events' && (
        <ClaudeCard>
          <ul className="flex flex-col divide-y divide-claude-line">
            {(data?.events ?? []).map(e => (
              <li
                key={e.eventInstanceId ?? `${e.name}-${e.ts}`}
                className="py-2 text-[12.5px]"
              >
                <span className="text-claude-ink-4 tabular-nums mr-2">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>
                <code className="text-claude-ink-1">{e.name}</code>
                <span className="text-claude-ink-4 ml-2">{e.source}</span>
              </li>
            ))}
            {(!data || data.events.length === 0) && (
              <li className="text-claude-ink-4 text-[12.5px]">No events in this run&apos;s time window.</li>
            )}
          </ul>
        </ClaudeCard>
      )}

      {/* Tokens tab */}
      {tab === 'tokens' && (
        <ClaudeCard>
          {Object.keys(data?.tokensByAgent ?? {}).length === 0 ? (
            <div className="text-claude-ink-4 text-[12.5px]">No token usage recorded.</div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr>
                  <th className="text-left py-1 text-claude-ink-4 font-normal">Agent</th>
                  <th className="text-right py-1 text-claude-ink-4 font-normal">Prompt</th>
                  <th className="text-right py-1 text-claude-ink-4 font-normal">Completion</th>
                  <th className="text-right py-1 text-claude-ink-4 font-normal">Total</th>
                  <th className="text-left py-1 pl-3 text-claude-ink-4 font-normal">Model</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data!.tokensByAgent).map(([agent, t]) => (
                  <tr key={agent} className="border-t border-claude-line">
                    <td className="py-1 text-claude-ink-1">{agent}</td>
                    <td className="py-1 text-right tabular-nums text-claude-ink-2">
                      {t.prompt.toLocaleString()}
                    </td>
                    <td className="py-1 text-right tabular-nums text-claude-ink-2">
                      {t.completion.toLocaleString()}
                    </td>
                    <td className="py-1 text-right tabular-nums font-medium text-claude-ink-1">
                      {t.total.toLocaleString()}
                    </td>
                    <td className="py-1 pl-3 text-claude-ink-3">{t.model ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ClaudeCard>
      )}

      {/* HITL tab */}
      {tab === 'hitl' && (
        <ClaudeCard>
          {(data?.hitl ?? []).length === 0 ? (
            <div className="text-claude-ink-4 text-[12.5px]">No HITL tasks for this run.</div>
          ) : (
            <ul className="flex flex-col divide-y divide-claude-line">
              {data!.hitl.map(h => (
                <li key={h.taskId} className="py-2 text-[12.5px] flex items-center gap-2">
                  <ClaudeBadge tone={h.status === 'pending' ? 'warn' : 'ok'} size="xs">
                    {h.status}
                  </ClaudeBadge>
                  <span className="text-claude-ink-1">{h.title}</span>
                  <span className="text-claude-ink-4 ml-auto">
                    {new Date(h.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ClaudeCard>
      )}
    </div>
  );
}
