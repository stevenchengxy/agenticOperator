'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/lib/i18n';
import { formatDateTime, statusLabel } from '@/components/monitor/i18n-utils';
import { EvidenceTrail } from '@/components/monitor/EvidenceTrail';

type StepDetail = {
  name: string;
  status: string;
  durationMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  stepOp: string | null;
  stepID: string | null;
  attempts: number | null;
  output: unknown;
  input: unknown;
  error: { name: string; message: string; stack?: string } | null;
};

type RunDetail = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  output: unknown;
  function: { name: string; slug: string };
  steps: StepDetail[];
  event?: { id: string; name: string; payload?: string; createdAt?: string } | null;
  tokenUsage?: { prompt: number; completion: number; total: number };
};

export function RunDetailDrawer({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const { t, lang } = useApp();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/inngest-admin/runs/${runId}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setDetail(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  async function handleRetry() {
    if (!detail) return;
    if (!detail.event?.id) {
      alert(t('monitor_detail_retry_failed').replace('{message}', 'no eventId on this run — cannot replay'));
      return;
    }
    setRetrying(true);
    const res = await fetch('/api/inngest-admin/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: detail.event.id }),
    });
    const body = await res.json();
    setRetrying(false);
    alert(
      body.ok
        ? t('monitor_detail_retry_success').replace('{id}', body.new_event_id)
        : t('monitor_detail_retry_failed').replace('{message}', body.message ?? body.error),
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex justify-end"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[90vw] h-full bg-bg border-l border-line shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-line flex items-start justify-between">
          <div>
            <div className="text-[13px] text-ink-3">{t('monitor_detail_run')}</div>
            <div className="text-[15px] font-medium text-ink-1 mt-1">
              {detail?.function?.name ?? t('monitor_loading')}
            </div>
            <div className="text-[11px] mono text-ink-4 mt-1">{runId}</div>
          </div>
          <button
            onClick={onClose}
            className="text-ink-3 hover:text-ink-1 text-[20px] leading-none w-8 h-8 flex items-center justify-center"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading && <div className="text-[12px] text-ink-3">{t('monitor_loading')}</div>}
          {detail && (
            <>
              {/* Status + timing */}
              <div className="grid grid-cols-2 gap-2 text-[12px]">
                <Field label={t('monitor_detail_status')} value={statusLabel(detail.status, t)} highlight />
                <Field
                  label={t('monitor_detail_duration')}
                  value={
                    detail.finishedAt
                      ? `${new Date(detail.finishedAt).getTime() - new Date(detail.startedAt).getTime()}ms`
                      : '—'
                  }
                />
                <Field label={t('monitor_detail_started')} value={formatDateTime(detail.startedAt, lang)} />
                <Field
                  label={t('monitor_detail_finished')}
                  value={detail.finishedAt ? formatDateTime(detail.finishedAt, lang) : '—'}
                />
                <Field
                  label={t('monitor_detail_tokens')}
                  value={
                    detail.tokenUsage && detail.tokenUsage.total > 0
                      ? `${detail.tokenUsage.total.toLocaleString()} ${t('monitor_runs_tokens_unit')} (${t('monitor_runs_tokens_prompt')} ${detail.tokenUsage.prompt.toLocaleString()} · ${t('monitor_runs_tokens_completion')} ${detail.tokenUsage.completion.toLocaleString()})`
                      : '—'
                  }
                />
              </div>

              {/* Replay button — shown for ANY run (not only failed).
                  Replays by re-emitting the triggering event id. Disabled if
                  this run has no event id (rare — only happens for stub /
                  internally-created runs). */}
              <button
                onClick={handleRetry}
                disabled={retrying || !detail.event?.id}
                className="w-full py-2 rounded border border-accent text-accent hover:bg-accent-bg text-[12px] font-medium disabled:opacity-50"
                title={detail.event?.id ? `event ${detail.event.name}: ${detail.event.id}` : 'no eventId — cannot replay'}
              >
                {retrying ? t('monitor_run_retrying') : `↺ ${t('monitor_detail_retry_replay')}`}
              </button>

              {/* Steps · per-step output JSON (from V2 trace + outputID) */}
              <div>
                <h3 className="text-[12px] font-medium text-ink-2 mb-2">
                  {t('monitor_detail_step_trace')}
                  {detail.steps.length > 0 && (
                    <span className="text-ink-4 ml-1">· {detail.steps.length}</span>
                  )}
                </h3>
                {detail.steps.length === 0 ? (
                  <div className="text-[11px] text-ink-4 italic">
                    {t('monitor_loading')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {detail.steps.map((s, i) => (
                      <StepCard key={`${s.stepID ?? s.name}-${i}`} step={s} />
                    ))}
                  </div>
                )}
              </div>

              {/* Output — top-level function return value */}
              {detail.output != null && (
                <div>
                  <h3 className="text-[12px] font-medium text-ink-2 mb-2">{t('monitor_detail_output')}</h3>
                  <pre className="text-[10.5px] mono bg-surface border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                    {JSON.stringify(detail.output, null, 2)}
                  </pre>
                </div>
              )}

              {/* Evidence trail (RAAS calls + Allmeta writes captured in agent code) */}
              <div className="pt-2 border-t border-dashed border-line">
                <EvidenceTrail runId={runId} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <div className="text-[10px] text-ink-4 uppercase">{label}</div>
      <div className={`mt-0.5 ${highlight ? 'text-ink-1 font-medium' : 'text-ink-2'}`}>{value}</div>
    </div>
  );
}

function StepCard({ step }: { step: StepDetail }) {
  const { t } = useApp();
  const [expanded, setExpanded] = useState(true);

  const statusUpper = step.status.toUpperCase();
  const dotColor =
    statusUpper === 'COMPLETED' ? 'bg-ok'
    : statusUpper === 'FAILED' || statusUpper === 'CANCELLED' ? 'bg-err'
    : statusUpper === 'RUNNING' || statusUpper === 'WAITING' ? 'bg-warn'
    : 'bg-ink-4';
  const statusText =
    statusUpper === 'COMPLETED' ? 'text-ok'
    : statusUpper === 'FAILED' || statusUpper === 'CANCELLED' ? 'text-err'
    : statusUpper === 'RUNNING' || statusUpper === 'WAITING' ? 'text-warn'
    : 'text-ink-4';

  const hasBody = step.output != null || step.input != null || step.error != null;

  return (
    <div className="border border-line rounded bg-surface overflow-hidden">
      <button
        type="button"
        onClick={() => hasBody && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 ${hasBody ? 'hover:bg-surface-hover cursor-pointer' : 'cursor-default'}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor} shrink-0`} />
        {step.stepOp && (
          <span className="text-[9px] mono px-1 py-px rounded-sm border border-line text-ink-4 uppercase shrink-0">
            {step.stepOp.toLowerCase()}
          </span>
        )}
        <span className="text-[11px] mono text-ink-1 truncate flex-1 text-left">{step.name}</span>
        {step.attempts != null && step.attempts > 1 && (
          <span className="text-[10px] mono text-warn shrink-0">
            · {t('monitor_timeline_retry')} {step.attempts}
          </span>
        )}
        {step.durationMs != null && (
          <span className="text-[10px] mono text-ink-4 tabular-nums shrink-0">{step.durationMs}ms</span>
        )}
        <span className={`text-[10px] mono font-medium shrink-0 ${statusText}`}>{statusUpper}</span>
        {hasBody && (
          <span className={`text-[9px] text-ink-4 shrink-0 transition-transform ${expanded ? 'rotate-180 inline-block' : ''}`}>▾</span>
        )}
      </button>

      {expanded && hasBody && (
        <div className="border-t border-line bg-panel/40">
          {step.error && (
            <div className="text-[10.5px] mono text-err px-2.5 py-1.5 bg-err-bg/30 border-b border-line">
              <span className="font-medium">{step.error.name}:</span> {step.error.message}
              {step.error.stack && (
                <pre className="mt-1 text-[10px] opacity-80 whitespace-pre-wrap break-words">
                  {step.error.stack}
                </pre>
              )}
            </div>
          )}
          {step.input != null && (
            <details className="border-b border-line">
              <summary className="text-[10px] mono text-ink-4 px-2.5 py-1 cursor-pointer hover:bg-surface-hover">
                input
              </summary>
              <pre className="text-[10px] mono px-2.5 py-1.5 overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(step.input, null, 2)}
              </pre>
            </details>
          )}
          {step.output != null && (
            <pre className="text-[10.5px] mono px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-words">
              {typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
