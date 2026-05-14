"use client";
import React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { usePoll } from "@/lib/monitor/usePoll";
import { MonitorGraph } from "./MonitorGraph";
import { ClaudeCard, ClaudeMetric, ClaudeBadge } from "./atoms";
import { useApp } from "@/lib/i18n";
import type { MonitorRunDetail } from "@/lib/monitor/types";

const STATUS_TONE: Record<string, 'accent' | 'ok' | 'err' | 'warn' | 'neutral'> = {
  running:   'accent',
  completed: 'ok',
  failed:    'err',
  suspended: 'warn',
  paused:    'warn',
};

// ── Timeline type chip config ──────────────────────────────────────

type ChipConfig = { bg: string; fg: string; label: string };

const TYPE_COLORS: Record<string, ChipConfig> = {
  event_received:   { bg: 'bg-claude-accent-bg', fg: 'text-claude-accent',  label: 'event ↓' },
  event_emitted:    { bg: 'bg-claude-accent-bg', fg: 'text-claude-accent',  label: 'event ↑' },
  agent_start:      { bg: 'bg-claude-panel',     fg: 'text-claude-ink-2',   label: 'start' },
  agent_complete:   { bg: 'bg-claude-ok/15',     fg: 'text-claude-ok',      label: 'done' },
  agent_error:      { bg: 'bg-claude-err/15',    fg: 'text-claude-err',     label: 'error' },
  anomaly:          { bg: 'bg-claude-warn/15',   fg: 'text-claude-warn',    label: 'anomaly' },
  tool:             { bg: 'bg-claude-warn/15',   fg: 'text-claude-warn',    label: 'tool' },
  decision:         { bg: 'bg-claude-panel',     fg: 'text-claude-ink-2',   label: 'decision' },
  hitl:             { bg: 'bg-claude-warn/15',   fg: 'text-claude-warn',    label: 'hitl' },
  'step.started':   { bg: 'bg-claude-panel',     fg: 'text-claude-ink-2',   label: 'step ▶' },
  'step.completed': { bg: 'bg-claude-ok/15',     fg: 'text-claude-ok',      label: 'step ✓' },
  'step.failed':    { bg: 'bg-claude-err/15',    fg: 'text-claude-err',     label: 'step ✗' },
  'step.retrying':  { bg: 'bg-claude-warn/15',   fg: 'text-claude-warn',    label: 'step ⟳' },
  'event.in':       { bg: 'bg-claude-accent-bg', fg: 'text-claude-accent',  label: 'event ↓' },
  'event.out':      { bg: 'bg-claude-accent-bg', fg: 'text-claude-accent',  label: 'event ↑' },
  info:             { bg: 'bg-claude-panel',     fg: 'text-claude-ink-3',   label: 'info' },
};

function getChip(type: string): ChipConfig {
  return TYPE_COLORS[type] ?? { bg: 'bg-claude-panel', fg: 'text-claude-ink-3', label: type };
}

// ── Unified timeline row type ──────────────────────────────────────

type TimelineEntry = {
  ts: string;        // ISO timestamp for sorting
  type: string;      // determines chip color
  agent: string;     // bold left element
  narrative: string;
  meta?: string;     // optional badge (e.g. "180 tokens")
  isFocused?: boolean;
};

function buildTimeline(data: MonitorRunDetail, focusAt: string | null): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  // Activity rows (already Chatbot-filtered by the API)
  for (const a of data.activity) {
    let meta: string | undefined;
    if (a.type === 'tool' && a.metadata && typeof a.metadata === 'object') {
      const m = a.metadata as Record<string, unknown>;
      const tokens = (m.tokens as number | undefined) ?? (m.total_tokens as number | undefined);
      const dur    = (m.durationMs as number | undefined);
      const parts: string[] = [];
      if (tokens) parts.push(`${tokens} tokens`);
      if (dur)    parts.push(`${(dur / 1000).toFixed(1)}s`);
      if (parts.length) meta = parts.join(', ');
    }
    entries.push({
      ts: a.ts,
      type: a.type,
      agent: a.agent,
      narrative: a.narrative,
      meta,
      isFocused: focusAt === a.ts,
    });
  }

  // WorkflowStep rows
  for (const s of (data.steps ?? [])) {
    const stepType =
      s.status === 'completed' ? 'step.completed' :
      s.status === 'failed'    ? 'step.failed' :
      s.status === 'retrying'  ? 'step.retrying' :
                                 'step.started';

    const narrative = s.stepName + (s.error ? `: ${s.error.slice(0, 80)}` : '');
    const meta = s.durationMs ? `${s.durationMs}ms` : undefined;

    entries.push({
      ts: s.startedAt,
      type: stepType,
      agent: s.nodeId,
      narrative,
      meta,
    });
  }

  // Event rows
  for (const e of data.events) {
    entries.push({
      ts: e.ts,
      type: 'event.in',
      agent: e.source,
      narrative: e.name,
    });
  }

  // Sort chronologically
  entries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  return entries;
}

