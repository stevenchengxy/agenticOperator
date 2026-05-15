'use client';

import { useEffect, useMemo, useState } from 'react';
import { AgentCard } from './AgentCard';
import { RunList } from './RunList';
import { RunDetailDrawer } from './RunDetailDrawer';
import { DLQPanel } from './DLQPanel';
import { SendEventModal } from './SendEventModal';

const REFRESH_INTERVAL_MS = 5000;

export type AgentFunction = {
  id: string;
  name: string;
  slug: string;
  concurrency: number | null;
  triggers: Array<{ type: string; value: string }>;
  url: string | null;
  paused: boolean;
};

export type RunRow = {
  id: string;
  status: 'Completed' | 'Failed' | 'Running' | 'Cancelled' | string;
  startedAt: string;
  finishedAt: string | null;
  eventName: string | null;
  /** Triggering event id — needed for the inline "↺ 重跑" button to call /replay. */
  eventId?: string | null;
  function: { name: string; slug: string };
  durationMs: number | null;
  tokenUsage?: { prompt: number; completion: number; total: number };
};

export function WorkflowAgentsContent() {
  const [functions, setFunctions] = useState<AgentFunction[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [filterSlug, setFilterSlug] = useState<string | null>(null);
  const [showSendModalForTrigger, setShowSendModalForTrigger] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // ─── Data loaders ───
  async function loadFunctions() {
    try {
      const res = await fetch('/api/inngest-admin/functions');
      const body = await res.json();
      setFunctions(body.functions ?? []);
    } catch {
      // soft fail
    }
  }

  async function loadRuns(slug: string | null) {
    try {
      const url = slug
        ? `/api/inngest-admin/runs?fn=${encodeURIComponent(slug)}&limit=50`
        : `/api/inngest-admin/runs?limit=50`;
      const res = await fetch(url);
      const body = await res.json();
      setRuns(body.runs ?? []);
      setLastRefresh(new Date().toLocaleTimeString());
    } catch {
      // soft fail
    }
  }

  useEffect(() => {
    loadFunctions();
    loadRuns(filterSlug);
  }, [filterSlug]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => {
      loadFunctions();
      loadRuns(filterSlug);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [autoRefresh, filterSlug]);

  const stats = useMemo(() => {
    const total = runs.length;
    const completed = runs.filter((r) => r.status === 'Completed').length;
    const failed = runs.filter((r) => r.status === 'Failed').length;
    const running = runs.filter((r) => r.status === 'Running').length;
    return { total, completed, failed, running };
  }, [runs]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* ─── Top stats strip ─── */}
      <div className="px-6 py-4 border-b border-line flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <Stat label="已注册 Agent" value={functions.length} />
          <Stat label="近 24h Runs" value={stats.total} />
          <Stat label="Completed" value={stats.completed} accent="ok" />
          <Stat label="Failed" value={stats.failed} accent="err" />
          <Stat label="Running" value={stats.running} accent="warn" />
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/workflow"
            className="text-[12px] text-accent hover:underline"
            title="拓扑视图 — 看 agents 在完整工作流里的位置"
          >
            ⤢ 拓扑视图
          </a>
          <div className="w-px h-4 bg-line" />
          <label className="text-[12px] text-ink-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            自动刷新(5s)
          </label>
          {lastRefresh && (
            <span className="text-[11px] mono text-ink-4">最近: {lastRefresh}</span>
          )}
          <button
            onClick={() => {
              loadFunctions();
              loadRuns(filterSlug);
            }}
            className="px-3 py-1 text-[12px] border border-line rounded-md hover:bg-surface-hover"
          >
            手动刷新
          </button>
        </div>
      </div>

      {/* ─── 3-column body: agents · runs · DLQ ─── */}
      <div
        className="flex-1 grid min-h-0 overflow-hidden"
        style={{ gridTemplateColumns: '420px 1fr 360px' }}
      >
        {/* Column 1: agent cards */}
        <div className="overflow-y-auto border-r border-line p-4 space-y-3">
          <h2 className="text-[13px] font-medium text-ink-2 mb-2 px-1">
            Agents <span className="text-ink-4">· {functions.length}</span>
          </h2>
          {functions.length === 0 && (
            <div className="text-[12px] text-ink-3 px-2 py-4">
              加载中或没有注册的 Inngest function。
            </div>
          )}
          {functions.map((fn) => {
            const fnRuns = runs.filter((r) => r.function.slug === fn.slug);
            const fnSuccess = fnRuns.filter((r) => r.status === 'Completed').length;
            const fnFail = fnRuns.filter((r) => r.status === 'Failed').length;
            return (
              <AgentCard
                key={fn.slug}
                fn={fn}
                runCount={fnRuns.length}
                successCount={fnSuccess}
                failCount={fnFail}
                selected={filterSlug === fn.slug}
                onClick={() => setFilterSlug(filterSlug === fn.slug ? null : fn.slug)}
                onToggle={async (paused) => {
                  await fetch(`/api/inngest-admin/functions/${fn.slug}/toggle`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paused }),
                  });
                  loadFunctions();
                }}
                onSendTest={() => {
                  // pick first trigger event for the modal
                  setShowSendModalForTrigger(fn.triggers[0]?.value ?? null);
                }}
              />
            );
          })}
        </div>

        {/* Column 2: runs */}
        <div className="overflow-y-auto p-4">
          <h2 className="text-[13px] font-medium text-ink-2 mb-3 flex items-center justify-between">
            <span>
              Runs {filterSlug ? '(已过滤)' : '(全部)'}{' '}
              <span className="text-ink-4">· {runs.length}</span>
            </span>
            {filterSlug && (
              <button
                onClick={() => setFilterSlug(null)}
                className="text-[12px] text-accent hover:underline"
              >
                清除过滤
              </button>
            )}
          </h2>
          <RunList runs={runs} onSelect={setSelectedRunId} />
        </div>

        {/* Column 3: DLQ */}
        <div className="overflow-y-auto border-l border-line p-4">
          <DLQPanel onSelectRun={setSelectedRunId} />
        </div>
      </div>

      {/* ─── Detail drawer ─── */}
      {selectedRunId && (
        <RunDetailDrawer
          runId={selectedRunId}
          onClose={() => setSelectedRunId(null)}
        />
      )}

      {/* ─── Send Test Event modal ─── */}
      {showSendModalForTrigger && (
        <SendEventModal
          triggerName={showSendModalForTrigger}
          onClose={() => setShowSendModalForTrigger(null)}
          onSent={() => {
            setShowSendModalForTrigger(null);
            // refresh after 1s so the new event has time to register a run
            setTimeout(() => {
              loadFunctions();
              loadRuns(filterSlug);
            }, 1500);
          }}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: 'ok' | 'err' | 'warn';
}) {
  const color =
    accent === 'ok'
      ? 'text-ok'
      : accent === 'err'
      ? 'text-err'
      : accent === 'warn'
      ? 'text-warn'
      : 'text-ink-1';
  return (
    <div className="flex flex-col">
      <span className="text-[10.5px] text-ink-4 uppercase tracking-wide">{label}</span>
      <span className={`text-[20px] mono font-medium ${color}`}>{value}</span>
    </div>
  );
}
