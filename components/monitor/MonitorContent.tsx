"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePoll } from "@/lib/monitor/usePoll";
import { MonitorGraph } from "./MonitorGraph";
import { FilterChips } from "./FilterChips";
import { KpiStrip } from "./KpiStrip";
import { FailuresFeed } from "./FailuresFeed";
import { HitlFeed } from "./HitlFeed";
import { MiniRunList } from "./MiniRunList";
import { InstanceCardsSection } from "./InstanceCardsSection";
import { MonitorHeader } from "./MonitorHeader";
import { ActionBar } from "./ActionBar";
import { AgentDetailPanel } from "./AgentDetailPanel";
import { SystemStatusCards } from "./SystemStatusCards";
import type { MonitorOverviewResponse, MonitorRunRow } from "@/lib/monitor/types";

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

function MonitorContentInner() {
  const router = useRouter();
  const sp = useSearchParams();

  // URL state
  const windowMs = Number(sp.get('windowMs') ?? DEFAULT_WINDOW_MS);
  const status = sp.get('status') ?? undefined;
  // Search state hoisted here so it feeds both FilterChips and InstanceCardsSection
  const [search, setSearch] = React.useState<string>(sp.get('q') ?? '');

  // Pause/resume polling
  const [paused, setPaused] = React.useState(false);
  const onTogglePause = React.useCallback(() => setPaused(p => !p), []);

  // Selected agent for the right-rail detail panel
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(null);

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

  const { data, error, lastSuccessAt } = usePoll<MonitorOverviewResponse>(apiUrl, 4_000, paused);

  // Mini run list state (when a node's "running ▶" badge is clicked)
  const [miniAgent, setMiniAgent] = React.useState<string | null>(null);
  const miniRows: MonitorRunRow[] = React.useMemo(() => {
    if (!miniAgent || !data) return [];
    return data.recentRuns.filter(r => r.status === 'running').slice(0, 5);
  }, [miniAgent, data]);

  // Header stats derived from KPI data
  const headerStats = React.useMemo(() => {
    if (!data?.kpi) return null;
    const kpi = data.kpi;
    return {
      activeRuns: kpi.activeRuns,
      pendingHitl: kpi.pendingHitl,
      failuresInWindow: kpi.failuresInWindow,
      tokensInWindow: kpi.tokensInWindow,
    };
  }, [data]);

  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      <MonitorHeader
        stats={headerStats}
        lastSuccessAt={lastSuccessAt}
        hasError={!!error}
      />

      <ActionBar paused={paused} onTogglePause={onTogglePause} />

      {/* System Status Cards — collapsed by default, infrastructure visibility on demand */}
      <SystemStatusCards paused={paused} />

      {error && (
        <p className="text-claude-err text-[12px] mb-2">
          Polling error: {error}
        </p>
      )}

      {/* Filter + KPI row — compact, single visual strip */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
        <FilterChips
          windowMs={windowMs}
          onWindowChange={(ms) => updateUrl(p => p.set('windowMs', String(ms)))}
          status={status}
          onStatusChange={(s) => updateUrl(p => { s ? p.set('status', s) : p.delete('status'); })}
          search={search}
          onSearchChange={setSearch}
        />
      </div>
      <div className="mb-3">
        <KpiStrip
          kpi={data?.kpi ?? null}
          onApplyStatusFilter={(s) => updateUrl(p => p.set('status', s))}
          onApplyHitlFilter={() => router.push('/inbox')}
        />
      </div>

      {/* ── PRIMARY: Agent Network Graph ── */}
      <div className="mb-4 relative">
        <MonitorGraph
          nodeAggs={data?.nodes}
          edgeAggs={data?.edges}
          onNodeClick={(id) => setSelectedAgentId(prev => prev === id ? null : id)}
          onRunningClick={(id) => setMiniAgent(id)}
          onHitlClick={(id) => router.push(`/inbox?agent=${encodeURIComponent(id)}`)}
          onQueueClick={(id) => router.push(`/monitor/queue?nodeId=${encodeURIComponent(id)}`)}
          selectedNodeId={selectedAgentId}
          graphHeight={700}
        />
      </div>

      {/* ── BOTTOM STRIP: Instances · Failures · HITL (compact 3-col) ── */}
      <div
        className="grid gap-4 mb-6"
        style={{ gridTemplateColumns: "30% 35% 35%", height: 220 }}
      >
        {/* Live Instances — compact horizontal scroll */}
        <div className="border border-claude-line rounded-[10px] bg-claude-surface p-3 overflow-hidden flex flex-col">
          <InstanceCardsSection paused={paused} searchQuery={search} compact />
        </div>

        {/* Failures Feed */}
        <div className="border border-claude-line rounded-[10px] bg-claude-surface p-3 overflow-y-auto">
          <FailuresFeed rows={data?.failures ?? []} />
        </div>

        {/* HITL Feed */}
        <div className="border border-claude-line rounded-[10px] bg-claude-surface p-3 overflow-y-auto">
          <HitlFeed rows={data?.hitl ?? []} />
        </div>
      </div>

      {miniAgent && (
        <MiniRunList
          agentTitle={miniAgent}
          rows={miniRows}
          onClose={() => setMiniAgent(null)}
        />
      )}

      <AgentDetailPanel
        nodeId={selectedAgentId}
        onClose={() => setSelectedAgentId(null)}
      />
    </div>
  );
}

export function MonitorContent() {
  return (
    <React.Suspense fallback={
      <div className="p-6 max-w-[1620px] mx-auto">
        <div className="text-[11px] uppercase tracking-[0.16em] text-claude-ink-4 font-medium mb-2">
          Agentic Operator · Live Ops
        </div>
        <h1 className="text-[44px] font-medium leading-[1.05]">Monitor</h1>
        <p className="text-claude-ink-3 text-[13px] mt-1">Loading…</p>
      </div>
    }>
      <MonitorContentInner />
    </React.Suspense>
  );
}
