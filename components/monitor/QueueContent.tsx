"use client";
import React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ClaudeCard, ClaudeChip, ClaudeBadge } from "./atoms";
import { usePoll } from "@/lib/monitor/usePoll";
import { useApp } from "@/lib/i18n";
import type { MonitorQueueResponse, MonitorQueueEventRow, MonitorQueueDlqRow } from "@/lib/monitor/types";

const BUCKETS = ['accepted', 'pending', 'rejected', 'dlq'] as const;

function QueueContentInner() {
  const { t } = useApp();
  const router = useRouter();
  const sp = useSearchParams();
  const bucket = (sp.get('bucket') ?? 'accepted') as (typeof BUCKETS)[number];
  const offset = Number(sp.get('offset') ?? 0);

  const { data } = usePoll<MonitorQueueResponse>(
    `/api/monitor/queue?bucket=${bucket}&offset=${offset}&limit=50`,
    8_000,
  );

  // Bucket change resets pagination by omitting `offset` — different buckets
  // have different sizes, so a "page 3" offset for one rarely makes sense
  // for another.
  const setBucket = (b: string) =>
    router.replace(`/monitor/queue?bucket=${b}`);

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="mb-4">
        <Link href="/monitor" className="text-claude-accent text-[12.5px] no-underline">
          {t('monitor_queue_back')}
        </Link>
      </div>
      <h1 className="text-[24px] font-medium mb-4">{t('monitor_queue_title')}</h1>
      <div className="flex items-center gap-2 mb-4">
        {BUCKETS.map(b => (
          <ClaudeChip key={b} active={bucket === b} onClick={() => setBucket(b)}>
            {b}{data && data.bucket === b ? ` (${data.total})` : ''}
          </ClaudeChip>
        ))}
      </div>
      <ClaudeCard>
        {!data ? (
          <div className="text-claude-ink-4 text-[12.5px]">{t('monitor_queue_loading')}</div>
        ) : data.rows.length === 0 ? (
          <div className="text-claude-ink-4 text-[12.5px]">{t('monitor_queue_empty')}</div>
        ) : data.bucket === 'dlq' ? (
          // Manual narrowing by data.bucket — TS can't infer union from a parallel field
          <ul className="flex flex-col divide-y divide-claude-line">
            {(data.rows as MonitorQueueDlqRow[]).map(r => (
              <li key={r.id} className="py-2 text-[12.5px] flex items-center gap-2">
                <ClaudeBadge tone="err" size="xs">DLQ</ClaudeBadge>
                <code className="text-claude-ink-1">{r.eventName}</code>
                <span className="text-claude-ink-3 truncate">{r.reason}</span>
                <span className="ml-auto text-claude-ink-4 tabular-nums">retry {r.retries}</span>
              </li>
            ))}
          </ul>
        ) : (
          // Manual narrowing by data.bucket — TS can't infer union from a parallel field
          <table className="w-full text-[12.5px]">
            <thead className="text-claude-ink-4">
              <tr>
                <th className="text-left py-1">Event</th>
                <th className="text-left py-1">Source</th>
                <th className="text-left py-1">Status</th>
                <th className="text-left py-1">Rejection</th>
                <th className="text-right py-1">When</th>
              </tr>
            </thead>
            <tbody>
              {(data.rows as MonitorQueueEventRow[]).map(r => (
                <tr key={r.id} className="border-t border-claude-line">
                  <td className="py-1"><code className="text-claude-ink-1">{r.name}</code></td>
                  <td className="py-1 text-claude-ink-3">{r.source}</td>
                  <td className="py-1">
                    <ClaudeBadge tone={r.status === 'accepted' ? 'ok' : 'err'} size="xs">{r.status}</ClaudeBadge>
                  </td>
                  <td className="py-1 text-claude-ink-3 truncate">{r.rejectionReason ?? '—'}</td>
                  <td className="py-1 text-right text-claude-ink-4 tabular-nums">{new Date(r.ts).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ClaudeCard>
    </div>
  );
}

export function QueueContent() {
  return (
    <React.Suspense fallback={
      <div className="p-6 max-w-[1200px] mx-auto">
        <h1 className="text-[24px] font-medium mb-4">Event queue</h1>
        <p className="text-claude-ink-3 text-[12.5px]">Loading…</p>
      </div>
    }>
      <QueueContentInner />
    </React.Suspense>
  );
}
