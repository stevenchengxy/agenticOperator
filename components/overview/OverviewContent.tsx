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
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const since1h = new Date(Date.now() - 60 * 60_000).toISOString();
    try {
      const [active, failed, recent, todayFinished, hitl, dlq, events] = await Promise.all([
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
      <div
        className="flex-1 grid min-h-0"
        style={{
          gridTemplateColumns: "1fr 360px",
          gap: 0,
        }}
      >
        <div className="overflow-auto" style={{ padding: "16px 22px" }}>
          <AgentMatrix rows={matrixRows} loading={health.loading} counts={deployCounts} />
          <ActiveRunsSection runs={activeRuns} />
        </div>
        <aside className="border-l border-line bg-surface flex flex-col min-h-0 overflow-auto">
          <AnomaliesSection entries={anomalies} />
        </aside>
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
          事件总线空闲 · 当前无活跃 run、无最近异常
        </div>
        <div className="text-ink-2">
          这通常是<strong>正常</strong>的 — 系统在等下一个外部事件。如果你刚启动 dev server 想验证链路，下面几个常见入口：
        </div>
        <ul className="mt-2 text-ink-2" style={{ listStyle: "disc", paddingLeft: 18 }}>
          <li>
            发一个测试事件:{" "}
            <code className="mono text-[11px]">POST /api/test/trigger-requirement</code>
            {" "}— 触发 ReqAnalyzer → JDGenerator → ... 链路
          </li>
          <li>
            或直接 publish 任意事件:{" "}
            <code className="mono text-[11px]">POST /api/inngest-events {`{name, data}`}</code>
          </li>
          <li>
            智能体没注册? 在头部 <strong>InngestPill</strong> → <strong>同步新 App</strong> 填{" "}
            <code className="mono text-[11px]">${typeof window !== "undefined" ? window.location.origin : "<host>"}/api/inngest</code>
          </li>
        </ul>
        <div className="text-ink-3 text-[11.5px] mt-2">
          完整运行日志在{" "}
          <Link href="/live" className="text-accent hover:underline">/live</Link>，
          系统配置点头部{" "}
          <Link href="/fleet" className="text-accent hover:underline">/fleet</Link> 的 InngestPill。
        </div>
      </div>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────

function Header({
  onRefresh,
  fetchedAt,
}: {
  onRefresh: () => void;
  fetchedAt: Date | null;
}) {
  return (
    <div
      className="border-b border-line bg-surface flex items-center"
      style={{ padding: "14px 22px", gap: 18 }}
    >
      <div className="flex-1">
        <div className="text-[15px] font-semibold tracking-tight">总览</div>
        <div className="text-ink-3 text-[12px] mt-px">
          系统视角 · 当下整体跑得怎样。所有数字姓"系统"，不属于任何单条 run。
        </div>
      </div>
      <InngestPill />
      {fetchedAt && (
        <span className="mono text-[10.5px] text-ink-4">
          updated {fetchedAt.toLocaleTimeString(undefined, { hour12: false })}
        </span>
      )}
      <Btn size="sm" variant="ghost" onClick={onRefresh}>
        <Ic.bolt /> 刷新
      </Btn>
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

  // Two rows of 4. Top row = "operational state" (right now). Bottom row =
  // "queues / throughput" (work backlog + system pulse). Keeps each row at
  // ≤4 KPIs so the reader's eye never scans more than four numbers at once.
  return (
    <div className="border-b border-line bg-surface" style={{ padding: "14px 22px" }}>
      <div className="grid mb-3" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 18 }}>
        <Kpi
          label="active runs"
          value={activeCount ?? "…"}
          sub="运行中 / 暂停"
          href="/live?status=active"
        />
        <Kpi
          label="failed · 1h"
          value={failed1hCount ?? "…"}
          sub="失败 / 超时 / 中断"
          tone={failed1hCount && failed1hCount > 0 ? "err" : undefined}
          href="/live?status=failed&time=1h"
        />
        <Kpi
          label="anomaly · 1h"
          value={anomaly1hCount ?? "…"}
          sub={`跨 run 异常 / 错误${runtimeUnhealthy > 0 ? ` · runtime ${runtimeUnhealthy}` : ""}`}
          tone={anomaly1hCount && anomaly1hCount > 0 ? "warn" : undefined}
          href="/monitor"
        />
        <Kpi
          label="agents · 实装"
          value={`${deployCounts.online}/${totalAgents}`}
          sub={`${deployCounts.online} 已上线 · ${deployCounts.paused} 已暂停 · ${deployCounts.not_deployed} 未上线`}
          tone={deployCounts.online === 0 && totalAgents > 0 ? "err" : "ok"}
          href="/fleet"
        />
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 18 }}>
        <Kpi
          label="今日成功率"
          value={successRatePct == null ? "—" : `${successRatePct}%`}
          sub={
            todayRuns
              ? `${todayRuns.completed}/${todayRuns.total} runs · since 00:00`
              : "loading…"
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
          label="待人工 · HITL"
          value={hitlPending ?? "…"}
          sub="pending HumanTask"
          tone={hitlPending && hitlPending > 0 ? "warn" : undefined}
          href="/inbox"
        />
        <Kpi
          label="DLQ · 待重试"
          value={dlqPending ?? "…"}
          sub="event 校验失败 / 待处理"
          tone={dlqPending && dlqPending > 0 ? "err" : undefined}
          href="/events"
        />
        <Kpi
          label="事件吞吐 · 1h"
          value={events1h ?? "…"}
          sub="Inngest 总线 · 过去 1 小时"
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
  const color =
    tone === "err"
      ? "var(--c-err)"
      : tone === "warn"
        ? "oklch(0.5 0.14 75)"
        : tone === "ok"
          ? "var(--c-ok)"
          : "var(--c-ink-1)";
  const inner = (
    <div className={href ? "cursor-pointer hover:bg-panel rounded-sm transition-colors" : ""} style={href ? { padding: 4, margin: -4 } : undefined}>
      <div className="hint">{label}</div>
      <div
        className="font-semibold tracking-tight tabular-nums mono"
        style={{ fontSize: 22, color }}
      >
        {value}
      </div>
      <div className="mono text-[10.5px] text-ink-4">{sub}</div>
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
  return (
    <section className="mb-5">
      <div className="flex items-center gap-3 mb-2">
        <div className="text-[13px] font-semibold">Agent 矩阵</div>
        <span className="mono text-[10.5px] text-ink-4">
          与 /fleet 同源 · 部署状态
        </span>
        <div className="flex-1" />
        <DeployLegend counts={counts} />
      </div>
      {loading && rows.length === 0 ? (
        <div className="text-[12px] text-ink-3 py-4">加载中…</div>
      ) : rows.length === 0 ? (
        <EmptyState title="暂无 agent" hint="AGENT_MAP 为空" />
      ) : (
        <div
          className="grid"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 8,
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
  return (
    <div className="flex items-center gap-3 mono text-[10.5px] text-ink-3">
      <LegendDot color="var(--c-ok)"   label="已上线" value={counts.online} />
      <LegendDot color="var(--c-warn)" label="已暂停" value={counts.paused} />
      <LegendDot color="var(--c-err)"  label="未上线" value={counts.not_deployed} />
    </div>
  );
}

function LegendDot({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      <span>{label}</span>
      <span className="tabular-nums text-ink-2">{value}</span>
    </span>
  );
}

function AgentCard({ row }: { row: MatrixRow }) {
  const tone = DEPLOY_TONE[row.deploy];
  const fn = byShortFunction(row.short);
  const meta = byShort(row.short);
  // Runtime overlay: only meaningful when agent is actually deployed.
  const runtimeStatus = row.deploy !== "not_deployed" ? row.health?.status : null;
  const runtimeBadge = runtimeStatus ? RUNTIME_BADGE_TONE[runtimeStatus] : undefined;
  const counts = row.health?.counts;
  const errorCount = counts ? counts.failed + counts.error : 0;
  const lastLabel = row.health?.lastActivityAt
    ? new Date(row.health.lastActivityAt).toLocaleTimeString(undefined, { hour12: false })
    : null;
  // Unbuilt agents have no /workflow node; link back to fleet detail instead.
  const href = row.deploy === "not_deployed"
    ? `/fleet/${encodeURIComponent(row.short)}`
    : `/workflow?agent=${encodeURIComponent(row.short)}`;
  return (
    <Link
      href={href}
      className="no-underline border border-line rounded-md bg-surface hover:border-line-strong transition-colors block"
      style={{ padding: "8px 10px", opacity: row.deploy === "not_deployed" ? 0.85 : 1 }}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          title={tone.label}
          style={{
            background: tone.color,
            boxShadow: `0 0 0 3px color-mix(in oklab, ${tone.color} 18%, transparent)`,
          }}
        />
        <span className="mono text-[11.5px] font-semibold text-ink-1 flex-1 truncate">
          {meta?.inngestName ?? row.short}
        </span>
        <span
          className="mono text-[9.5px]"
          style={{ color: tone.color, fontWeight: 600 }}
        >
          {tone.label}
        </span>
      </div>
      {fn && <div className="text-[10.5px] text-ink-3 mb-1 truncate">{fn.summary}</div>}
      <div className="mono text-[10px] text-ink-4 flex items-center gap-2">
        {row.deploy === "not_deployed" ? (
          <span className="text-ink-3">未注册 Inngest function</span>
        ) : counts ? (
          <>
            <span>{counts.completed}/{counts.started} step</span>
            {errorCount > 0 && (
              <span style={{ color: "var(--c-err)" }}>· {errorCount} err</span>
            )}
            {counts.tool > 0 && <span>· {counts.tool} tool</span>}
          </>
        ) : (
          <span>—</span>
        )}
        <div className="flex-1" />
        {runtimeBadge && (
          <span
            className="px-1 rounded"
            style={{
              color: runtimeBadge.color,
              border: `1px solid color-mix(in oklab, ${runtimeBadge.color} 40%, transparent)`,
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
  return (
    <section>
      <div className="flex items-center mb-2">
        <div className="text-[13px] font-semibold flex-1">活跃 run</div>
        <Link
          href="/live?status=active"
          className="mono text-[10.5px] text-ink-3 no-underline hover:text-ink-1"
        >
          查看全部 →
        </Link>
      </div>
      {!runs ? (
        <div className="text-[12px] text-ink-3 py-4">加载中…</div>
      ) : runs.length === 0 ? (
        <div className="text-[11.5px] text-ink-3 py-4">当前无活跃 run。</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 130 }}>开始</th>
              <th style={{ width: 200 }}>触发事件</th>
              <th>客户 / JD</th>
              <th style={{ width: 100 }}>耗时</th>
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
          打开 →
        </Link>
      </td>
    </tr>
  );
}

// ── Anomalies feed ───────────────────────────────────────────────────

function AnomaliesSection({ entries }: { entries: LogEntry[] | null }) {
  return (
    <>
      <div className="border-b border-line" style={{ padding: "12px 16px" }}>
        <div className="text-[13px] font-semibold mb-0.5">最近异常 · 1h</div>
        <div className="text-[10.5px] text-ink-4">
          跨 run / 跨 agent · click → /live 详情
        </div>
      </div>
      {!entries ? (
        <div className="text-[12px] text-ink-3 p-4">加载中…</div>
      ) : entries.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="过去 1h 无异常"
            hint="所有 agent 都健康跑着——保持就好。"
          />
        </div>
      ) : (
        <div className="flex flex-col">
          {entries.map((e) => (
            <AnomalyRow key={e.id} entry={e} />
          ))}
        </div>
      )}
    </>
  );
}

function AnomalyRow({ entry }: { entry: LogEntry }) {
  const ts = new Date(entry.ts);
  const tone =
    entry.kind === "step.failed" || entry.kind === "error"
      ? "var(--c-err)"
      : "oklch(0.5 0.14 75)";
  const kindLabel =
    entry.kind === "step.failed"
      ? "✗ step.failed"
      : entry.kind === "error"
        ? "✗ error"
        : "⚠ anomaly";
  const inner = (
    <div className="border-b border-line cursor-pointer hover:bg-panel" style={{ padding: "8px 16px" }}>
      <div className="flex items-center gap-1.5 mb-0.5 mono text-[10px]">
        <span className="text-ink-4">{ts.toLocaleTimeString(undefined, { hour12: false })}</span>
        <span style={{ color: tone, fontWeight: 600 }}>{kindLabel}</span>
        <span className="text-ink-1 font-semibold truncate" style={{ flex: 1 }}>
          {entry.agent}
        </span>
      </div>
      <div className="text-[11.5px] text-ink-2 leading-snug">{entry.message}</div>
    </div>
  );
  return entry.runId ? (
    <Link href={`/live?run=${encodeURIComponent(entry.runId)}`} className="no-underline">
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
