"use client";
import React from "react";
import Link from "next/link";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { RunSummary, RunsResponse } from "@/lib/api/types";
import type { ActivityResponse, LogEntry } from "@/lib/api/activity-types";
import { useAgentsHealth } from "@/lib/api/agents-health";
import type { AgentHealth, AgentHealthStatus } from "@/app/api/agents/health/route";
import { byShortFunction } from "@/lib/agent-functions";
import { AGENT_MAP, byShort } from "@/lib/agent-mapping";
import { useDeploymentMap } from "@/lib/hooks/useDeploymentMap";
import { useInngestLiveOverlay } from "@/lib/api/inngest-live-overlay";
import { InngestPill } from "@/components/shared/InngestPill";
import { useApp } from "@/lib/i18n";

// /overview — system-at-a-glance dashboard.
//
// Job: "what's happening across the whole system right now?"
// Scope:
//   - everything姓"系统"; nothing scoped to a single run / agent / event
//   - one screen, no tabs, no per-row drill-in (clicking jumps to the
//     appropriate detail surface — /live, /workflow, /events, etc.)
//
// Sections:
//   A. 顶部 KPI 条 — active runs / 1h failed runs / 1h anomalies / total agents healthy
//   B. Agent 矩阵 — AGENT_MAP 全量 agent，按部署 lifecycle 着色（绿/黄/红 = 已上线/暂停/未上线），
//                  与 /fleet 状态点同源；runtime 异常作为次级标记叠加。
//   C. 最近异常 — 跨 run 的 anomaly / error / step.failed 流; click → /live?run=...
//   D. 当前 active run — top N; click → /live?run=...

// Deployment lifecycle = "is this agent online?" (mirrors /fleet FleetStatus):
//   online       — real or shell Inngest function, not paused        → 绿
//   paused       — registered Inngest function, paused               → 黄
//   not_deployed — unbuilt (no Inngest function yet)                 → 红
type DeployStatus = "online" | "paused" | "not_deployed";

const DEPLOY_TONE: Record<DeployStatus, { color: string; label: string }> = {
  online:       { color: "var(--c-ok)",   label: "已上线" },
  paused:       { color: "var(--c-warn)", label: "已暂停" },
  not_deployed: { color: "var(--c-err)",  label: "未上线" },
};

// Runtime health overlay — only shown when deployed AND runtime signal is bad.
// A deployed agent that's currently failing gets a small red ring on top of
// the green/yellow headline dot so ops can spot it without losing the
// "is it online?" answer.
const RUNTIME_BADGE_TONE: Partial<Record<AgentHealthStatus, { color: string; label: string }>> = {
  failed:   { color: "var(--c-err)",  label: "运行失败" },
  degraded: { color: "var(--c-warn)", label: "运行降级" },
  running:  { color: "var(--c-ok)",   label: "运行中" },
};

type MatrixRow = {
  short: string;
  deploy: DeployStatus;
  health: AgentHealth | null;
};

