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

// ── Timeline filter bucket classification ─────────────────────────

type FilterBucket = 'all' | 'events' | 'steps' | 'tools' | 'errors';

const EVENT_TYPES = new Set(['event_received', 'event_emitted', 'event.in', 'event.out']);
const STEP_TYPES  = new Set(['step.started', 'step.completed', 'step.failed', 'step.retrying']);
const TOOL_TYPES  = new Set(['tool']);
const ERROR_TYPES = new Set(['agent_error', 'anomaly', 'step.failed']);

function classifyEntry(type: string): FilterBucket[] {
  const buckets: FilterBucket[] = ['all'];
  if (EVENT_TYPES.has(type)) buckets.push('events');
  if (STEP_TYPES.has(type))  buckets.push('steps');
  if (TOOL_TYPES.has(type))  buckets.push('tools');
  if (ERROR_TYPES.has(type)) buckets.push('errors');
  return buckets;
}

// ── Unified timeline row type ──────────────────────────────────────

type TimelineEntry = {
  key: string;
  ts: string;        // ISO timestamp for sorting
  type: string;      // determines chip color
  agent: string;     // bold left element
  narrative: string;
  meta?: string;     // optional badge (e.g. "180 tokens")
  metadata?: Record<string, unknown>;  // raw metadata for expansion
  isFocused?: boolean;
};

function hasExpandableMetadata(entry: TimelineEntry): boolean {
  if (!entry.metadata) return false;
  const keys = Object.keys(entry.metadata);
  return keys.length > 0;
}

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
      key: `activity-${a.ts}-${a.type}`,
      ts: a.ts,
      type: a.type,
      agent: a.agent,
      narrative: a.narrative,
      meta,
      metadata: a.metadata,
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
    const stepMeta: Record<string, unknown> = {};
    if (s.stepName)   stepMeta.stepName   = s.stepName;
    if (s.status)     stepMeta.status     = s.status;
    if (s.durationMs) stepMeta.durationMs = s.durationMs;
    if (s.error)      stepMeta.error      = s.error;

    entries.push({
      key: `step-${s.id}`,
      ts: s.startedAt,
      type: stepType,
      agent: s.nodeId,
      narrative,
      meta,
      metadata: Object.keys(stepMeta).length > 0 ? stepMeta : undefined,
    });
  }

  // Event rows
  for (const e of data.events) {
    entries.push({
      key: `event-${e.eventInstanceId ?? e.name}-${e.ts}`,
      ts: e.ts,
      type: 'event.in',
      agent: e.source,
      narrative: e.name,
      metadata: e.eventInstanceId ? { eventInstanceId: e.eventInstanceId, source: e.source } : undefined,
    });
  }

  // Sort chronologically
  entries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  return entries;
}

// ── Metadata expansion table ──────────────────────────────────────

