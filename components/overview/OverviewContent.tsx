"use client";
import React from "react";
import Link from "next/link";
import { Ic } from "@/components/shared/Ic";
import { fetchJson } from "@/lib/api/client";
import type { RunsResponse, HumanTaskCard, HumanTasksResponse } from "@/lib/api/types";
import type { ActivityResponse, LogEntry, LogKind } from "@/lib/api/activity-types";
import { useAgentsHealth } from "@/lib/api/agents-health";
import type { AgentHealth } from "@/app/api/agents/health/route";
import { AGENT_MAP, displayName as agentDisplayName } from "@/lib/agent-mapping";
import { useDeploymentMap } from "@/lib/hooks/useDeploymentMap";
import { useInngestLiveOverlay } from "@/lib/api/inngest-live-overlay";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";

// /overview — operations dashboard.
//
// Redesigned 2026-06-01 per user request: drop the recruitment-funnel +
// 22-agent matrix in favor of a focused layout that generalizes across
// business domains.
//
// Sections:
//   A. Hero — overline, time-of-day greeting, status sentence, refresh.
//   B. KPI strip — 3 inline numbers (active runs / today's success rate
//      / pending HITL). No cards.
//   C. 2-column body — left: HITL list (待我处理); right: live event
//      stream (实时事件流). Both filtered to the AppBar's active domain.
//   D. Agent health grid — deployed agents in the active domain, one
//      card each (invocations + success rate). Click → /fleet/<short>.
//
// All sections respect useDomain() — switching the AppBar domain re-scopes
// the page in-place (no reload).

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

type OverallTone = "calm" | "tense" | "alarm";