export function OverviewContent() {
  const health = useAgentsHealth(4_000);
  const { byWsId: liveByWsId } = useInngestLiveOverlay();
  const { realness: realnessMap } = useDeploymentMap();
  const [activeRuns, setActiveRuns] = React.useState<RunSummary[] | null>(null);
  const [failed1h, setFailed1h] = React.useState<RunSummary[] | null>(null);
  const [anomalies, setAnomalies] = React.useState<LogEntry[] | null>(null);
  const [todayRuns, setTodayRuns] = React.useState<{ total: number; completed: number } | null>(null);
  const [hitlPending, setHitlPending] = React.useState<number | null>(null);
  const [dlqPending, setDlqPending] = React.useState<number | null>(null);
  const [events1h, setEvents1h] = React.useState<number | null>(null);
  const [alertsActive, setAlertsActive] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const since1h = new Date(Date.now() - 60 * 60_000).toISOString();
    try {
      const [active, failed, recent, todayFinished, hitl, dlq, events, alerts] = await Promise.all([
        fetchJson<RunsResponse>("/api/runs?status=running,paused&limit=10"),
        fetchJson<RunsResponse>(
          `/api/runs?status=failed,timed_out,interrupted&since=${encodeURIComponent(since1h)}&limit=20`,
        ),
        fetchJson<ActivityResponse>(
          "/api/activity/recent?kind=anomaly,error,step.failed&windowMs=3600000&limit=15",
        ),
        // 今日完成数 — completed since 00:00. completed/total ratio drives 成功率 KPI.
        fetchJson<RunsResponse>(
          `/api/runs?status=completed,failed,timed_out,interrupted&since=${encodeURIComponent(today0.toISOString())}&limit=1000`,
        ),
        fetchJson<{ total?: number; tasks?: unknown[] }>("/api/human-tasks?status=pending"),
        fetchJson<{ pending: number }>("/api/em/dlq/count"),
        fetchJson<{ total?: number; events?: unknown[] }>(
          `/api/inngest-events?since=${encodeURIComponent(since1h)}`,
        ),
        // Active alerts — those not yet acked. Endpoint already filters by
        // resolved/unresolved at the source; we count unacked here for the
        // operator-attention signal in the system-status strip.
        fetchJson<{ alerts: Array<{ acked: boolean }> }>("/api/alerts"),
      ]);
      setActiveRuns(active.runs);
      setFailed1h(failed.runs);
      setAnomalies(recent.entries);
      setTodayRuns({
        total: todayFinished.runs.length,
        completed: todayFinished.runs.filter((r) => r.status === "completed").length,
      });
      setHitlPending(hitl.total ?? hitl.tasks?.length ?? 0);
      setDlqPending(dlq.pending);
      setEvents1h(events.total ?? events.events?.length ?? 0);
      setAlertsActive(alerts.alerts.filter((a) => !a.acked).length);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 8_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Diagnose "is the system actually emitting data?". When everything is
  // empty, surface a concrete banner explaining WHY (so users don't assume
  // the UI is broken when in fact no agents are running).
  const isAllIdle =
    health.agents.length > 0 &&
    health.agents.every((a) => a.status === "idle") &&
    (activeRuns?.length ?? 0) === 0 &&
    (anomalies?.length ?? 0) === 0;

  // Build matrix rows from AGENT_MAP (single source of truth — same set
  // /fleet renders). Deployment status mirrors /fleet's FleetStatus exactly;
  // runtime health is overlaid as a secondary signal.
  const matrixRows: MatrixRow[] = React.useMemo(() => {
    const rows: MatrixRow[] = AGENT_MAP.map((a) => {
      const kind = realnessMap.get(a.short) ?? "unbuilt";
      const live = liveByWsId.get(a.wsId);
      const deploy: DeployStatus =
        kind === "unbuilt" ? "not_deployed" :
        live?.paused       ? "paused" :
                             "online";
      return { short: a.short, deploy, health: health.byShort.get(a.short) ?? null };
    });
    // Sort: not_deployed → paused → online, then by failing runtime first,
    // then alpha. Puts attention-worthy gaps at the top of the matrix.
    const deployOrder: Record<DeployStatus, number> = { not_deployed: 0, paused: 1, online: 2 };
    const healthOrder: Record<AgentHealthStatus, number> = {
      failed: 0, degraded: 1, running: 2, healthy: 3, idle: 4,
    };
    rows.sort((x, y) => {
      if (deployOrder[x.deploy] !== deployOrder[y.deploy]) {
        return deployOrder[x.deploy] - deployOrder[y.deploy];
      }
      const hx = x.health ? healthOrder[x.health.status] : 4;
      const hy = y.health ? healthOrder[y.health.status] : 4;
      if (hx !== hy) return hx - hy;
      return x.short.localeCompare(y.short);
    });
    return rows;
  }, [liveByWsId, health.byShort, realnessMap]);

  const deployCounts = React.useMemo(() => {
    const out = { online: 0, paused: 0, not_deployed: 0 };
    for (const r of matrixRows) out[r.deploy]++;
    return out;
  }, [matrixRows]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto">
      <Header onRefresh={refresh} fetchedAt={health.fetchedAt} />
      {isAllIdle && <DataFlowDiagnostic />}
      <KpiBar
        agents={health.agents}
        deployCounts={deployCounts}
        activeCount={activeRuns?.length ?? null}
        failed1hCount={failed1h?.length ?? null}
        anomaly1hCount={anomalies?.length ?? null}
        todayRuns={todayRuns}
        hitlPending={hitlPending}
        dlqPending={dlqPending}
        events1h={events1h}
      />
      {error && (
        <div
          className="border-b border-line mono text-[11.5px]"
          style={{
            padding: "8px 22px",
            background: "var(--c-warn-bg)",
            color: "oklch(0.5 0.14 75)",
          }}
        >
          ⚠ 加载部分失败：{error}
        </div>
      )}
      {/* Single-column flow — anomalies moved out of the right rail and
          into the main vertical sequence (per Tier C of design proposal).
          Lose always-visible right-pane in trade for a calmer single-axis
          read. Max-width constrained so lines don't sprawl on wide screens. */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto" style={{ padding: "32px 32px", maxWidth: 1280 }}>
          <SystemStatusStrip deployCounts={deployCounts} alertsActive={alertsActive} />
          <AgentMatrix rows={matrixRows} loading={health.loading} counts={deployCounts} />
          <ActiveRunsSection runs={activeRuns} />
          <div className="mt-8">
            <AnomaliesSection entries={anomalies} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Data-flow diagnostic banner ──────────────────────────────────────
//
// Shows up when /overview can't find ANY signs of life — no active runs,
// no anomalies, all agents idle. The intent is to distinguish "UI is broken"
// from "system is registered but no one's emitting events". The latter is
// normal between operations; the banner just gives the user a one-click
// path to verify or trigger activity.

function DataFlowDiagnostic() {
  const { t } = useApp();
  const aoUrl = typeof window !== "undefined" ? window.location.origin : "<host>";
  return (
    <div
      className="border-b flex items-start gap-3"
      style={{
        background: "color-mix(in oklab, var(--c-info) 8%, transparent)",
        borderColor: "color-mix(in oklab, var(--c-info) 30%, var(--c-line))",
        padding: "12px 22px",
      }}
    >
      <Ic.alert />
      <div className="flex-1 text-[12px] leading-relaxed">
        <div className="font-semibold mb-1" style={{ color: "var(--c-info)" }}>
          {t("overview_diag_title")}
        </div>
        <div className="text-ink-2">{t("overview_diag_intro")}</div>
        <ul className="mt-2 text-ink-2" style={{ listStyle: "disc", paddingLeft: 18 }}>
          <li>
            {t("overview_diag_li_test")}{" "}
            <code className="mono text-[11px]">POST /api/test/trigger-requirement</code>
            {" "}{t("overview_diag_li_test_desc")}
          </li>
          <li>
            {t("overview_diag_li_publish")}{" "}
            <code className="mono text-[11px]">POST /api/inngest-events {`{name, data}`}</code>
          </li>
          <li>
            {t("overview_diag_li_sync")} <strong>InngestPill</strong> {t("overview_diag_li_sync_2")}{" "}
            <code className="mono text-[11px]">{aoUrl}/api/inngest</code>
          </li>
        </ul>
        <div className="text-ink-3 text-[11.5px] mt-2">
          {t("overview_diag_footer_runlog")}{" "}
          <Link href="/live" className="text-accent hover:underline">/live</Link>，
          {t("overview_diag_footer_config")}{" "}
          <Link href="/fleet" className="text-accent hover:underline">/fleet</Link> {t("overview_diag_footer_config_2")} InngestPill。
        </div>
      </div>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

function Header({
  onRefresh,
  fetchedAt,
}: {
  onRefresh: () => void;
  fetchedAt: Date | null;
}) {
  const { t } = useApp();
  return (
    <div
      className="border-b border-line bg-surface flex items-start"
      style={{ padding: "32px 32px 24px", gap: 24 }}
    >
      <div className="flex-1 min-w-0">
        <div
          className="text-[10.5px] uppercase tracking-[0.16em] font-medium text-ink-4 mb-2"
        >
          {t("overview_overline")}
        </div>
        <h1
          className="m-0 text-ink-1"
          style={{
            fontFamily: SERIF,
            fontWeight: 500,
            fontSize: 36,
            letterSpacing: "-0.015em",
            lineHeight: 1.1,
          }}
        >
          {t("overview_title")}
        </h1>
        <div className="text-ink-2 mt-2" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
          {t("overview_sub")}
        </div>
      </div>
      <div className="flex items-center gap-3 mt-1 shrink-0">
        <InngestPill />
        {fetchedAt && (
          <span className="text-[11px] text-ink-4 tabular-nums">
            {t("overview_updated_at")} {fetchedAt.toLocaleTimeString(undefined, { hour12: false })}
          </span>
        )}
        <Btn size="sm" variant="ghost" onClick={onRefresh}>
          <Ic.bolt /> {t("overview_refresh")}
        </Btn>
      </div>
    </div>
  );
}

// ── KPI bar ──────────────────────────────────────────────────────────

function KpiBar({
  agents,
  deployCounts,
  activeCount,
  failed1hCount,
  anomaly1hCount,
  todayRuns,
  hitlPending,
  dlqPending,
  events1h,
}: {
  agents: AgentHealth[];
  deployCounts: { online: number; paused: number; not_deployed: number };
  activeCount: number | null;
  failed1hCount: number | null;
  anomaly1hCount: number | null;
  todayRuns: { total: number; completed: number } | null;
  hitlPending: number | null;
  dlqPending: number | null;
  events1h: number | null;
}) {
  // Runtime health (AgentActivity-driven) is folded into anomaly · 1h KPI's
  // subtext so we don't double-count error signals. Deployment count is the
  // single "agents" KPI (matches /fleet exactly).
  const runtimeCounts = React.useMemo(() => {
    const out = { running: 0, healthy: 0, degraded: 0, failed: 0, idle: 0 };
    for (const a of agents) out[a.status] += 1;
    return out;
  }, [agents]);
  const totalAgents = deployCounts.online + deployCounts.paused + deployCounts.not_deployed;
  const runtimeUnhealthy = runtimeCounts.degraded + runtimeCounts.failed;

  const successRatePct =
    todayRuns && todayRuns.total > 0
      ? Math.round((todayRuns.completed / todayRuns.total) * 100)
      : null;

  const { t } = useApp();
  const tpl = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), s);
  const agentsSub = `${deployCounts.online} ${t("overview_kpi_agents_status_online")} · ${deployCounts.paused} ${t("overview_kpi_agents_status_paused")} · ${deployCounts.not_deployed} ${t("overview_kpi_agents_status_not_deployed")}`;
  const anomalySub =
    t("overview_kpi_anomaly_sub") +
    (runtimeUnhealthy > 0 ? ` · ${t("overview_kpi_anomaly_runtime_label")} ${runtimeUnhealthy}` : "");
  // Two rows of 4. Top row = operational state right now. Bottom row =
  // queues / throughput. All labels i18n-driven so zh/en switch is global.
  return (
    <div className="border-b border-line bg-surface" style={{ padding: "24px 32px" }}>
      <div className="grid mb-6" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 32 }}>
        <Kpi
          label={t("overview_kpi_active")}
          value={activeCount ?? "…"}
          sub={t("overview_kpi_active_sub")}
          href="/live?status=active"
        />
        <Kpi
          label={t("overview_kpi_failed")}
          value={failed1hCount ?? "…"}
          sub={t("overview_kpi_failed_sub")}
          tone={failed1hCount && failed1hCount > 0 ? "err" : undefined}
          href="/live?status=failed&time=1h"
        />
        <Kpi
          label={t("overview_kpi_anomaly")}
          value={anomaly1hCount ?? "…"}
          sub={anomalySub}
          tone={anomaly1hCount && anomaly1hCount > 0 ? "warn" : undefined}
          href="/monitor"
        />
        <Kpi
          label={t("overview_kpi_agents")}
          value={`${deployCounts.online}/${totalAgents}`}
          sub={agentsSub}
          tone={deployCounts.online === 0 && totalAgents > 0 ? "err" : "ok"}
          href="/fleet"
        />
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 32 }}>
        <Kpi
          label={t("overview_kpi_today")}
          value={successRatePct == null ? "—" : `${successRatePct}%`}
          sub={
            todayRuns
              ? tpl(t("overview_kpi_today_sub"), {
                  completed: todayRuns.completed,
                  total: todayRuns.total,
                })
              : t("overview_kpi_today_loading")
          }
          tone={
            successRatePct == null ? undefined
              : successRatePct >= 95 ? "ok"
              : successRatePct >= 80 ? "warn"
              : "err"
          }
          href="/live"
        />
        <Kpi
          label={t("overview_kpi_hitl")}
          value={hitlPending ?? "…"}
          sub={t("overview_kpi_hitl_sub")}
          tone={hitlPending && hitlPending > 0 ? "warn" : undefined}
          href="/inbox"
        />
        <Kpi
          label={t("overview_kpi_dlq")}
          value={dlqPending ?? "…"}
          sub={t("overview_kpi_dlq_sub")}
          tone={dlqPending && dlqPending > 0 ? "err" : undefined}
          href="/events"
        />
        <Kpi
          label={t("overview_kpi_events")}
          value={events1h ?? "…"}
          sub={t("overview_kpi_events_sub")}
          href="/events"
        />
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
  href,
}: {
  label: string;
  value: React.ReactNode;
  sub: string;
  tone?: "err" | "warn" | "ok";
  href?: string;
}) {
  // Claude metric styling — uppercase tracked label on top, big humanist
  // tabular-nums value (no mono — mono makes numbers feel like log output,
  // not a measurement), sub in muted ink. Color only flags problems;
  // healthy/default numbers stay neutral ink-1 to keep the page calm.
  const color =
    tone === "err"
      ? "var(--c-err)"
      : tone === "warn"
        ? "oklch(0.5 0.14 75)"
        : tone === "ok"
          ? "var(--c-ok)"
          : "var(--c-ink-1)";
  const inner = (
    <div
      className={href ? "cursor-pointer hover:opacity-70 transition-opacity" : ""}
      style={{ minHeight: 80 }}
    >
      <div
        className="text-[10px] uppercase tracking-[0.12em] font-medium text-ink-4 mb-2"
      >
        {label}
      </div>
      <div
        className="font-medium tabular-nums"
        style={{ fontSize: 30, color, lineHeight: 1.05, letterSpacing: "-0.01em" }}
      >
        {value}
      </div>
      <div className="text-[11px] text-ink-3 mt-1.5 leading-snug">{sub}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="no-underline">
      {inner}
    </Link>
  ) : (
    inner
  );
}

