"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeSectionTitle, ClaudeBadge } from "./atoms";
import { useApp } from "@/lib/i18n";
import { formatTime } from "./i18n-utils";
import type { MonitorFailureDetailResponse } from "@/lib/monitor/types";

export function FailureDetailContent({ runId }: { runId: string }) {
  const { t, lang } = useApp();
  const [data, setData] = React.useState<MonitorFailureDetailResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/monitor/failures/${encodeURIComponent(runId)}`, { signal: ac.signal })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: MonitorFailureDetailResponse) => {
        if (!ac.signal.aborted) setData(j);
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        if (!ac.signal.aborted) setError(e.message);
      });
    return () => ac.abort();
  }, [runId]);
  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="mb-4">
        <Link href={`/monitor/runs/${runId}`} className="text-claude-accent text-[12.5px] no-underline">
          {t('monitor_failure_back_to_run')} {runId.slice(0, 8)}
        </Link>
      </div>
      <h1 className="text-[24px] font-medium mb-4">{t('monitor_failure_title')}</h1>
      {error && <p className="text-claude-err">{error}</p>}
      {data && (
        <>
          {data.primaryFailure && (
            <ClaudeCard className="mb-3 border-claude-err/30 bg-claude-err/5">
              <ClaudeSectionTitle>{t('monitor_failure_primary_cause')}</ClaudeSectionTitle>
              <div className="flex items-center gap-2 mb-2 flex-wrap text-[12px]">
                <ClaudeBadge tone={data.primaryFailure.failure.retryable ? 'warn' : 'err'} size="xs">
                  {data.primaryFailure.failure.retryable ? t('monitor_run_failure_retryable') : t('monitor_run_failure_action')}
                </ClaudeBadge>
                <ClaudeBadge tone="neutral" size="xs">
                  {data.primaryFailure.failure.component}/{data.primaryFailure.failure.reason}
                </ClaudeBadge>
                <span className="text-claude-ink-4 tabular-nums">
                  {formatTime(data.primaryFailure.ts, lang)}
                </span>
              </div>
              <div className="text-[14px] text-claude-ink-1">{data.primaryFailure.failure.summary}</div>
              <div className="text-[12px] text-claude-ink-3 mt-1 break-words">
                {data.primaryFailure.failure.detail ?? data.primaryFailure.message}
              </div>
            </ClaudeCard>
          )}
          <ClaudeCard className="mb-3">
            <ClaudeSectionTitle>{t('monitor_failure_failed_steps')}</ClaudeSectionTitle>
            {data.steps.length === 0 ? (
              <div className="text-claude-ink-4 text-[12.5px]">{t('monitor_failure_no_failed_steps')}</div>
            ) : (
              <ul className="flex flex-col divide-y divide-claude-line">
                {data.steps.map((s: MonitorFailureDetailResponse['steps'][number]) => (
                  <li key={s.id} className="py-2 text-[12.5px]">
                    <div className="flex items-center gap-2">
                      <ClaudeBadge tone="err" size="xs">{s.nodeId}</ClaudeBadge>
                      <span className="text-claude-ink-1 font-medium">{s.stepName}</span>
                    </div>
                    {s.error && (
                      <pre className="bg-claude-panel rounded p-2 mt-1 text-[11.5px] overflow-auto whitespace-pre-wrap">{s.error}</pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </ClaudeCard>
          <ClaudeCard className="mb-3">
            <ClaudeSectionTitle>{t('monitor_failure_retry_history')}</ClaudeSectionTitle>
            {data.retries.length === 0 ? (
              <div className="text-claude-ink-4 text-[12.5px]">{t('monitor_failure_no_retries')}</div>
            ) : (
              <ul className="text-[12.5px]">
                {data.retries.map((a: MonitorFailureDetailResponse['retries'][number]) => (
                  <li key={a.id}>
                    <span className="text-claude-ink-4 tabular-nums mr-2">{formatTime(a.createdAt, lang)}</span>
                    <span className="text-claude-ink-1">{a.agentName}</span>
                    <span className="text-claude-ink-3 ml-1">{a.type}: {a.narrative}</span>
                  </li>
                ))}
              </ul>
            )}
          </ClaudeCard>
          <ClaudeCard>
            <ClaudeSectionTitle>{t('monitor_failure_log_failures')}</ClaudeSectionTitle>
            {data.logFailures.length === 0 ? (
              <div className="text-claude-ink-4 text-[12.5px]">{t('monitor_failure_no_log_failures')}</div>
            ) : (
              <ul className="flex flex-col divide-y divide-claude-line">
                {data.logFailures.map((f) => (
                  <li key={f.id} className="py-2 text-[12.5px]">
                    <div className="flex items-center gap-2">
                      <ClaudeBadge tone={f.level === 'error' || f.level === 'critical' ? 'err' : 'warn'} size="xs">
                        {f.level}
                      </ClaudeBadge>
                      <span className="text-claude-ink-1 font-medium">{f.failure.summary}</span>
                      <span className="text-claude-ink-4 ml-auto tabular-nums">{formatTime(f.ts, lang)}</span>
                    </div>
                    <div className="text-claude-ink-3 mt-1 break-words">{f.failure.detail ?? f.message}</div>
                  </li>
                ))}
              </ul>
            )}
          </ClaudeCard>
        </>
      )}
    </div>
  );
}
