'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/lib/i18n';
import { formatDateTime, statusLabel } from '@/components/monitor/i18n-utils';

type DLQItem = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  eventName?: string | null;
  function: { name: string; slug: string };
  durationMs: number | null;
};

export function DLQPanel({ onSelectRun }: { onSelectRun: (runId: string) => void }) {
  const { t, lang } = useApp();
  const [items, setItems] = useState<DLQItem[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/inngest-admin/dlq');
      const body = await res.json();
      setItems(body.dlq ?? []);
    } catch {
      // soft fail
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[13px] font-medium text-ink-2">
          {t('monitor_dlq_title')}{' '}
          <span className="text-ink-4">· {items.length}</span>
        </h2>
        <button
          onClick={load}
          className="text-[11px] text-ink-3 hover:text-ink-1"
        >
          ↻
        </button>
      </div>

      {loading && <div className="text-[12px] text-ink-3">{t('monitor_loading')}</div>}

      {!loading && items.length === 0 && (
        <div className="text-[12px] text-ok px-2 py-4 text-center border border-dashed border-ok rounded">
          ✓ {t('monitor_dlq_empty')}
        </div>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelectRun(item.id)}
            className="w-full text-left p-2 rounded border border-err/40 bg-err-bg/30 hover:border-err"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-ink-1 font-medium truncate">
                  {item.function.name}
                </div>
                <div className="text-[10px] mono text-ink-4 truncate mt-0.5">
                  {item.eventName && <span>{item.eventName} · </span>}
                  {formatDateTime(item.startedAt, lang)}
                </div>
              </div>
              <span className="text-[9.5px] mono px-1.5 py-0.5 rounded bg-err-bg text-err shrink-0">
                {statusLabel(item.status, t)}
              </span>
            </div>
            <div className="text-[10px] mono text-ink-4 mt-1">{item.id}</div>
          </button>
        ))}
      </div>

      <div className="mt-4 text-[10px] text-ink-4 px-1 border-t border-line pt-2">
        {t('monitor_dlq_hint')}
      </div>
    </div>
  );
}
