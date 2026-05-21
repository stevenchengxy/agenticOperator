// Live agent inspector panel — shown only for the 3 real PRA agents on /workflow.
// Provides:
//   - Recent run summary (count / success rate / latest run id)
//   - Pause / resume toggle
//   - Send Test Event button
//   - "Open detail" → cross-link to /workflow-agents list view

'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { LiveAgentState } from '@/lib/api/inngest-live-overlay';

export function LiveAgentPanel({ liveAgent }: { liveAgent: LiveAgentState }) {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function togglePause() {
    setBusy(true);
    try {
      await fetch(`/api/inngest-admin/functions/${liveAgent.slug}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: !liveAgent.paused }),
      });
      setToast(liveAgent.paused ? '已恢复' : '已暂停');
      setTimeout(() => setToast(null), 2000);
    } catch {
      setToast('操作失败');
    }
    setBusy(false);
  }

  async function sendTest() {
    setBusy(true);
    const triggerName = liveAgent.triggers[0] ?? 'RESUME_DOWNLOADED';
    // Use sample payload from /workflow-agents SendEventModal logic (inline)
    const samples: Record<string, unknown> = {
      RESUME_DOWNLOADED: {
        upload_id: `wf-test-${Date.now()}`,
        bucket: 'recruit-resume-raw',
        objectKey: 'wf/test.pdf',
        filename: 'wf-test.pdf',
        hrFolder: null,
        employeeId: 'wf_test',
        etag: `wf-${Date.now()}`,
        size: 1234,
        sourceEventName: 'wf-test',
        receivedAt: new Date().toISOString(),
        parsed: { data: { name: 'WF Test', email: 'wf@test.com', skills: ['Java'] } },
      },
      REQUIREMENT_LOGGED: {
        entity_type: 'Job_Requisition',
        entity_id: `wf-jr-${Date.now()}`,
        event_id: `wf-evt-${Date.now()}`,
        payload: {
          job_requisition_id: `wf-jr-${Date.now()}`,
          client_id: 'wf-client',
          raw_input_data: { prompt: 'Java 工程师 北京 30k', language: 'zh' },
        },
        trace: { trace_id: `wf-tr-${Date.now()}` },
      },
      RESUME_PROCESSED: {
        upload_id: `wf-mra-${Date.now()}`,
        objectKey: 'wf/r.pdf',
        filename: 'r.pdf',
        bucket: 'recruit-resume-raw',
        hrFolder: null,
        employeeId: 'wf_emp',
        etag: `wf-${Date.now()}`,
        size: 1,
        sourceEventName: 'wf',
        receivedAt: new Date().toISOString(),
        candidate_id: `wf-c-${Date.now()}`,
        resume_id: `wf-r-${Date.now()}`,
        parsed: { data: { name: 'WF Match', skills: ['Java'] } },
        candidate: {},
        candidate_expectation: {},
        resume: {},
        parsedAt: new Date().toISOString(),
        parserVersion: 'wf-test',
      },
    };
    try {
      await fetch('/api/inngest-admin/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: triggerName, data: samples[triggerName] }),
      });
      setToast('已发送测试事件,刷新后可见 run');
      setTimeout(() => setToast(null), 2500);
    } catch {
      setToast('发送失败');
    }
    setBusy(false);
  }

  return (
    <div className="border-b border-line mx-3 my-3 p-3 rounded-md bg-panel">
      <div className="text-[11px] text-ink-3 uppercase mb-2 tracking-wide">事件引擎实时</div>

      {/* Trigger event */}
      <div className="mb-3">
        <div className="text-[10px] text-ink-4 uppercase">Triggers</div>
        <div className="flex flex-wrap gap-1 mt-0.5">
          {liveAgent.triggers.map((t) => (
            <span
              key={t}
              className="text-[10px] mono px-1.5 py-0.5 rounded-sm border border-line text-ink-2"
            >
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* Metric grid */}
      <div className="grid grid-cols-4 gap-1.5 text-center mb-3">
        <Metric label="Total" value={liveAgent.total} />
        <Metric label="OK" value={liveAgent.completed} accent="ok" />
        <Metric label="Fail" value={liveAgent.failed} accent="err" />
        <Metric
          label="Rate"
          value={liveAgent.successRate !== null ? `${liveAgent.successRate}%` : '—'}
        />
      </div>

      {/* Latest run summary */}
      {liveAgent.latestRunId && (
        <div className="mb-3 p-2 border border-line rounded bg-surface">
          <div className="text-[10px] text-ink-4 uppercase">最新 run</div>
          <div className="text-[11px] mono text-ink-2 truncate">{liveAgent.latestRunId}</div>
          <div className="flex items-center gap-2 mt-1">
            <span
              className={`text-[10px] mono font-medium ${
                liveAgent.latestStatus === 'Completed'
                  ? 'text-ok'
                  : liveAgent.latestStatus === 'Failed'
                  ? 'text-err'
                  : 'text-warn'
              }`}
            >
              {liveAgent.latestStatus}
            </span>
            <span className="text-[10px] text-ink-4">
              {liveAgent.latestDurationMs != null ? `${liveAgent.latestDurationMs}ms` : '—'}
            </span>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-1.5">
        <button
          onClick={togglePause}
          disabled={busy}
          className={`flex-1 text-[11px] py-1 rounded border ${
            liveAgent.paused
              ? 'border-ok text-ok hover:bg-ok-bg'
              : 'border-warn text-warn hover:bg-warn-bg'
          } disabled:opacity-50`}
        >
          {liveAgent.paused ? '▶ 恢复' : '⏸ 暂停'}
        </button>
        <button
          onClick={sendTest}
          disabled={busy}
          className="flex-1 text-[11px] py-1 rounded border border-line text-ink-2 hover:bg-surface-hover disabled:opacity-50"
        >
          ▷ 发测试事件
        </button>
      </div>

      <Link
        href={`/monitor?tab=runs`}
        className="block mt-2 text-[10.5px] text-accent hover:underline text-center"
      >
        → 完整运行 / DLQ / step trace
      </Link>

      {toast && (
        <div className="mt-2 text-[11px] text-ok bg-ok-bg/40 px-2 py-1 rounded text-center">
          {toast}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: 'ok' | 'err';
}) {
  const color =
    accent === 'ok' ? 'text-ok' : accent === 'err' ? 'text-err' : 'text-ink-1';
  return (
    <div>
      <div className={`text-[14px] mono font-medium ${color}`}>{value}</div>
      <div className="text-[9px] text-ink-4 uppercase">{label}</div>
    </div>
  );
}