function MetadataTable({ metadata }: { metadata: Record<string, unknown> }) {
  return (
    <div className="mt-1 mb-2 ml-[58px] pl-3 border-l-2 border-claude-accent/40 bg-claude-panel/30 rounded-r py-2 pr-3">
      <table className="text-[11.5px] w-full">
        <tbody>
          {Object.entries(metadata).map(([k, v]) => (
            <tr key={k}>
              <td className="text-claude-ink-4 pr-3 py-0.5 align-top whitespace-nowrap font-mono">{k}</td>
              <td className="text-claude-ink-2 py-0.5 break-all">
                {typeof v === 'object' && v !== null
                  ? JSON.stringify(v, null, 0)
                  : String(v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── TimelineRow component ──────────────────────────────────────────

function TimelineRow({
  entry,
  rowRef,
  expanded,
  onToggle,
}: {
  entry: TimelineEntry;
  rowRef?: React.Ref<HTMLLIElement>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const chip = getChip(entry.type);
  const canExpand = hasExpandableMetadata(entry);
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
        "first:pt-0 last:pb-0 rounded " +
        (entry.isFocused ? "bg-claude-warn/10 " : "")
      }
    >
      <div
        className={
          "py-2 flex items-baseline gap-2 text-[12.5px] " +
          (canExpand ? "cursor-pointer hover:bg-claude-panel/20 rounded " : "")
        }
        onClick={canExpand ? onToggle : undefined}
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

        {/* Expand toggle arrow */}
        {canExpand && (
          <span className={
            "shrink-0 text-[10px] text-claude-ink-4 transition-transform " +
            (expanded ? "rotate-180 inline-block" : "")
          }>
            ▾
          </span>
        )}
      </div>

      {/* Expansion panel */}
      {canExpand && expanded && entry.metadata && (
        <MetadataTable metadata={entry.metadata} />
      )}
    </li>
  );
}

// ── Timeline filter chips ──────────────────────────────────────────

function TimelineFilterChips({
  active,
  onChange,
  counts,
}: {
  active: FilterBucket;
  onChange: (b: FilterBucket) => void;
  counts: Record<FilterBucket, number>;
}) {
  const { t } = useApp();
  const BUCKETS: { key: FilterBucket; label: string }[] = [
    { key: 'all',    label: t('monitor_timeline_filter_all') },
    { key: 'events', label: t('monitor_timeline_filter_events') },
    { key: 'steps',  label: t('monitor_timeline_filter_steps') },
    { key: 'tools',  label: t('monitor_timeline_filter_tools') },
    { key: 'errors', label: t('monitor_timeline_filter_errors') },
  ];
  return (
    <div className="flex items-center gap-1.5 mb-3 flex-wrap">
      {BUCKETS.map(b => {
        const isActive = active === b.key;
        const count = counts[b.key];
        return (
          <button
            key={b.key}
            type="button"
            onClick={() => onChange(b.key)}
            className={
              "px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-colors " +
              (isActive
                ? "bg-claude-accent text-white"
                : "bg-claude-panel text-claude-ink-3 hover:text-claude-ink-1 hover:bg-claude-line")
            }
          >
            {b.label}
            {b.key !== 'all' && count > 0 && (
              <span className={"ml-1 " + (isActive ? "opacity-80" : "text-claude-ink-4")}>
                ({count})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────

function RunDetailSkeleton() {
  return (
    <div className="p-6 max-w-[1620px] mx-auto animate-pulse">
      <div className="mb-4 h-[14px] w-32 rounded bg-claude-line" />
      <div className="mb-2 h-[24px] w-64 rounded bg-claude-line" />
      <div className="mb-5 h-[14px] w-96 rounded bg-claude-line" />
      <div className="grid grid-cols-4 gap-3 mb-5">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="h-[56px] rounded bg-claude-panel border border-claude-line" />
        ))}
      </div>
      <div className="mb-6 h-[140px] rounded bg-claude-panel border border-claude-line" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map(i => (
          <div key={i} className="h-[36px] rounded bg-claude-panel border border-claude-line" />
        ))}
      </div>
    </div>
  );
}

// ── Not-found empty state ──────────────────────────────────────────

function RunNotFound({ runId }: { runId: string }) {
  const { t } = useApp();
  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      <div className="mb-4">
        <Link href="/monitor" className="text-claude-accent text-[12.5px] no-underline">
          {t('monitor_back_to_monitor')}
        </Link>
      </div>
      <div className="flex flex-col items-start gap-4 max-w-[480px] mt-8">
        <div className="text-[32px] text-claude-ink-4">↑</div>
        <div>
          <h1 className="text-[20px] font-medium mb-1">{t('monitor_run_not_found_title')}</h1>
          <code className="text-[12px] text-claude-ink-4 tabular-nums">{runId}</code>
        </div>
        <div className="text-[13px] text-claude-ink-3">
          <p className="mb-2">{t('monitor_run_not_found_causes')}</p>
          <ul className="list-disc pl-4 space-y-1">
            <li>{t('monitor_run_not_found_cause1')}</li>
            <li>{t('monitor_run_not_found_cause2')}</li>
          </ul>
        </div>
        <Link href="/monitor" className="text-claude-accent text-[13px] no-underline hover:underline">
          {t('monitor_back_to_monitor')}
        </Link>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────

export function RunDetailContent({ runId }: { runId: string }) {
  const { t } = useApp();
  const { data, error, httpStatus } = usePoll<MonitorRunDetail>(
    `/api/monitor/runs/${encodeURIComponent(runId)}`,
    4_000,
  );
  const [tab, setTab] = React.useState<'timeline' | 'events' | 'tokens' | 'hitl'>('timeline');
  const [timelineFilter, setTimelineFilter] = React.useState<FilterBucket>('all');
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);
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

  // Loading: no data and no error yet
  if (!data && !error) {
    return <RunDetailSkeleton />;
  }

  // Not found: 404 response
  if (httpStatus === 404 || (error?.startsWith('HTTP 404'))) {
    return <RunNotFound runId={runId} />;
  }

  // Other errors with no prior data: show generic error
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

  // ── Playback state ────────────────────────────────────────────
  const [playing, setPlaying] = React.useState(false);
  const [stepIndex, setStepIndex] = React.useState<number | null>(null); // null = show full trail
  const [speed, setSpeed] = React.useState(4); // default 4x

  const trailSteps = data?.trail ?? [];
  const totalSteps = trailSteps.length;

  // Advance step on a timer when playing
  React.useEffect(() => {
    if (!playing || stepIndex == null) return;
    if (stepIndex >= totalSteps - 1) {
      setPlaying(false);
      return;
    }
    const cur = trailSteps[stepIndex];
    const next = trailSteps[stepIndex + 1];
    const realGapMs = Math.max(
      0,
      new Date(next.enteredAt).getTime() - new Date(cur.enteredAt).getTime(),
    );
    const playGapMs = Math.min(2000, Math.max(300, realGapMs / speed));
    const id = setTimeout(() => setStepIndex(si => (si != null ? si + 1 : null)), playGapMs);
    return () => clearTimeout(id);
  }, [playing, stepIndex, totalSteps, speed, trailSteps]);

  const onPlay = () => {
    if (stepIndex == null || stepIndex >= totalSteps - 1) setStepIndex(0);
    setPlaying(true);
  };
  const onPause = () => setPlaying(false);
  const onReset = () => { setPlaying(false); setStepIndex(null); };

  // Build the visible trail map (respects stepIndex for playback)
  const visibleTrail = React.useMemo(() => {
    if (stepIndex == null) {
      // Full trail (default static view)
      return new Map(
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
    }
    // Playback: only reveal steps 0..stepIndex
    return new Map(
      trailSteps.slice(0, stepIndex + 1).map((tr, i, sliced) => {
        const isLast = i === sliced.length - 1;
        return [tr.nodeId, {
          result: (isLast && playing ? 'pending' : tr.result) as typeof tr.result,
          current: playing && isLast,
        }] as [string, { result: typeof tr.result; current: boolean }];
      }),
    );
  }, [trailSteps, stepIndex, playing, data]);

  const totalTokens = data
    ? Object.values(data.tokensByAgent).reduce((s, tk) => s + tk.total, 0)
    : 0;

  const failureCount = data ? data.trail.filter(tr => tr.result === 'failure').length : 0;

  // Build merged timeline
  const timelineEntries = data ? buildTimeline(data, focusAt ?? null) : [];

  // Compute per-bucket counts
  const bucketCounts: Record<FilterBucket, number> = {
    all: timelineEntries.length,
    events: 0,
    steps: 0,
    tools: 0,
    errors: 0,
  };
  for (const e of timelineEntries) {
    const buckets = classifyEntry(e.type);
    for (const b of buckets) {
      if (b !== 'all') bucketCounts[b]++;
    }
  }

  // Apply filter
  const filteredEntries = timelineFilter === 'all'
    ? timelineEntries
    : timelineEntries.filter(e => classifyEntry(e.type).includes(timelineFilter));

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
      <div className="mb-4 flex items-center gap-3">
        <Link href="/monitor" className="text-claude-accent text-[12.5px] no-underline">
          {t('monitor_back_to_monitor')}
        </Link>
        {/* Retrying badge — shown when polling returns an error but we still have data */}
        {error && data && (
          <ClaudeBadge tone="warn" size="xs">
            {t('monitor_run_retrying')}
          </ClaudeBadge>
        )}
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

      {/* Trail graph with playback controls */}
      <div className="mb-6">
        {/* Playback control bar */}
        {totalSteps > 0 && (
          <div className="mb-2 flex items-center gap-3 flex-wrap">
            {/* Play / Pause */}
            <button
              type="button"
              onClick={playing ? onPause : onPlay}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-claude-accent text-white text-[12.5px] font-medium hover:opacity-90 transition-opacity"
            >
              {playing ? (
                <>
                  <span>⏸</span>
                  <span>{t('monitor_playback_pause')}</span>
                </>
              ) : (
                <>
                  <span>▷</span>
                  <span>{t('monitor_playback_play')}</span>
                </>
              )}
            </button>

            {/* Speed selector */}
            <div className="flex items-center gap-1.5 text-[12px] text-claude-ink-3">
              <span>{t('monitor_playback_speed')}:</span>
              {([1, 4, 16] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSpeed(s)}
                  className={
                    "px-2 py-0.5 rounded text-[11.5px] font-medium transition-colors " +
                    (speed === s
                      ? "bg-claude-accent text-white"
                      : "bg-claude-panel text-claude-ink-3 hover:text-claude-ink-1")
                  }
                >
                  {s}x
                </button>
              ))}
            </div>

            {/* Reset */}
            <button
              type="button"
              onClick={onReset}
              className="px-2.5 py-1 rounded-lg bg-claude-panel text-claude-ink-3 text-[12px] hover:text-claude-ink-1 transition-colors"
            >
              ⏮ {t('monitor_playback_reset')}
            </button>

            {/* Step counter + timestamp */}
            {stepIndex != null && (
              <span className="ml-auto text-[12px] text-claude-ink-3 tabular-nums">
                {t('monitor_playback_step_of').split('/')[0]?.trim() || 'Step'} {stepIndex + 1}{' '}
                {t('monitor_playback_step_of').includes('/') ? '/' : t('monitor_playback_step_of')}{' '}
                {totalSteps}
                {trailSteps[stepIndex]?.enteredAt && (
                  <span className="ml-1 text-claude-ink-4">
                    · {new Date(trailSteps[stepIndex].enteredAt).toLocaleTimeString('en-US', {
                        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
                      })}
                  </span>
                )}
              </span>
            )}
          </div>
        )}

        <MonitorGraph trail={visibleTrail} />
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
        <>
          <TimelineFilterChips
            active={timelineFilter}
            onChange={(b) => { setTimelineFilter(b); setExpandedKey(null); }}
            counts={bucketCounts}
          />
          <ClaudeCard>
            <ul className="flex flex-col divide-y divide-claude-line">
              {filteredEntries.length === 0 ? (
                <li className="text-claude-ink-4 text-[12.5px]">
                  {t('monitor_run_no_activity')}
                </li>
              ) : (
                filteredEntries.map((entry) => (
                  <TimelineRow
                    key={entry.key}
                    entry={entry}
                    rowRef={entry.isFocused ? timelineRef : undefined}
                    expanded={expandedKey === entry.key}
                    onToggle={() =>
                      setExpandedKey(prev => prev === entry.key ? null : entry.key)
                    }
                  />
                ))
              )}
            </ul>
          </ClaudeCard>
        </>
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
