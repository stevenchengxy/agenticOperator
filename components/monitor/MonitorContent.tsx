"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePoll } from "@/lib/monitor/usePoll";
import { MonitorGraph } from "./MonitorGraph";
import { FilterChips } from "./FilterChips";
import { FailuresFeed } from "./FailuresFeed";
import { HitlFeed } from "./HitlFeed";
import { MiniRunList } from "./MiniRunList";
import { InstanceCardsSection } from "./InstanceCardsSection";
import { MonitorHeader } from "./MonitorHeader";
import { ActionBar } from "./ActionBar";
import { AgentDetailPanel } from "./AgentDetailPanel";
import { SystemStatusCards } from "./SystemStatusCards";
import { MonitorTabNav, type MonitorTab } from "./MonitorTabNav";
import { InngestAgentsTab } from "./InngestAgentsTab";
import { InngestRunsTab } from "./InngestRunsTab";
import { InngestDlqTab } from "./InngestDlqTab";
import { InngestEventsTab } from "./InngestEventsTab";
import { RuntimeTopologyView } from "./RuntimeTopologyView";
import { useInngestLiveOverlay } from "@/lib/api/inngest-live-overlay";
import { useApp } from "@/lib/i18n";
import type { MonitorOverviewResponse, MonitorRunRow } from "@/lib/monitor/types";

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