export function OverviewContent() {
  const { t } = useApp();
  const { domain } = useDomain();
  const health = useAgentsHealth(4_000);
  const { byWsId: liveByWsId } = useInngestLiveOverlay();
  const { realness: realnessMap } = useDeploymentMap();

  const [activeCount, setActiveCount] = React.useState<number | null>(null);
  const [failed1hCount, setFailed1hCount] = React.useState<number | null>(null);
  const [todayRuns, setTodayRuns] = React.useState<{ total: number; completed: number } | null>(null);
  const [hitlTasks, setHitlTasks] = React.useState<HumanTaskCard[] | null>(null);
  const [stream, setStream] = React.useState<LogEntry[] | null>(null);
  const [dlqPending, setDlqPending] = React.useState<number | null>(null);
  const [alertsActive, setAlertsActive] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const since1h = new Date(Date.now() - 60 * 60_000).toISOString();
    try {
      const [active, failed, streamRes, todayFinished, hitl, dlq, alerts] = await Promise.all([
        fetchJson<RunsResponse>("/api/runs?status=running,paused&limit=20"),
        fetchJson<RunsResponse>(
          `/api/runs?status=failed,timed_out,interrupted&since=${encodeURIComponent(since1h)}&limit=20`,
        ),
        fetchJson<ActivityResponse>("/api/activity/recent?windowMs=3600000&limit=14"),
        fetchJson<RunsResponse>(
          `/api/runs?status=completed,failed,timed_out,interrupted&since=${encodeURIComponent(today0.toISOString())}&limit=1000`,
        ),
        fetchJson<HumanTasksResponse>("/api/human-tasks?status=pending"),
        fetchJson<{ pending: number }>("/api/em/dlq/count"),
        fetchJson<{ alerts: Array<{ acked: boolean }> }>("/api/alerts"),
      ]);
      setActiveCount(active.runs.length);
      setFailed1hCount(failed.runs.length);
      setStream(streamRes.entries);
      setTodayRuns({
        total: todayFinished.runs.length,
        completed: todayFinished.runs.filter((r) => r.status === "completed").length,
      });
      setHitlTasks(hitl.recent ?? []);
      setDlqPending(dlq.pending ?? 0);
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

  // Set of agent shorts in the current domain. Used to filter HITL list +
  // event stream + agent grid. "system" agent passes through (cross-domain).
  const shortsInDomain = React.useMemo(
    () => new Set(AGENT_MAP.filter((a) => a.domain === domain).map((a) => a.short)),
    [domain],
  );

  const hitlInDomain = React.useMemo<HumanTaskCard[] | null>(
    () => hitlTasks?.filter((tk) => shortsInDomain.has(tk.agentShort)) ?? null,
    [hitlTasks, shortsInDomain],
  );

  const streamInDomain = React.useMemo<LogEntry[] | null>(
    () => stream?.filter((e) => e.agent === "system" || shortsInDomain.has(e.agent)) ?? null,
    [stream, shortsInDomain],
  );

  // Deployed agents in domain, sorted by recent activity (most active first).
  const agentCards = React.useMemo(() => {
    return AGENT_MAP
      .filter((a) => a.domain === domain && a.short !== "Chatbot")
      .map((a) => ({
        agent: a,
        kind: realnessMap.get(a.short) ?? ("unbuilt" as const),
        paused: liveByWsId.get(a.wsId)?.paused ?? false,
        health: health.byShort.get(a.short) ?? null,
      }))
      .filter((c) => c.kind !== "unbuilt")
      .sort((x, y) => (y.health?.counts.started ?? 0) - (x.health?.counts.started ?? 0));
  }, [domain, realnessMap, liveByWsId, health.byShort]);

  const successRate =
    todayRuns && todayRuns.total > 0
      ? Math.round((todayRuns.completed / todayRuns.total) * 1000) / 10
      : null;

  const tone: OverallTone = computeTone(
    failed1hCount ?? 0,
    alertsActive ?? 0,
    dlqPending ?? 0,
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto">
      <HeroHeader
        t={t}
        activeCount={activeCount}
        hitlCount={hitlInDomain?.length ?? null}
        alertsActive={alertsActive}
        dlqPending={dlqPending}
        tone={tone}
        fetchedAt={health.fetchedAt}
        onRefresh={refresh}
      />
      {error && <ErrorBar message={error} />}
      <div className="flex-1">
        <div className="mx-auto" style={{ padding: "20px 32px 48px", maxWidth: 1280 }}>
          <KpiStrip
            t={t}
            activeCount={activeCount}
            successRate={successRate}
            todayRuns={todayRuns}
            hitlCount={hitlInDomain?.length ?? null}
          />
          <div
            className="grid mt-6"
            style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}
          >
            <TodoPanel t={t} tasks={hitlInDomain} />
            <EventStreamPanel
              t={t}
              entries={streamInDomain}
              activeCount={activeCount}
            />
          </div>
          <div className="mt-6">
            <AgentHealthGrid t={t} cards={agentCards} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Hero header ─────────────────────────────────────────────────────────

function HeroHeader({
  t,
  activeCount,
  hitlCount,
  alertsActive,
  dlqPending,
  tone,
  fetchedAt,
  onRefresh,
}: {
  t: (k: string) => string;
  activeCount: number | null;
  hitlCount: number | null;
  alertsActive: number | null;
  dlqPending: number | null;
  tone: OverallTone;
  fetchedAt: Date | null;
  onRefresh: () => void;
}) {
  const greeting = greetingForHour(new Date().getHours(), t);
  const toneKey =
    tone === "calm"
      ? "overview_status_calm"
      : tone === "tense"
        ? "overview_status_tense"
        : "overview_status_alarm";
  const sentence = t("overview_status_sentence")
    .replace("{active}", activeCount === null ? "…" : String(activeCount))
    .replace("{hitl}", hitlCount === null ? "…" : String(hitlCount))
    .replace("{tone}", t(toneKey));
  const statusStrip = t("overview_status_strip")
    .replace("{alerts}", alertsActive === null ? "…" : String(alertsActive))
    .replace("{dlq}", dlqPending === null ? "…" : String(dlqPending));

  return (
    <div
      className="border-b border-line bg-surface flex items-start"
      style={{ padding: "28px 32px 20px", gap: 24 }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[10.5px] uppercase tracking-[0.16em] font-medium text-ink-4 mb-2">
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
          {greeting}，{t("overview_team_label")}
        </h1>
        <div
          className="text-ink-2 mt-2"
          style={{ fontSize: 13.5, lineHeight: 1.55, maxWidth: 720 }}
        >
          {sentence}
        </div>
      </div>
      <div className="flex flex-col items-end gap-3" style={{ minWidth: 220 }}>
        <div className="flex items-center gap-2">
          <span
            className="inline-block rounded-full"
            style={{
              width: 6,
              height: 6,
              background: "var(--c-ok)",
              boxShadow: `0 0 0 3px color-mix(in oklab, var(--c-ok) 18%, transparent)`,
            }}
          />
          <span className="mono text-[11.5px] text-ink-3">
            {t("overview_realtime_label")} ·{" "}
            {fetchedAt ? formatTime(fetchedAt) : "—"}
          </span>
          <button
            onClick={onRefresh}
            title="刷新"
            className="inline-flex items-center gap-1 text-[11.5px] border border-line rounded-sm bg-panel text-ink-2 cursor-pointer hover:border-line-strong"
            style={{ padding: "2px 8px" }}
          >
            <span style={{ fontSize: 10 }}>↻</span> 刷新
          </button>
        </div>
        <div
          className="text-ink-3 mono text-[11px] text-right"
          style={{ lineHeight: 1.5 }}
        >
          {statusStrip}
        </div>
      </div>
    </div>
  );
}

function ErrorBar({ message }: { message: string }) {
  return (
    <div
      className="border-b mono text-[11.5px]"
      style={{
        padding: "8px 22px",
        background: "var(--c-warn-bg)",
        borderColor: "color-mix(in oklab, oklch(0.5 0.14 75) 25%, var(--c-line))",
        color: "oklch(0.5 0.14 75)",
      }}
    >
      ⚠ 加载部分失败:{message}
    </div>
  );
}

// ── KPI strip ───────────────────────────────────────────────────────────

function KpiStrip({
  t,
  activeCount,
  successRate,
  todayRuns,
  hitlCount,
}: {
  t: (k: string) => string;
  activeCount: number | null;
  successRate: number | null;
  todayRuns: { total: number; completed: number } | null;
  hitlCount: number | null;
}) {
  return (
    <div className="flex items-baseline gap-10 flex-wrap" style={{ paddingTop: 4 }}>
      <Kpi
        valueColor="var(--c-accent)"
        value={activeCount === null ? "…" : String(activeCount)}
        label={t("overview_kpi_active")}
      />
      <Kpi
        valueColor={
          successRate === null
            ? "var(--c-ink-3)"
            : successRate >= 95
              ? "var(--c-ok)"
              : successRate >= 85
                ? "oklch(0.6 0.14 75)"
                : "var(--c-err)"
        }
        value={
          successRate === null
            ? "—"
            : `${successRate}%`
        }
        label={t("overview_kpi_success_label")}
        sub={
          todayRuns
            ? `${todayRuns.completed} / ${todayRuns.total} 次运行`
            : undefined
        }
      />
      <Kpi
        valueColor={
          hitlCount === null
            ? "var(--c-ink-3)"
            : hitlCount > 0
              ? "oklch(0.6 0.14 75)"
              : "var(--c-ink-2)"
        }
        value={hitlCount === null ? "…" : String(hitlCount)}
        label={t("overview_kpi_hitl_label")}
      />
    </div>
  );
}

function Kpi({
  value,
  label,
  sub,
  valueColor,
}: {
  value: string;
  label: string;
  sub?: string;
  valueColor: string;
}) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span
        className="tabular-nums"
        style={{
          fontFamily: SERIF,
          fontWeight: 500,
          fontSize: 30,
          letterSpacing: "-0.02em",
          lineHeight: 1,
          color: valueColor,
        }}
      >
        {value}
      </span>
      <div className="flex flex-col">
        <span className="text-ink-1" style={{ fontSize: 13 }}>
          {label}
        </span>
        {sub && (
          <span className="text-ink-3 mono" style={{ fontSize: 10.5 }}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Todo panel ──────────────────────────────────────────────────────────

function TodoPanel({
  t,
  tasks,
}: {
  t: (k: string) => string;
  tasks: HumanTaskCard[] | null;
}) {
  return (
    <section
      className="border border-line rounded-md bg-surface flex flex-col"
      style={{ padding: "16px 18px", minHeight: 320 }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div className="flex items-center gap-2">
          <span
            className="text-ink-1"
            style={{ fontSize: 14, fontWeight: 500 }}
          >
            {t("overview_todo_title")}
          </span>
          {tasks && tasks.length > 0 && (
            <span
              className="rounded-sm mono tabular-nums"
              style={{
                fontSize: 11,
                padding: "1px 7px",
                background: "color-mix(in oklab, oklch(0.6 0.14 75) 15%, var(--c-bg))",
                color: "oklch(0.5 0.14 75)",
                border: "1px solid color-mix(in oklab, oklch(0.6 0.14 75) 35%, var(--c-line))",
              }}
            >
              {tasks.length}
            </span>
          )}
        </div>
        <Link
          href="/inbox"
          className="text-ink-3 text-[11.5px] hover:text-ink-1"
          style={{ textDecoration: "none" }}
        >
          {t("overview_todo_inbox")} →
        </Link>
      </div>
      <div className="flex-1 flex flex-col" style={{ gap: 8 }}>
        {tasks === null ? (
          <div className="text-ink-3 text-[12px]">加载中…</div>
        ) : tasks.length === 0 ? (
          <div className="text-ink-3 text-[12px]">{t("overview_todo_empty")}</div>
        ) : (
          tasks.slice(0, 6).map((tk) => <TodoRow key={tk.id} task={tk} />)
        )}
      </div>
    </section>
  );
}

function TodoRow({ task }: { task: HumanTaskCard }) {
  const agentMeta = AGENT_MAP.find((a) => a.short === task.agentShort);
  const stage = agentMeta?.stage ?? "system";
  const glyph = stageGlyph(stage);
  const subtitle = `${agentDisplayName(task.agentShort)}${task.assignee ? ` · ${task.assignee}` : ""}`;
  return (
    <Link
      href={`/inbox?task=${encodeURIComponent(task.id)}`}
      className="flex items-start gap-3 rounded-sm cursor-pointer hover:bg-panel"
      style={{
        padding: "8px 6px",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <span
        className="flex-none flex items-center justify-center rounded-sm text-[11px] font-medium"
        style={{
          width: 28,
          height: 28,
          background: glyph.bg,
          color: glyph.color,
        }}
      >
        {glyph.label}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-ink-1 truncate" style={{ fontSize: 12.5 }}>
          {task.title}
        </div>
        <div className="text-ink-3 mono text-[10.5px] truncate" style={{ marginTop: 2 }}>
          {subtitle}
        </div>
      </div>
      <span
        className="text-ink-4 mono text-[10.5px] flex-none"
        style={{ paddingTop: 2 }}
      >
        {relativeTime(task.createdAt)}
      </span>
    </Link>
  );
}

// ── Event stream ────────────────────────────────────────────────────────

function EventStreamPanel({
  t,
  entries,
  activeCount,
}: {
  t: (k: string) => string;
  entries: LogEntry[] | null;
  activeCount: number | null;
}) {
  return (
    <section
      className="border border-line rounded-md bg-surface flex flex-col"
      style={{ padding: "16px 18px", minHeight: 320 }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div className="flex items-center gap-2">
          <span
            className="text-ink-1"
            style={{ fontSize: 14, fontWeight: 500 }}
          >
            {t("overview_stream_title")}
          </span>
          {activeCount !== null && activeCount > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-sm mono"
              style={{
                fontSize: 10.5,
                padding: "1px 6px",
                color: "var(--c-accent)",
                background: "color-mix(in oklab, var(--c-accent) 12%, var(--c-bg))",
                border:
                  "1px solid color-mix(in oklab, var(--c-accent) 35%, var(--c-line))",
              }}
            >
              <span
                className="rounded-full"
                style={{
                  width: 5,
                  height: 5,
                  background: "var(--c-accent)",
                }}
              />
              {activeCount} 活跃运行
            </span>
          )}
        </div>
        <Link
          href="/events"
          className="text-ink-3 text-[11.5px] hover:text-ink-1"
          style={{ textDecoration: "none" }}
        >
          {t("overview_stream_all")} →
        </Link>
      </div>
      <div className="flex-1 flex flex-col" style={{ gap: 6 }}>
        {entries === null ? (
          <div className="text-ink-3 text-[12px]">加载中…</div>
        ) : entries.length === 0 ? (
          <div className="text-ink-3 text-[12px]">{t("overview_stream_empty")}</div>
        ) : (
          entries.slice(0, 10).map((e) => <EventRow key={e.id} entry={e} />)
        )}
      </div>
    </section>
  );
}

function EventRow({ entry }: { entry: LogEntry }) {
  const tone = kindTone(entry.kind);
  const eventName = pickEventName(entry);
  const href = `/events/${encodeURIComponent(eventName)}`;
  const agentName =
    entry.agent === "system" ? null : agentDisplayName(entry.agent);
  return (
    <Link
      href={href}
      className="flex items-start gap-3 rounded-sm cursor-pointer hover:bg-panel"
      style={{
        padding: "6px 6px",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <span
        className="flex-none rounded-full"
        style={{
          width: 7,
          height: 7,
          background: tone.color,
          marginTop: 7,
          boxShadow:
            tone.kind === "err"
              ? `0 0 0 3px color-mix(in oklab, ${tone.color} 22%, transparent)`
              : undefined,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: tone.color,
              fontWeight: 500,
              letterSpacing: "0.02em",
            }}
          >
            {eventName}
          </span>
        </div>
        <div className="text-ink-2 truncate" style={{ fontSize: 12, marginTop: 2 }}>
          {agentName ? `${agentName} · ` : ""}
          {entry.message}
        </div>
      </div>
      <span
        className="text-ink-4 mono text-[10.5px] flex-none"
        style={{ paddingTop: 4 }}
      >
        {relativeTime(entry.ts)}
      </span>
    </Link>
  );
}

// ── Agent health grid ───────────────────────────────────────────────────

type AgentCard = {
  agent: (typeof AGENT_MAP)[number];
  kind: "real" | "shell" | "unbuilt";
  paused: boolean;
  health: AgentHealth | null;
};

function AgentHealthGrid({
  t,
  cards,
}: {
  t: (k: string) => string;
  cards: AgentCard[];
}) {
  return (
    <section
      className="border border-line rounded-md bg-surface"
      style={{ padding: "16px 18px" }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
        <div className="flex items-center gap-2">
          <span className="text-ink-1" style={{ fontSize: 14, fontWeight: 500 }}>
            {t("overview_health_title")}
          </span>
          <span className="text-ink-3 mono text-[11px]">
            {t("overview_health_running").replace("{n}", String(cards.length))}
          </span>
        </div>
        <Link
          href="/fleet"
          className="text-ink-3 text-[11.5px] hover:text-ink-1"
          style={{ textDecoration: "none" }}
        >
          {t("overview_health_link")} →
        </Link>
      </div>
      {cards.length === 0 ? (
        <div
          className="text-ink-3 text-[12.5px] text-center"
          style={{ padding: "32px 0" }}
        >
          {t("overview_health_empty")}
        </div>
      ) : (
        <div
          className="grid"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}
        >
          {cards.map((c) => (
            <AgentHealthCard key={c.agent.short} card={c} />
          ))}
        </div>
      )}
    </section>
  );
}

function AgentHealthCard({ card }: { card: AgentCard }) {
  const { agent, paused, health } = card;
  const name = agentDisplayName(agent.short);
  const runs = health?.counts.started ?? 0;
  const denom =
    (health?.counts.started ?? 0) +
    (health?.counts.completed ?? 0) +
    (health?.counts.failed ?? 0) +
    (health?.counts.error ?? 0);
  const successPct =
    denom > 0
      ? Math.round((1 - (health?.errorRate ?? 0)) * 1000) / 10
      : null;
  const glyph = stageGlyph(agent.stage);
  const dot = paused
    ? "var(--c-ink-4)"
    : health?.status === "failed"
      ? "var(--c-err)"
      : health?.status === "degraded"
        ? "oklch(0.6 0.14 75)"
        : "var(--c-ok)";
  return (
    <Link
      href={`/fleet/${encodeURIComponent(agent.short)}`}
      className="flex items-center gap-3 rounded-sm border border-line cursor-pointer hover:border-line-strong"
      style={{
        padding: "10px 12px",
        background: "var(--c-bg)",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <span
        className="flex-none flex items-center justify-center rounded-sm text-[12px] font-medium"
        style={{
          width: 32,
          height: 32,
          background: glyph.bg,
          color: glyph.color,
        }}
      >
        {glyph.label}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="text-ink-1 truncate"
            style={{ fontSize: 13, fontWeight: 500 }}
          >
            {name}
          </span>
        </div>
        <div className="mono text-ink-3" style={{ fontSize: 10.5, marginTop: 2 }}>
          {runs} 次 ·{" "}
          {successPct === null ? "—" : `${successPct}%`}
        </div>
      </div>
      <span
        className="rounded-full flex-none"
        style={{
          width: 7,
          height: 7,
          background: dot,
        }}
      />
    </Link>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function greetingForHour(h: number, t: (k: string) => string): string {
  if (h < 5) return t("overview_greeting_dawn");
  if (h < 11) return t("overview_greeting_morning");
  if (h < 13) return t("overview_greeting_noon");
  if (h < 18) return t("overview_greeting_afternoon");
  return t("overview_greeting_evening");
}

function computeTone(failed1h: number, alertsActive: number, dlqPending: number): OverallTone {
  if (failed1h >= 10 || dlqPending > 5 || alertsActive >= 5) return "alarm";
  if (failed1h >= 3 || alertsActive >= 2) return "tense";
  return "calm";
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
  return `${Math.floor(diff / (24 * 60 * 60_000))} 天前`;
}

const KIND_TONE: Record<LogKind, { color: string; kind: "ok" | "info" | "warn" | "err" }> = {
  "step.started": { color: "var(--c-info)", kind: "info" },
  "step.completed": { color: "var(--c-ok)", kind: "ok" },
  "step.failed": { color: "var(--c-err)", kind: "err" },
  "step.retrying": { color: "oklch(0.6 0.14 75)", kind: "warn" },
  narrative: { color: "var(--c-ink-3)", kind: "info" },
  tool: { color: "var(--c-info)", kind: "info" },
  decision: { color: "var(--c-accent)", kind: "info" },
  anomaly: { color: "oklch(0.6 0.14 75)", kind: "warn" },
  error: { color: "var(--c-err)", kind: "err" },
  hitl: { color: "oklch(0.6 0.14 75)", kind: "warn" },
  info: { color: "var(--c-info)", kind: "info" },
};

function kindTone(kind: LogKind): { color: string; kind: "ok" | "info" | "warn" | "err" } {
  return KIND_TONE[kind] ?? { color: "var(--c-ink-3)", kind: "info" };
}

/** Best-effort: pick a stable name to render in the EVENT_NAME slot.
 *  - synthesized step rows: use the kind (STEP_FAILED etc)
 *  - tool/decision/anomaly: use the kind verbatim uppercased
 *  - otherwise: prefer agent.short if non-system, else fallback to kind */
function pickEventName(entry: LogEntry): string {
  // metadata may carry the originating event name when the row was synthesized
  const meta = entry.metadata as { eventName?: unknown } | null;
  if (meta && typeof meta.eventName === "string" && meta.eventName.trim()) {
    return meta.eventName;
  }
  return entry.kind.replace(/\./g, "_").toUpperCase();
}

/** Small badge for a workflow stage — used in HITL rows + agent health cards. */
function stageGlyph(stage: string): { label: string; bg: string; color: string } {
  switch (stage) {
    case "requirement":
      return { label: "需", bg: "color-mix(in oklab, var(--c-info) 14%, var(--c-bg))", color: "var(--c-info)" };
    case "jd":
      return { label: "J", bg: "color-mix(in oklab, var(--c-accent) 14%, var(--c-bg))", color: "var(--c-accent)" };
    case "resume":
      return { label: "简", bg: "color-mix(in oklab, oklch(0.65 0.18 195) 14%, var(--c-bg))", color: "oklch(0.55 0.18 195)" };
    case "match":
      return { label: "岗", bg: "color-mix(in oklab, oklch(0.55 0.16 285) 16%, var(--c-bg))", color: "oklch(0.55 0.16 285)" };
    case "interview":
      return { label: "面", bg: "color-mix(in oklab, var(--c-ok) 14%, var(--c-bg))", color: "var(--c-ok)" };
    case "eval":
      return { label: "评", bg: "color-mix(in oklab, var(--c-ok) 14%, var(--c-bg))", color: "var(--c-ok)" };
    case "package":
      return { label: "包", bg: "color-mix(in oklab, oklch(0.6 0.14 75) 14%, var(--c-bg))", color: "oklch(0.5 0.14 75)" };
    case "submit":
      return { label: "投", bg: "color-mix(in oklab, var(--c-accent) 14%, var(--c-bg))", color: "var(--c-accent)" };
    default:
      return { label: "系", bg: "var(--c-panel)", color: "var(--c-ink-3)" };
  }
}
