"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePoll } from "@/lib/monitor/usePoll";
import { MonitorGraph } from "./MonitorGraph";
import { FilterChips } from "./FilterChips";
import { KpiStrip } from "./KpiStrip";
import { FailuresFeed } from "./FailuresFeed";
import { HitlFeed } from "./HitlFeed";
import { RecentRunsStrip } from "./RecentRunsStrip";
import { MiniRunList } from "./MiniRunList";
import type { MonitorOverviewResponse, MonitorRunRow } from "@/lib/monitor/types";

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

function MonitorContentInner() {
  const router = useRouter();
  const sp = useSearchParams();

  // URL state
  const windowMs = Number(sp.get('windowMs') ?? DEFAULT_WINDOW_MS);
  const status = sp.get('status') ?? undefined;
  const [search, setSearch] = React.useState<string>(sp.get('q') ?? '');

  const updateUrl = React.useCallback((mut: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(sp.toString());
    mut(next);
    router.replace(`/monitor${next.toString() ? `?${next.toString()}` : ''}`);
  }, [router, sp]);

  // Build the API URL from filters
  const apiUrl = React.useMemo(() => {
    const p = new URLSearchParams();
    p.set('windowMs', String(windowMs));
    if (status) p.set('status', status);
    return `/api/monitor/overview?${p.toString()}`;
  }, [windowMs, status]);

  const { data, error } = usePoll<MonitorOverviewResponse>(apiUrl, 4_000);

  // Mini run list state (when a node's "running ▶" badge is clicked)
  const [miniAgent, setMiniAgent] = React.useState<string | null>(null);
  const miniRows: MonitorRunRow[] = React.useMemo(() => {
    if (!miniAgent || !data) return [];
    // v1 approximation: recentRuns isn't keyed by agent — show global
    // running slice. Per-agent endpoint deferred per plan §"Known gaps".
    return data.recentRuns.filter(r => r.status === 'running').slice(0, 5);
  }, [miniAgent, data]);

  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-[28px] font-medium leading-tight">Monitor</h1>
          <p className="text-claude-ink-3 text-[13px] mt-1">
            Runtime state of all workflow agents.
            {error && <span className="text-claude-err"> · {error}</span>}
          </p>
        </div>
      </div>

      <div className="mb-4">
        <FilterChips
          windowMs={windowMs}
          onWindowChange={(ms) => updateUrl(p => p.set('windowMs', String(ms)))}
          status={status}
          onStatusChange={(s) => updateUrl(p => { s ? p.set('status', s) : p.delete('status'); })}
          search={search}
          onSearchChange={setSearch}
        />
      </div>

      <div className="mb-4">
        <KpiStrip
          kpi={data?.kpi ?? null}
          onApplyStatusFilter={(s) => updateUrl(p => p.set('status', s))}
          onApplyHitlFilter={() => router.push('/inbox')}
        />
      </div>

      <div className="mb-6">
        <MonitorGraph
          nodeAggs={data?.nodes}
          edgeAggs={data?.edges}
          onNodeClick={(id) => router.push(`/monitor/agents/${encodeURIComponent(id)}`)}
          onRunningClick={(id) => setMiniAgent(id)}
          onHitlClick={(id) => router.push(`/inbox?agent=${encodeURIComponent(id)}`)}
          onQueueClick={(id) => router.push(`/monitor/queue?nodeId=${encodeURIComponent(id)}`)}
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <RecentRunsStrip rows={data?.recentRuns ?? []} />
        <FailuresFeed   rows={data?.failures ?? []} />
        <HitlFeed       rows={data?.hitl ?? []} />
      </div>

      {miniAgent && (
        <MiniRunList
          agentTitle={miniAgent}
          rows={miniRows}
          onClose={() => setMiniAgent(null)}
        />
      )}
    </div>
  );
}

export function MonitorContent() {
  return (
    <React.Suspense fallback={
      <div className="p-6 max-w-[1620px] mx-auto">
        <h1 className="text-[28px] font-medium leading-tight">Monitor</h1>
        <p className="text-claude-ink-3 text-[13px] mt-1">Loading…</p>
      </div>
    }>
      <MonitorContentInner />
    </React.Suspense>
  );
}