function MonitorContentInner() {
  const { t } = useApp();
  const router = useRouter();
  const sp = useSearchParams();

  // URL state
  const windowMs = Number(sp.get('windowMs') ?? DEFAULT_WINDOW_MS);
  const status = sp.get('status') ?? undefined;
  // ★ Active tab — driven by ?tab= query param so deep links survive.
  const tab: MonitorTab = (sp.get('tab') as MonitorTab) ?? 'topology';
  // Search state hoisted here so it feeds both FilterChips and InstanceCardsSection
  const [search, setSearch] = React.useState<string>(sp.get('q') ?? '');

  // ★ Inngest live counts — used in tab badges (Agents · 3 · DLQ · 0).
  const liveOverlay = useInngestLiveOverlay();
  const [dlqCount, setDlqCount] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/inngest-admin/dlq');
        const b = await r.json();
        if (!cancelled) setDlqCount(b.dlq?.length ?? 0);
      } catch {
        /* soft */
      }
    }
    load();
    const t = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  const [runCount, setRunCount] = React.useState(0);
  const [eventCount, setEventCount] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/inngest-events?limit=100');
        const b = await r.json();
        if (!cancelled) setEventCount(b.events?.length ?? 0);
      } catch {
        /* soft */
      }
    }
    load();
    const t = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch('/api/inngest-admin/runs?limit=200');
        const b = await r.json();
        if (!cancelled) setRunCount(b.runs?.length ?? 0);
      } catch {
        /* soft */
      }
    }
    load();
    const t = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

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
          {t("monitor_polling_error")} {error}
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
      {/* ── ★ Tab nav for unified Monitor dashboard ── */}
      <MonitorTabNav
        tab={tab}
        onChange={(t) => updateUrl((p) => (t === 'topology' ? p.delete('tab') : p.set('tab', t)))}
        counts={{
          agents: liveOverlay.byWsId.size,
          runs: runCount,
          events: eventCount,
          dlq: dlqCount,
        }}
      />

      {/* ── Tab: 拓扑 — dual mode (default: 实时 3-agent · 切换: 完整 23-node 蓝图) ── */}
      {tab === 'topology' && (
        <>
          {/* Mode toggle */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[11px] text-ink-3 uppercase">{t("monitor_view_label")}</span>
            <button
              onClick={() => updateUrl((p) => p.delete('view'))}
              className={`text-[12px] px-3 py-1 rounded border ${
                (sp.get('view') ?? 'runtime') === 'runtime'
                  ? 'border-accent text-accent bg-accent-bg/30'
                  : 'border-line text-ink-2 hover:bg-surface-hover'
              }`}
            >
              {t("monitor_view_runtime")}
            </button>
            <button
              onClick={() => updateUrl((p) => p.set('view', 'blueprint'))}
              className={`text-[12px] px-3 py-1 rounded border ${
                sp.get('view') === 'blueprint'
                  ? 'border-accent text-accent bg-accent-bg/30'
                  : 'border-line text-ink-2 hover:bg-surface-hover'
              }`}
            >
              {t("monitor_view_blueprint")}
            </button>
            <span className="ml-2 text-[11px] text-ink-4">
              {(sp.get('view') ?? 'runtime') === 'runtime'
                ? t("monitor_view_runtime_hint")
                : t("monitor_view_blueprint_hint")}
            </span>
          </div>

          {(sp.get('view') ?? 'runtime') === 'runtime' ? (
            <div className="mb-4">
              <RuntimeTopologyView />
            </div>
          ) : (
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
                inngestLiveByWsId={liveOverlay.byWsId}
              />
            </div>
          )}

          {/* ★ Instances · Failures · HITL — dynamic 3-col.
              Width rebalances based on content:
                - 实时实例 always gets generous space (50% if others empty, 40% otherwise)
                - 故障 collapses when empty (160px instead of 30%)
                - HITL takes the rest
              Cards inside 实时实例 get min-w 200px so they don't crush. */}
          {(() => {
            const failureCount = data?.failures?.length ?? 0;
            const hitlCount = data?.hitl?.length ?? 0;
            // Build grid template based on which columns have content
            const cols =
              failureCount === 0 && hitlCount === 0
                ? '1fr'
                : failureCount === 0
                ? 'minmax(420px, 1.4fr) 200px minmax(360px, 1fr)'
                : hitlCount === 0
                ? 'minmax(420px, 1.4fr) minmax(360px, 1fr) 200px'
                : 'minmax(420px, 1.2fr) minmax(280px, 1fr) minmax(280px, 1fr)';
            return (
              <div
                className="grid gap-3 mb-6"
                style={{ gridTemplateColumns: cols, minHeight: 200 }}
              >
                <div className="border border-claude-line rounded-[10px] bg-claude-surface p-3 overflow-hidden flex flex-col">
                  <InstanceCardsSection paused={paused} searchQuery={search} compact />
                </div>
                <div
                  className={`border border-claude-line rounded-[10px] bg-claude-surface p-3 ${
                    failureCount === 0 ? 'flex flex-col justify-center items-center' : 'overflow-y-auto'
                  }`}
                  title={failureCount === 0 ? t('monitor_failures_empty') : ''}
                >
                  {failureCount === 0 ? (
                    <>
                      <div className="text-[11px] uppercase text-ink-4 mb-1">{t('monitor_failures_title')}</div>
                      <div className="text-ok text-[14px] mb-0.5">✓</div>
                      <div className="text-[10px] text-ink-4">{t('monitor_failures_empty')}</div>
                    </>
                  ) : (
                    <FailuresFeed rows={data?.failures ?? []} />
                  )}
                </div>
                <div
                  className={`border border-claude-line rounded-[10px] bg-claude-surface p-3 ${
                    hitlCount === 0 ? 'flex flex-col justify-center items-center' : 'overflow-y-auto'
                  }`}
                >
                  {hitlCount === 0 ? (
                    <>
                      <div className="text-[11px] uppercase text-ink-4 mb-1">{t('monitor_hitl_title')}</div>
                      <div className="text-ink-3 text-[14px] mb-0.5">—</div>
                      <div className="text-[10px] text-ink-4">{t('monitor_hitl_empty')}</div>
                    </>
                  ) : (
                    <HitlFeed rows={data?.hitl ?? []} />
                  )}
                </div>
              </div>
            );
          })()}
        </>
      )}

      {/* ── Tab: Agents — 3 real PRA agent cards (was /workflow-agents) ── */}
      {tab === 'agents' && (
        <div className="mb-6">
          <InngestAgentsTab />
        </div>
      )}

      {/* ── Tab: Runs — Inngest run list (filterable) ── */}
      {tab === 'runs' && (
        <div className="mb-6">
          <InngestRunsTab />
        </div>
      )}

      {/* ── Tab: Events — Inngest firehose (★ RAAS 对接调试用)── */}
      {tab === 'events' && (
        <div className="mb-6">
          <InngestEventsTab />
        </div>
      )}

      {/* ── Tab: DLQ — failed runs + retry ── */}
      {tab === 'dlq' && (
        <div className="mb-6">
          <InngestDlqTab />
        </div>
      )}

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
  const { t } = useApp();
  return (
    <React.Suspense fallback={
      <div className="p-6 max-w-[1620px] mx-auto">
        <div className="text-[11px] uppercase tracking-[0.16em] text-claude-ink-4 font-medium mb-2">
          {t("monitor_hero_subtitle")}
        </div>
        <h1 className="text-[44px] font-medium leading-[1.05]">{t("monitor_title")}</h1>
        <p className="text-claude-ink-3 text-[13px] mt-1">{t("monitor_loading")}</p>
      </div>
    }>
      <MonitorContentInner />
    </React.Suspense>
  );
}