// ── TimelineRow component ──────────────────────────────────────────

function TimelineRow({
  entry,
  rowRef,
}: {
  entry: TimelineEntry;
  rowRef?: React.Ref<HTMLLIElement>;
}) {
  const chip = getChip(entry.type);
  const timeStr = new Date(entry.ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <li
      ref={rowRef}
      className={
        "py-2 first:pt-0 last:pb-0 flex items-baseline gap-2 text-[12.5px] rounded " +
        (entry.isFocused ? "bg-claude-warn/10 " : "")
      }
    >
      {/* Time */}
      <span className="text-claude-ink-4 tabular-nums shrink-0 w-[58px]">
        {timeStr}
      </span>

      {/* Type chip */}
      <span className={`shrink-0 inline-block px-1.5 py-0.5 rounded text-[10.5px] font-medium ${chip.bg} ${chip.fg}`}>
        {chip.label}
      </span>

      {/* Agent name */}
      <span className="text-claude-ink-1 font-medium shrink-0">{entry.agent}</span>

      {/* Narrative */}
      <span className="text-claude-ink-3 truncate">{entry.narrative}</span>

      {/* Optional metadata badge */}
      {entry.meta && (
        <span className="shrink-0 ml-auto text-[11px] text-claude-ink-4 tabular-nums">{entry.meta}</span>
      )}
    </li>
  );
}

// ── Main component ─────────────────────────────────────────────────

