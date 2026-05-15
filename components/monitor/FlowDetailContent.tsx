'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/i18n';
import { formatDateTime, formatTime, statusLabel } from './i18n-utils';
import { EvidenceTrail } from './EvidenceTrail';

type FlowDetail = {
  flowId: string;
  label: { candidateName?: string; jdTitle?: string; candidateId?: string; jrId?: string };
  runCount: number;
  runs: Array<{
    runId: string;
    eventName: string;
    eventId: string;
    eventPayload: Record<string, unknown> | null;
    status: string;
    startedAt: string;
    finishedAt?: string;
    durationMs: number | null;
    history: Array<{ type: string; stepName: string | null; attempt: number; createdAt: string }>;
    output: unknown;
    function: { name: string; slug: string } | null;
  }>;
};

export function FlowDetailContent({ flowIdEncoded }: { flowIdEncoded: string }) {
  const { t } = useApp();
  const flowId = decodeURIComponent(flowIdEncoded);
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/inngest-admin/flows/${encodeURIComponent(flowId)}`);
        const b = await r.json();
        if (!cancelled && b.runs) setDetail(b);
      } catch {
        /* soft */
      }
    }
    load();
    const t = setInterval(load, 6000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [flowId]);

  if (!detail) {
    return <div className="p-6 text-[12px] text-ink-3">{t('monitor_inngest_loading_flow').replace('{flowId}', flowId)}</div>;
  }

  const { label, runs } = detail;
  const kind = flowId.startsWith('upload:') ? 'upload' : flowId.startsWith('jr:') ? 'jr' : 'evt';
  const idValue = flowId.split(':').slice(1).join(':');
  const failedRuns = runs.filter((r) => r.status === 'Failed');

  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      <div className="mb-3">
        <Link href="/monitor?tab=agents" className="text-[12px] text-accent hover:underline">
          ← {t('monitor_inngest_back_agents_short')}
        </Link>
      </div>

      {/* Header */}
      <div className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.14em] text-ink-4">{t('monitor_flow_instance')}</div>
        <h1 className="text-[22px] font-medium leading-tight mt-1">
          {label.candidateName ?? label.jrId ?? idValue.slice(0, 24)}
          {label.jdTitle && <span className="text-ink-3"> → {label.jdTitle.slice(0, 40)}</span>}
        </h1>
        <div className="flex flex-wrap items-center gap-3 mt-2 text-[12px]">
          <span className="text-[10px] mono px-1.5 py-0.5 rounded-sm border border-line text-ink-3">
            {kind.toUpperCase()}
          </span>
          <span className="mono text-ink-4 truncate max-w-[400px]">{flowId}</span>
          {label.candidateId && (
            <span className="text-ink-3">candidate=<span className="mono text-ink-2">{label.candidateId}</span></span>
          )}
          {label.jrId && (
            <span className="text-ink-3">job_req=<span className="mono text-ink-2">{label.jrId}</span></span>
          )}
          <span className="text-ink-4">·</span>
          <span className="text-ink-3">{t('monitor_flow_runs').replace('{n}', String(runs.length))}</span>
          {failedRuns.length > 0 && (
            <span className="text-err">· {t('monitor_flow_failed_dlq').replace('{n}', String(failedRuns.length))}</span>
          )}
        </div>
      </div>

      {/* Timeline */}
      <h2 className="text-[14px] font-medium mb-3">{t('monitor_flow_timeline')}</h2>
      {runs.length === 0 ? (
        <div className="border border-dashed border-line rounded p-8 text-center text-[12px] text-ink-3">
          {t('monitor_flow_no_runs')}
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((r) => (
            <RunRow
              key={r.runId}
              run={r}
              expanded={expandedRunId === r.runId}
              onToggle={() => setExpandedRunId((cur) => (cur === r.runId ? null : r.runId))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: FlowDetail['runs'][0];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, lang } = useApp();
  const time = formatDateTime(run.startedAt, lang);
  const statusColor =
    run.status === 'Completed'
      ? 'border-ok bg-ok-bg/30'
      : run.status === 'Failed'
      ? 'border-err bg-err-bg/30'
      : run.status === 'Running'
      ? 'border-warn bg-warn-bg/30'
      : 'border-line';
  return (
    <div className={`border rounded-md ${statusColor} bg-surface`}>
      <button
        onClick={onToggle}
        className="w-full text-left p-3 flex items-center justify-between gap-3 hover:bg-surface-hover"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink-1">
              {run.function?.name ?? run.eventName}
            </span>
            <span className="text-[10px] mono text-ink-4">· {run.eventName}</span>
          </div>
          <div className="text-[10.5px] mono text-ink-4 mt-0.5">
            {time} · {run.durationMs != null ? `${run.durationMs}ms` : '—'} · run={run.runId.slice(0, 14)}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span
            className={`text-[11px] font-medium ${
              run.status === 'Completed'
                ? 'text-ok'
                : run.status === 'Failed'
                ? 'text-err'
                : 'text-warn'
            }`}
          >
            {statusLabel(run.status, t)}
          </span>
          <span className="text-ink-4">{expanded ? '▴' : '▾'}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-line p-3 space-y-3">
          {/* Step trace */}
          <div>
            <div className="text-[11px] uppercase text-ink-4 mb-1.5">{t('monitor_detail_step_trace')}</div>
            <div className="space-y-1">
              {run.history.map((h, i) => (
                <div key={i} className="text-[11px] flex items-baseline gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1 ${
                      h.type.includes('Completed')
                        ? 'bg-ok'
                        : h.type.includes('Failed') || h.type.includes('Errored')
                        ? 'bg-err'
                        : 'bg-warn'
                    }`}
                  />
                  <span className="text-ink-2 font-medium">{h.type}</span>
                  {h.stepName && <span className="text-ink-3">· {h.stepName}</span>}
                  {h.attempt > 0 && <span className="text-warn">· {t('monitor_timeline_retry')} {h.attempt}</span>}
                  <span className="text-[10px] mono text-ink-4 ml-auto">
                    {formatTime(h.createdAt, lang)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Input(event payload)*/}
          <details open className="text-[11px]">
            <summary className="cursor-pointer text-ink-3 uppercase">
              {t('monitor_detail_input_payload')}
            </summary>
            <pre className="mt-2 mono text-[10.5px] bg-panel border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
              {JSON.stringify(run.eventPayload, null, 2)}
            </pre>
          </details>

          {/* Output */}
          <details className="text-[11px]">
            <summary className="cursor-pointer text-ink-3 uppercase">{t('monitor_detail_output')}</summary>
            <pre className="mt-2 mono text-[10.5px] bg-panel border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
              {JSON.stringify(run.output, null, 2)}
            </pre>
          </details>

          {/* Evidence trail (RAAS calls + Allmeta writes captured in agent code) */}
          <div className="pt-2 border-t border-dashed border-line">
            <EvidenceTrail runId={run.runId} />
          </div>

          {/* Replay — works for ANY status (Completed / Failed / Running / Cancelled).
              Disabled if this run has no eventId (rare; only stub runs). */}
          <button
            disabled={!run.eventId}
            onClick={async () => {
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
            }}
            className="w-full text-[12px] py-1.5 rounded border border-accent text-accent hover:bg-accent-bg disabled:opacity-50"
            title={run.eventId ? `event: ${run.eventId}` : 'no eventId — cannot replay'}
          >
            ↺ {t('monitor_detail_retry_replay')}
          </button>
        </div>
      )}
    </div>
  );
}