// ── System status strip ──────────────────────────────────────────────
//
// Replaces the 24-card AgentMatrix. Two reasons:
//   1. The KPI bar already shows agents · 实装 X/Y — the per-card detail
//      was redundant noise.
//   2. /fleet exists for the per-agent view; Overview should aggregate,
//      not duplicate.
//
// One compact horizontal strip showing 2 signal categories (deployment +
// alerts) with jump links to the dedicated pages.

function SystemStatusStrip({
  deployCounts,
  alertsActive,
}: {
  deployCounts: { online: number; paused: number; not_deployed: number };
  alertsActive: number | null;
}) {
  const { t } = useApp();
  const alertsLabel =
    alertsActive == null
      ? t("overview_status_loading")
      : alertsActive === 0
        ? t("overview_status_no_alerts")
        : t("overview_status_active_alerts");
  // Borderless chips with generous spacing — reads more like a status line
  // than a form. Big tabular-nums per count, soft glow on the dots (consistent
  // with Fleet's status indicator), uppercase tracked group labels.
  return (
    <section className="mb-8 flex items-center flex-wrap" style={{ gap: "8px 40px" }}>
      <StatusGroup label={t("overview_status_deploy")}>
        <StatusDot color="var(--c-ok)"   label={t("overview_kpi_agents_status_online")}       value={deployCounts.online} />
        <StatusDot color="var(--c-warn)" label={t("overview_kpi_agents_status_paused")}       value={deployCounts.paused} />
        <StatusDot color="var(--c-err)"  label={t("overview_kpi_agents_status_not_deployed")} value={deployCounts.not_deployed} />
        <Link href="/fleet" className="ml-2 text-[11.5px] text-accent hover:underline no-underline">
          {t("overview_jump_fleet")}
        </Link>
      </StatusGroup>
      <StatusGroup label={t("overview_status_alerts")}>
        <StatusDot
          color={alertsActive && alertsActive > 0 ? "var(--c-err)" : "var(--c-ink-4)"}
          label={alertsLabel}
          value={alertsActive ?? null}
        />
        <Link href="/alerts" className="ml-2 text-[11.5px] text-accent hover:underline no-underline">
          {t("overview_jump_alerts")}
        </Link>
      </StatusGroup>
    </section>
  );
}

function StatusGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-ink-4 text-[10px] uppercase tracking-[0.14em] font-medium">{label}</span>
      <div className="flex items-center gap-4">{children}</div>
    </div>
  );
}

function StatusDot({ color, label, value }: { color: string; label: string; value: number | null }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="rounded-full"
        style={{
          width: 8,
          height: 8,
          background: color,
          boxShadow: `0 0 0 3px color-mix(in oklab, ${color} 16%, transparent)`,
        }}
      />
      {value != null && (
        <span className="tabular-nums font-medium text-ink-1" style={{ fontSize: 15 }}>
          {value}
        </span>
      )}
      <span className="text-ink-2 text-[12px]">{label}</span>
    </span>
  );
}

// ── Agent matrix ─────────────────────────────────────────────────────
// AGENT_MAP 全量 agent；着色与 /fleet 同源（已上线 / 已暂停 / 未上线）。
// runtime health 作为副指示器叠加（部署正常但 runtime 失败的 agent 会带红
// 环），这样 ops 既能一眼看出"哪些没上线"，也不会丢失"哪些跑挂了"的信号。

function AgentMatrix({
  rows,
  loading,
  counts,
}: {
  rows: MatrixRow[];
  loading: boolean;
  counts: { online: number; paused: number; not_deployed: number };
}) {
  const { t } = useApp();
  return (
    <section className="mb-8">
      <div className="flex items-baseline gap-3 mb-4">
        <div className="text-[10px] uppercase tracking-[0.14em] font-medium text-ink-4">
          {t("overview_matrix_title")}
        </div>
        <span className="text-[11px] text-ink-3">
          {t("overview_matrix_source")}
        </span>
        <div className="flex-1" />
        <DeployLegend counts={counts} />
      </div>
      {loading && rows.length === 0 ? (
        <div className="text-[12px] text-ink-3 py-4">{t("overview_matrix_loading")}</div>
      ) : rows.length === 0 ? (
        <EmptyState title={t("overview_matrix_empty_title")} hint={t("overview_matrix_empty_hint")} />
      ) : (
        <div
          className="grid"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          {rows.map((r) => (
            <AgentCard key={r.short} row={r} />
          ))}
        </div>
      )}
    </section>
  );
}