export function RunDetailContent({ runId }: { runId: string }) {
  const { t } = useApp();
  const { data, error } = usePoll<MonitorRunDetail>(
    `/api/monitor/runs/${encodeURIComponent(runId)}`,
    4_000,
  );
  const [tab, setTab] = React.useState<'timeline' | 'events' | 'tokens' | 'hitl'>('timeline');
  const searchParams = useSearchParams();
  const focusAt = searchParams?.get('focus');
  const timelineRef = React.useRef<HTMLLIElement | null>(null);

  // Auto-switch to timeline tab when a focus anchor is present
  React.useEffect(() => {
    if (focusAt && tab !== 'timeline') setTab('timeline');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAt]);

  // Scroll the focused activity into view once data loads
  React.useEffect(() => {
    if (focusAt && timelineRef.current) {
      timelineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focusAt, data]);

  if (error && !data) {
    return (
      <div className="p-6 max-w-[1620px] mx-auto">
        <p className="text-claude-err mb-2">{t('monitor_run_failed_load')} {error}</p>
        <Link href="/monitor" className="text-claude-accent text-[12.5px]">
          {t('monitor_back_to_monitor')}
        </Link>
      </div>
    );
  }

  // Build the trail map for the graph
  const trailMap = new Map(
    (data?.trail ?? []).map((tr, i, arr) => {
      const current =
        data?.run.status === 'running' &&
        i === arr.length - 1 &&
        tr.result === 'pending';
      return [tr.nodeId, { result: tr.result, current }] as [
        string,
        { result: typeof tr.result; current: boolean },
      ];
    }),
  );

  const totalTokens = data
    ? Object.values(data.tokensByAgent).reduce((s, tk) => s + tk.total, 0)
    : 0;

  const failureCount = data ? data.trail.filter(tr => tr.result === 'failure').length : 0;

  // Build merged timeline
  const timelineEntries = data ? buildTimeline(data, focusAt ?? null) : [];

  // Tab labels via i18n
  const TAB_LABELS: Record<typeof tab, string> = {
    timeline: t('monitor_run_tab_timeline'),
    events:   t('monitor_run_tab_events'),
    tokens:   t('monitor_run_tab_tokens'),
    hitl:     t('monitor_run_tab_hitl'),
  };

  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      {/* Breadcrumb */}
      <div className="mb-4">
        <Link href="/monitor" className="text-claude-accent text-[12.5px] no-underline">
          {t('monitor_back_to_monitor')}
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
              <span>{t('monitor_run_started')} {new Date(data.run.startedAt).toLocaleString()}</span>
            </>
          )}
          {data?.run.completedAt && (
            <>
              <span>·</span>
              <span>{t('monitor_run_completed')} {new Date(data.run.completedAt).toLocaleString()}</span>
            </>
          )}
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <ClaudeMetric
          label={t('monitor_run_agents_touched')}
          value={data ? data.trail.length : '—'}
        />
        <ClaudeMetric
          label={t('monitor_run_tokens_used')}
          value={data ? totalTokens.toLocaleString() : '—'}
        />
        <ClaudeMetric
          label={t('monitor_run_failures')}
          value={data ? failureCount : '—'}
          emphasis={failureCount > 0 ? 'err' : 'normal'}
        />
        <ClaudeMetric
          label={t('monitor_run_hitl_tasks')}
          value={data ? data.hitl.length : '—'}
        />
      </div>

      {/* Trail graph */}
      <div className="mb-6">
        <MonitorGraph trail={trailMap} />
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0 mb-4 border-b border-claude-line">
        {(['timeline', 'events', 'tokens', 'hitl'] as const).map(tb => (
          <button
            key={tb}
            type="button"
            onClick={() => setTab(tb)}
            className={
              "px-4 py-2 text-[13px] transition-colors " +
              (tab === tb
                ? "text-claude-ink-1 border-b-2 border-claude-accent -mb-px"
                : "text-claude-ink-3 hover:text-claude-ink-1")
            }
          >
            {TAB_LABELS[tb]}
          </button>
        ))}
      </div>

      {/* Timeline tab — unified merged stream */}
      {tab === 'timeline' && (
        <ClaudeCard>
          <ul className="flex flex-col divide-y divide-claude-line">
            {timelineEntries.length === 0 ? (
              <li className="text-claude-ink-4 text-[12.5px]">
                {t('monitor_run_no_activity')}
              </li>
            ) : (
              timelineEntries.map((entry, i) => (
                <TimelineRow
                  key={`${entry.ts}-${entry.type}-${i}`}
                  entry={entry}
                  rowRef={entry.isFocused ? timelineRef : undefined}
                />
              ))
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
              <li className="text-claude-ink-4 text-[12.5px]">{t('monitor_run_no_events')}</li>
            )}
          </ul>
        </ClaudeCard>
      )}

      {/* Tokens tab */}
      {tab === 'tokens' && (
        <ClaudeCard>
          {Object.keys(data?.tokensByAgent ?? {}).length === 0 ? (
            <div className="text-claude-ink-4 text-[12.5px]">{t('monitor_run_no_tokens')}</div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr>
                  <th className="text-left py-1 text-claude-ink-4 font-normal">{t('monitor_run_col_agent')}</th>
                  <th className="text-right py-1 text-claude-ink-4 font-normal">{t('monitor_run_col_prompt')}</th>
                  <th className="text-right py-1 text-claude-ink-4 font-normal">{t('monitor_run_col_completion')}</th>
                  <th className="text-right py-1 text-claude-ink-4 font-normal">{t('monitor_run_col_total')}</th>
                  <th className="text-left py-1 pl-3 text-claude-ink-4 font-normal">{t('monitor_run_col_model')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data!.tokensByAgent).map(([agent, tk]) => (
                  <tr key={agent} className="border-t border-claude-line">
                    <td className="py-1 text-claude-ink-1">{agent}</td>
                    <td className="py-1 text-right tabular-nums text-claude-ink-2">
                      {tk.prompt.toLocaleString()}
                    </td>
                    <td className="py-1 text-right tabular-nums text-claude-ink-2">
                      {tk.completion.toLocaleString()}
                    </td>
                    <td className="py-1 text-right tabular-nums font-medium text-claude-ink-1">
                      {tk.total.toLocaleString()}
                    </td>
                    <td className="py-1 pl-3 text-claude-ink-3">{tk.model ?? '—'}</td>
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
            <div className="text-claude-ink-4 text-[12.5px]">{t('monitor_run_no_hitl')}</div>
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
