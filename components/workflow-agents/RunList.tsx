'use client';

import { useApp } from '@/lib/i18n';
import { formatDateTime, statusLabel } from '@/components/monitor/i18n-utils';
import type { RunRow } from './WorkflowAgentsContent';

export function RunList({
  runs,
  onSelect,
}: {
  runs: RunRow[];
  onSelect: (runId: string) => void;
}) {
  const { t } = useApp();
  if (runs.length === 0) {
    return (
      <div className="text-[12px] text-ink-3 px-2 py-6 text-center border border-line border-dashed rounded">
        {t('monitor_runs_empty_24h')}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {runs.map((r) => (
        <RunRowItem key={r.id} run={r} onClick={() => onSelect(r.id)} />
      ))}
    </div>
  );
}

function RunRowItem({ run, onClick }: { run: RunRow; onClick: () => void }) {
  const { t, lang } = useApp();
  const statusColor =
    run.status === 'Completed'
      ? 'bg-ok'
      : run.status === 'Failed'
      ? 'bg-err'
      : run.status === 'Running'
      ? 'bg-warn'
      : 'bg-ink-4';
  const statusText =
    run.status === 'Completed'
      ? 'text-ok'
      : run.status === 'Failed'
      ? 'text-err'
      : run.status === 'Running'
      ? 'text-warn'
      : 'text-ink-3';
  const dur = run.durationMs != null ? `${run.durationMs}ms` : run.status === 'Running' ? t('status_running') : '—';
  const time = formatDateTime(run.startedAt, lang);
  const tokens = run.tokenUsage?.total ?? 0;

  async function rerun(e: React.MouseEvent) {
    e.stopPropagation();
    if (!run.eventId) {
      alert(t('monitor_detail_retry_failed').replace('{message}', 'no eventId on this run — cannot rerun'));
      return;
    }
    const r = await fetch('/api/inngest-admin/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: run.eventId }),
    });
    const b = await r.json();
    alert(
      b.ok
        ? t('monitor_detail_retry_success').replace('{id}', b.new_event_id)
        : t('monitor_detail_retry_failed').replace('{message}', b.message ?? b.error),
    );
  }

  return (
    <div className="w-full px-3 py-2 rounded border border-line bg-surface hover:border-ink-3 flex items-center gap-3">
      <button onClick={onClick} className="flex items-center gap-3 min-w-0 flex-1 text-left">
        <span className={`w-2 h-2 rounded-full ${statusColor} shrink-0`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-ink-1 font-medium">{run.function.name}</span>
            <span className="text-[10px] mono text-ink-4">· {run.eventName}</span>
          </div>
          <div className="text-[10.5px] mono text-ink-4 mt-0.5 truncate">
            {run.id} · {time}
          </div>
        </div>
        <div
          className="shrink-0 text-[10.5px] mono text-ink-3 text-right tabular-nums w-20"
          title={
            run.tokenUsage
              ? `${t('monitor_runs_tokens_prompt')}: ${run.tokenUsage.prompt} · ${t('monitor_runs_tokens_completion')}: ${run.tokenUsage.completion}`
              : ''
          }
        >
          {tokens > 0 ? `${formatTokens(tokens)} ${t('monitor_runs_tokens_unit')}` : '—'}
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-[11px] ${statusText} font-medium`}>{statusLabel(run.status, t)}</div>
          <div className="text-[10px] mono text-ink-4">{dur}</div>
        </div>
      </button>
      {/* Inline rerun — works for ANY status (Completed / Failed / Running / Cancelled).
          Disabled only when no eventId is associated with the run. */}
      <button
        type="button"
        onClick={rerun}
        disabled={!run.eventId}
        title={run.eventId ? `↺ 重跑(事件 ${run.eventId})` : '无 eventId,无法重跑'}
        className="shrink-0 text-[11px] px-2 py-1 rounded border border-accent text-accent hover:bg-accent-bg disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ↺
      </button>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k';
  return Math.round(n / 1000) + 'k';
}