function DeployLegend({ counts }: { counts: { online: number; paused: number; not_deployed: number } }) {
  const { t } = useApp();
  return (
    <div className="flex items-center gap-4 text-[11px] text-ink-3">
      <LegendDot color="var(--c-ok)"   label={t("overview_kpi_agents_status_online")}       value={counts.online} />
      <LegendDot color="var(--c-warn)" label={t("overview_kpi_agents_status_paused")}       value={counts.paused} />
      <LegendDot color="var(--c-err)"  label={t("overview_kpi_agents_status_not_deployed")} value={counts.not_deployed} />
    </div>
  );
}

function LegendDot({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="rounded-full"
        style={{
          width: 6,
          height: 6,
          background: color,
          boxShadow: `0 0 0 2px color-mix(in oklab, ${color} 14%, transparent)`,
        }}
      />
      <span className="tabular-nums font-medium text-ink-1">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function AgentCard({ row }: { row: MatrixRow }) {
  const { t } = useApp();
  const tone = DEPLOY_TONE[row.deploy];
  const fn = byShortFunction(row.short);
  const meta = byShort(row.short);
  const runtimeStatus = row.deploy !== "not_deployed" ? row.health?.status : null;
  const runtimeBadge = runtimeStatus ? RUNTIME_BADGE_TONE[runtimeStatus] : undefined;
  const counts = row.health?.counts;
  const errorCount = counts ? counts.failed + counts.error : 0;
  const lastLabel = row.health?.lastActivityAt
    ? new Date(row.health.lastActivityAt).toLocaleTimeString(undefined, { hour12: false })
    : null;
  const href = row.deploy === "not_deployed"
    ? `/fleet/${encodeURIComponent(row.short)}`
    : `/workflow?agent=${encodeURIComponent(row.short)}`;
  // Claude-style soft card: panel bg, larger rounded, no border by default
  // (border only on hover to keep page calm), generous padding, lowercase
  // friendly name (not mono), status conveyed by dot color + ring (no
  // redundant text label — that's noise once the dot is glowing).
  return (
    <Link
      href={href}
      className="no-underline rounded-[10px] bg-claude-panel hover:bg-surface hover:shadow-sm transition-all block"
      style={{
        padding: "12px 14px",
        opacity: row.deploy === "not_deployed" ? 0.7 : 1,
        border: "1px solid transparent",
      }}
    >
      <div className="flex items-center gap-2.5 mb-1">
        <span
          className="rounded-full flex-shrink-0"
          title={tone.label}
          style={{
            width: 8,
            height: 8,
            background: tone.color,
            boxShadow: `0 0 0 3px color-mix(in oklab, ${tone.color} 18%, transparent)`,
          }}
        />
        <span className="text-[13px] font-medium text-claude-ink-1 flex-1 truncate" style={{ letterSpacing: "-0.005em" }}>
          {meta?.inngestName ?? row.short}
        </span>
      </div>
      {fn && (
        <div className="text-[11px] text-claude-ink-3 mb-1.5 truncate leading-snug">
          {fn.summary}
        </div>
      )}
      <div className="text-[10.5px] text-claude-ink-4 flex items-center gap-1.5 tabular-nums">
        {row.deploy === "not_deployed" ? (
          <span>{t("overview_card_unregistered")}</span>
        ) : counts ? (
          <>
            <span>{counts.completed}/{counts.started} {t("overview_card_step_unit")}</span>
            {errorCount > 0 && (
              <span style={{ color: "var(--c-err)" }}>· {errorCount} {t("overview_card_err_unit")}</span>
            )}
            {counts.tool > 0 && <span>· {counts.tool} {t("overview_card_tool_unit")}</span>}
          </>
        ) : (
          <span>—</span>
        )}
        <div className="flex-1" />
        {runtimeBadge && (
          <span
            className="px-1.5 rounded text-[9.5px]"
            style={{
              color: runtimeBadge.color,
              background: `color-mix(in oklab, ${runtimeBadge.color} 12%, transparent)`,
              fontWeight: 600,
            }}
            title={runtimeBadge.label}
          >
            {runtimeBadge.label}
          </span>
        )}
        {lastLabel && <span title={row.health?.lastActivityAt ?? ""}>{lastLabel}</span>}
      </div>
    </Link>
  );
}

// ── Active runs ──────────────────────────────────────────────────────

function ActiveRunsSection({ runs }: { runs: RunSummary[] | null }) {
  const { t } = useApp();
  return (
    <section>
      <div className="flex items-baseline mb-3">
        <div className="text-[10px] uppercase tracking-[0.14em] font-medium text-ink-4 flex-1">
          {t("overview_active_title")}
        </div>
        <Link
          href="/live?status=active"
          className="text-[11px] text-ink-3 no-underline hover:text-accent"
        >
          {t("overview_active_view_all")}
        </Link>
      </div>
      {!runs ? (
        <div className="text-[12px] text-ink-3 py-4">{t("overview_matrix_loading")}</div>
      ) : runs.length === 0 ? (
        <div className="text-[11.5px] text-ink-3 py-4">{t("overview_active_empty")}</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 130 }}>{t("overview_active_th_start")}</th>
              <th style={{ width: 200 }}>{t("overview_active_th_event")}</th>
              <th>{t("overview_active_th_target")}</th>
              <th style={{ width: 100 }}>{t("overview_active_th_duration")}</th>
              <th style={{ width: 90 }}>HITL</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <ActiveRunRow key={r.id} run={r} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ActiveRunRow({ run }: { run: RunSummary }) {
  const { t } = useApp();
  const start = new Date(run.startedAt);
  const last = new Date(run.lastActivityAt);
  const durMs = Math.max(0, last.getTime() - start.getTime());
  return (
    <tr>
      <td className="mono text-[11px] text-ink-2">
        {start.toLocaleTimeString(undefined, { hour12: false })}
      </td>
      <td className="mono text-[11.5px] text-ink-1 truncate">{run.triggerEvent}</td>
      <td className="text-[11.5px] text-ink-2 truncate">
        {run.triggerData.client} · {run.triggerData.jdId}
      </td>
      <td className="mono text-[11px] text-ink-2 tabular-nums">{formatDuration(durMs)}</td>
      <td>
        {run.pendingHumanTasks > 0 ? (
          <Badge variant="warn">{run.pendingHumanTasks}</Badge>
        ) : (
          <span className="mono text-[10.5px] text-ink-4">—</span>
        )}
      </td>
      <td>
        <Link
          href={`/live?run=${encodeURIComponent(run.id)}`}
          className="mono text-[11px] text-ink-2 no-underline hover:text-ink-1"
        >
          {t("overview_active_open")}
        </Link>
      </td>
    </tr>
  );
}

// ── Anomalies feed ───────────────────────────────────────────────────

function AnomaliesSection({ entries }: { entries: LogEntry[] | null }) {
  const { t } = useApp();
  // Inline (post-Tier-C) — was a 360px right sidebar before. Header matches
  // ActiveRunsSection (uppercase tracked + right-aligned audit jump).
  return (
    <section>
      <div className="flex items-baseline mb-3">
        <div className="text-[10px] uppercase tracking-[0.14em] font-medium text-ink-4 flex-1">
          {t("overview_anomaly_title")}
        </div>
        <Link
          href="/audit"
          className="text-[11px] text-ink-3 no-underline hover:text-accent flex items-center gap-1"
        >
          <Ic.book /> {t("overview_anomaly_audit")}
        </Link>
      </div>
      {!entries ? (
        <div className="text-[12px] text-ink-3 py-6">{t("overview_matrix_loading")}</div>
      ) : entries.length === 0 ? (
        <div className="py-6">
          <EmptyState
            title={t("overview_anomaly_empty_title")}
            hint={t("overview_anomaly_empty_hint")}
          />
        </div>
      ) : (
        <div className="rounded-[10px] bg-claude-panel divide-y divide-claude-line/60 overflow-hidden">
          {entries.map((e) => (
            <AnomalyRow key={e.id} entry={e} />
          ))}
        </div>
      )}
    </section>
  );
}

function AnomalyRow({ entry }: { entry: LogEntry }) {
  const { t } = useApp();
  const ts = new Date(entry.ts);
  const tone =
    entry.kind === "step.failed" || entry.kind === "error"
      ? "var(--c-err)"
      : "oklch(0.5 0.14 75)";
  const kindLabel =
    entry.kind === "step.failed"
      ? t("overview_kind_step_failed")
      : entry.kind === "error"
        ? t("overview_kind_error")
        : t("overview_kind_anomaly");
  const inner = (
    <div className="cursor-pointer hover:bg-claude-surface transition-colors" style={{ padding: "14px 18px" }}>
      <div className="flex items-center gap-2 mb-1">
        <span
          className="rounded-full"
          style={{
            width: 6, height: 6, background: tone,
            boxShadow: `0 0 0 2px color-mix(in oklab, ${tone} 16%, transparent)`,
          }}
        />
        <span className="text-[10.5px] uppercase tracking-wide font-medium" style={{ color: tone }}>
          {kindLabel}
        </span>
        <span className="text-[12.5px] text-claude-ink-1 font-medium truncate flex-1" style={{ letterSpacing: "-0.005em" }}>
          {entry.agent}
        </span>
        <span className="text-[10.5px] text-claude-ink-4 tabular-nums shrink-0">
          {ts.toLocaleTimeString(undefined, { hour12: false })}
        </span>
      </div>
      <div className="text-[12px] text-claude-ink-2 leading-snug">{entry.message}</div>
    </div>
  );
  return entry.runId ? (
    <Link href={`/live?run=${encodeURIComponent(entry.runId)}`} className="no-underline block">
      {inner}
    </Link>
  ) : (
    inner
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
