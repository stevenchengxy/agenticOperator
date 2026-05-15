'use client';

import { useState } from 'react';
import { useApp } from '@/lib/i18n';

// Pre-baked sample payloads per trigger event for one-click testing.
const SAMPLE_PAYLOADS: Record<string, unknown> = {
  RESUME_DOWNLOADED: {
    upload_id: `e2e-ui-test-${Date.now()}`,
    bucket: 'recruit-resume-raw',
    objectKey: 'e2e/test-resume.pdf',
    filename: 'e2e-test-resume.pdf',
    hrFolder: null,
    employeeId: 'e2e_employee_001',
    etag: `e2e-etag-${Date.now()}`,
    size: 12345,
    sourceEventName: 'ui-test',
    receivedAt: new Date().toISOString(),
    parsed: {
      data: {
        name: 'UI 测试候选人',
        email: 'ui-test@example.com',
        phone: '13800138001',
        location: '北京',
        summary: 'UI 触发测试 - 测试候选人简历',
        experience: [
          {
            title: '高级研发工程师',
            company: '字节跳动',
            startDate: '2022-01',
            endDate: '2024-12',
            description: 'Java 后端开发',
          },
        ],
        education: [
          { degree: '本科', field: '计算机', institution: '清华大学', graduationYear: '2021' },
        ],
        skills: ['Java', 'MySQL', 'Redis'],
      },
    },
  },
  REQUIREMENT_LOGGED: {
    entity_type: 'Job_Requisition',
    entity_id: `e2e-ui-jr-${Date.now()}`,
    event_id: `e2e-ui-evt-${Date.now()}`,
    payload: {
      job_requisition_id: `e2e-ui-jr-${Date.now()}`,
      client_id: 'e2e-client-001',
      raw_input_data: {
        prompt: '招聘一名 Java 高级研发工程师, 北京, 5年经验, 30-50k',
        language: 'zh',
      },
    },
    trace: { trace_id: `e2e-ui-trace-${Date.now()}` },
  },
  RESUME_PROCESSED: {
    upload_id: `e2e-ui-mra-${Date.now()}`,
    objectKey: 'e2e/test-resume-2.pdf',
    filename: 'e2e-test-resume-2.pdf',
    bucket: 'recruit-resume-raw',
    hrFolder: null,
    employeeId: 'e2e_employee_002',
    etag: `e2e-etag-${Date.now()}`,
    size: 12345,
    sourceEventName: 'ui-test',
    receivedAt: new Date().toISOString(),
    candidate_id: `e2e-cand-${Date.now()}`,
    resume_id: `e2e-resume-${Date.now()}`,
    job_requisition_id: 'e2e-ui-jr-001',
    parsed: {
      data: {
        name: 'UI MRA 测试',
        email: 'mra-ui@test.com',
        phone: '13800138002',
        summary: 'Java 工程师',
        experience: [
          { title: 'Java 研发', company: '腾讯', startDate: '2020-01', endDate: '2024-06' },
        ],
        skills: ['Java', 'Spring', 'MySQL'],
      },
    },
    candidate: {},
    candidate_expectation: {},
    resume: {},
    parsedAt: new Date().toISOString(),
    parserVersion: 'v7-pull-model@ui-test',
  },
};

export function SendEventModal({
  triggerName,
  onClose,
  onSent,
}: {
  triggerName: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const { t } = useApp();
  const defaultPayload = SAMPLE_PAYLOADS[triggerName] ?? { upload_id: `test-${Date.now()}` };
  const [payloadStr, setPayloadStr] = useState(JSON.stringify(defaultPayload, null, 2));
  const [eventName, setEventName] = useState(triggerName);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleSend() {
    setSending(true);
    setResult(null);
    try {
      const data = JSON.parse(payloadStr);
      const res = await fetch('/api/inngest-admin/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: eventName, data }),
      });
      const body = await res.json();
      if (body.ok) {
        setResult(`✓ ${t('monitor_send_event_sent').replace('{id}', body.new_event_id)}`);
        setTimeout(() => onSent(), 800);
      } else {
        setResult(`✗ ${t('monitor_send_event_failed').replace('{message}', body.message ?? body.error)}`);
      }
    } catch (e) {
      setResult(`✗ ${t('monitor_send_event_json_failed').replace('{message}', (e as Error).message)}`);
    }
    setSending(false);
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="w-[720px] max-w-[90vw] max-h-[90vh] bg-bg border border-line rounded-md shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-line flex items-start justify-between">
          <div>
            <div className="text-[13px] text-ink-3">{t('monitor_send_event_title')}</div>
            <div className="text-[16px] font-medium text-ink-1 mt-0.5">{triggerName}</div>
          </div>
          <button onClick={onClose} className="text-[20px] text-ink-3 hover:text-ink-1">
            ×
          </button>
        </div>

        <div className="p-4 flex-1 flex flex-col gap-3 overflow-hidden">
          <div>
            <label className="text-[11px] text-ink-3 uppercase">{t('monitor_send_event_name')}</label>
            <input
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              className="w-full mt-1 px-3 py-2 text-[13px] mono border border-line rounded bg-surface text-ink-1"
            />
          </div>
          <div className="flex-1 flex flex-col min-h-0">
            <label className="text-[11px] text-ink-3 uppercase">{t('monitor_send_event_payload')}</label>
            <textarea
              value={payloadStr}
              onChange={(e) => setPayloadStr(e.target.value)}
              className="flex-1 mt-1 px-3 py-2 text-[11px] mono border border-line rounded bg-surface text-ink-1 font-mono resize-none"
              spellCheck={false}
            />
          </div>
          {result && (
            <div
              className={`text-[12px] mono ${
                result.startsWith('✓') ? 'text-ok' : 'text-err'
              }`}
            >
              {result}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-line flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[12px] border border-line rounded hover:bg-surface-hover"
          >
            {t('cancel')}
          </button>
          <button
            onClick={handleSend}
            disabled={sending}
            className="px-4 py-2 text-[12px] bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50"
          >
            {sending ? t('monitor_send_event_sending') : t('monitor_send_event_send')}
          </button>
        </div>
      </div>
    </div>
  );
}
