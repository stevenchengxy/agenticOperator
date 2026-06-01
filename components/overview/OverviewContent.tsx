"use client";
import React from "react";
import Link from "next/link";
import { Ic } from "@/components/shared/Ic";
import { fetchJson } from "@/lib/api/client";
import type { RunsResponse, HumanTaskCard, HumanTasksResponse } from "@/lib/api/types";
import type { ActivityResponse, LogEntry, LogKind } from "@/lib/api/activity-types";
import { useAgentsHealth } from "@/lib/api/agents-health";
import type { AgentHealth } from "@/app/api/agents/health/route";
import { useInngestEventsStream } from "@/lib/api/inngest-events-stream";
import type { InngestEventRow } from "@/lib/api/inngest-events";
import { AGENT_MAP } from "@/lib/agent-mapping";
import { useDeploymentMap } from "@/lib/hooks/useDeploymentMap";
import { useInngestLiveOverlay } from "@/lib/api/inngest-live-overlay";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";
import { useDisplayNameResolver } from "@/lib/agent-names";

// /overview — operations dashboard, redesigned 2026-06-01.
//
// Sections:
//   A. Hero — overline, time-of-day greeting, status sentence, refresh.
//   B. KPI strip — 3 inline numbers (active runs / today's success rate
//      / pending HITL). No cards.
//   C. 2-column body — left: HITL list (待我处理); right: live event
//      stream via SSE (实时事件流). Stream falls back to polling.
//   D. Agent runtime monitor — compact full-width strip showing recent
//      step-level activity from agents (started/completed/failed/anomaly).
//   E. Agent health grid — deployed agents in the active domain, one
//      card each. Status badge (上线/下线/暂停) + invocations + success.
//      Hides metrics row when there are no runs.

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

type OverallTone = "calm" | "tense" | "alarm";

export function OverviewContent() {
  const { t } = useApp();
  const { domain } = useDomain();
  const health = useAgentsHealth(4_000);
  const { byWsId: liveByWsId } = useInngestLiveOverlay();
  const { realness: realnessMap } = useDeploymentMap();
  const resolveName = useDisplayNameResolver();

  // SSE-backed Inngest event stream (real-time). Falls back to 2s polling.
  const eventStream = useInngestEventsStream();

  // KPI + activity (still polled every 8s — these are aggregate snapshots).
  const [activeCount, setActiveCount] = React.useState<number | null>(null);
  const [failed1hCount, setFailed1hCount] = React.useState<number | null>(null);
  const [todayRuns, setTodayRuns] = React.useState<{ total: number; completed: number } | null>(null);
  const [hitlTasks, setHitlTasks] = React.useState<HumanTaskCard[] | null>(null);
  const [activity, setActivity] = React.useState<LogEntry[] | null>(null);
  const [alertsActive, setAlertsActive] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const since1h = new Date(Date.now() - 60 * 60_000).toISOString();
    try {
      const [active, failed, activityRes, todayFinished, hitl, alerts] = await Promise.all([
        fetchJson<RunsResponse>("/api/runs?status=running,paused&limit=20"),
        fetchJson<RunsResponse>(
          `/api/runs?status=failed,timed_out,interrupted&since=${encodeURIComponent(since1h)}&limit=20`,
        ),
        fetchJson<ActivityResponse>("/api/activity/recent?windowMs=1800000&limit=18"),
        fetchJson<RunsResponse>(
          `/api/runs?status=completed,failed,timed_out,interrupted&since=${encodeURIComponent(today0.toISOString())}&limit=1000`,
        ),
        fetchJson<HumanTasksResponse>("/api/human-tasks?status=pending"),
        fetchJson<{ alerts: Array<{ acked: boolean }> }>("/api/alerts"),
      ]);
      setActiveCount(active.runs.length);
      setFailed1hCount(failed.runs.length);
      setActivity(activityRes.entries);
      setTodayRuns({
        total: todayFinished.runs.length,
        completed: todayFinished.runs.filter((r) => r.status === "completed").length,
      });
      setHitlTasks(hitl.recent ?? []);
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

  // Set of agent shorts in the current domain.
  const shortsInDomain = React.useMemo(
    () => new Set(AGENT_MAP.filter((a) => a.domain === domain).map((a) => a.short)),
    [domain],
  );

  const hitlInDomain = React.useMemo<HumanTaskCard[] | null>(
    () => hitlTasks?.filter((tk) => shortsInDomain.has(tk.agentShort)) ?? null,
    [hitlTasks, shortsInDomain],
  );

  const activityInDomain = React.useMemo<LogEntry[] | null>(
    () => activity?.filter((e) => e.agent === "system" || shortsInDomain.has(e.agent)) ?? null,
    [activity, shortsInDomain],
  );

  // Deployed agents in domain, sorted by recent activity (most active first).
  const agentCards = React.useMemo<AgentCard[]>(() => {
    return AGENT_MAP
      .filter((a) => a.domain === domain && a.short !== "Chatbot")
      .map((a) => ({
        agent: a,
        kind: realnessMap.get(a.short) ?? ("unbuilt" as const),
        paused: liveByWsId.get(a.wsId)?.paused ?? false,
        health: health.byShort.get(a.short) ?? null,
      }))
      .sort((x, y) => {
        // online > paused > unbuilt; within online, more runs first
        const rx = statusOrder(x);
        const ry = statusOrder(y);
        if (rx !== ry) return rx - ry;
        return (y.health?.counts.started ?? 0) - (x.health?.counts.started ?? 0);
      });
  }, [domain, realnessMap, liveByWsId, health.byShort]);

  const successRate =
    todayRuns && todayRuns.total > 0
      ? Math.round((todayRuns.completed / todayRuns.total) * 1000) / 10
      : null;

  const tone: OverallTone = computeTone(
    failed1hCount ?? 0,
    alertsActive ?? 0,
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto">
      <HeroHeader
        t={t}
        activeCount={activeCount}
        hitlCount={hitlInDomain?.length ?? null}
        alertsActive={alertsActive}
        tone={tone}
        fetchedAt={health.fetchedAt}
        onRefresh={refresh}
      />
      {error && <ErrorBar message={error} />}
      <div className="flex-1">
        <div
          className="mx-auto ao-fade-rise"
          style={{ padding: "20px 32px 48px", maxWidth: 1280 }}
        >
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
            <TodoPanel t={t} tasks={hitlInDomain} resolveName={resolveName} />
            <EventStreamPanel
              t={t}
              events={eventStream.events}
              connected={eventStream.connected}
              lastFetchAt={eventStream.lastFetchAt}
            />
          </div>
          <div className="mt-6">
            <AgentRuntimePanel
              t={t}
              entries={activityInDomain}
              resolveName={resolveName}
            />
          </div>
          <div className="mt-6">
            <AgentHealthGrid t={t} cards={agentCards} resolveName={resolveName} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Hero ────────────────────────────────────────────────────────────────

function HeroHeader({
  t,
  activeCount,
  hitlCount,
  alertsActive,
  tone,
  fetchedAt,
  onRefresh,
}: {
  t: (k: string) => string;
  activeCount: number | null;
  hitlCount: number | null;
  alertsActive: number | null;
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
  const toneAccent =
    tone === "calm"
      ? "var(--c-ok)"
      : tone === "tense"
        ? "oklch(0.6 0.14 75)"
        : "var(--c-err)";
  const sentence = t("overview_status_sentence")
    .replace("{active}", activeCount === null ? "…" : String(activeCount))
    .replace("{hitl}", hitlCount === null ? "…" : String(hitlCount))
    .replace("{tone}", t(toneKey));
  const statusStrip = t("overview_status_strip")
    .replace("{alerts}", alertsActive === null ? "…" : String(alertsActive));

  return (
    <div
      className="border-b border-line flex items-start ao-pop-in"
      style={{
        padding: "32px 32px 22px",
        gap: 24,
        background: `linear-gradient(135deg,
          color-mix(in oklab, ${toneAccent} 8%, var(--c-surface)) 0%,
          var(--c-surface) 55%,
          color-mix(in oklab, var(--c-accent) 4%, var(--c-surface)) 100%)`,
      }}
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
            className="inline-block rounded-full anim-pulse"
            style={{
              width: 6,
              height: 6,
              background: toneAccent,
              boxShadow: `0 0 0 3px color-mix(in oklab, ${toneAccent} 22%, transparent)`,
            }}
          />
          <span className="mono text-[11.5px] text-ink-3">
            {t("overview_realtime_label")} ·{" "}
            {fetchedAt ? formatTime(fetchedAt) : "—"}
          </span>
          <button
            onClick={onRefresh}
            title="刷新"
            className="ao-hover-lift inline-flex items-center gap-1 text-[11.5px] border border-line rounded-sm bg-panel text-ink-2 cursor-pointer hover:border-line-strong"
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
        value={successRate === null ? "—" : `${successRate}%`}
        label={t("overview_kpi_success_label")}
        sub={todayRuns ? `${todayRuns.completed} / ${todayRuns.total} 次运行` : undefined}
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

// ── HITL ────────────────────────────────────────────────────────────────

function TodoPanel({
  t,
  tasks,
  resolveName,
}: {
  t: (k: string) => string;
  tasks: HumanTaskCard[] | null;
  resolveName: (short: string) => string;
}) {
  return (
    <section
      className="border border-line rounded-md bg-surface flex flex-col"
      style={{ padding: "16px 18px", minHeight: 320 }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div className="flex items-center gap-2">
          <span className="text-ink-1" style={{ fontSize: 14, fontWeight: 500 }}>
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
          tasks.slice(0, 6).map((tk, i) => (
            <TodoRow key={tk.id} task={tk} index={i} resolveName={resolveName} />
          ))
        )}
      </div>
    </section>
  );
}

function TodoRow({
  task,
  index,
  resolveName,
}: {
  task: HumanTaskCard;
  index: number;
  resolveName: (short: string) => string;
}) {
  const agentMeta = AGENT_MAP.find((a) => a.short === task.agentShort);
  const stage = agentMeta?.stage ?? "system";
  const glyph = stageGlyph(stage);
  const subtitle = `${resolveName(task.agentShort)}${task.assignee ? ` · ${task.assignee}` : ""}`;
  return (
    <Link
      href={`/inbox?task=${encodeURIComponent(task.id)}`}
      className="ao-hover-lift ao-stream-in flex items-start gap-3 rounded-sm cursor-pointer"
      style={
        {
          padding: "8px 6px",
          textDecoration: "none",
          color: "inherit",
          ["--ao-i"]: index,
        } as React.CSSProperties
      }
    >
      <span
        className="flex-none flex items-center justify-center rounded-sm text-[11px] font-medium"
        style={{ width: 28, height: 28, background: glyph.bg, color: glyph.color }}
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
      <span className="text-ink-4 mono text-[10.5px] flex-none" style={{ paddingTop: 2 }}>
        {relativeTime(task.createdAt)}
      </span>
    </Link>
  );
}

// ── Live event stream (SSE-backed) ──────────────────────────────────────

function EventStreamPanel({
  t,
  events,
  connected,
  lastFetchAt,
}: {
  t: (k: string) => string;
  events: InngestEventRow[];
  connected: boolean;
  lastFetchAt: Date | null;
}) {
  return (
    <section
      className="border border-line rounded-md bg-surface flex flex-col"
      style={{ padding: "16px 18px", minHeight: 320 }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div className="flex items-center gap-2">
          <span className="text-ink-1" style={{ fontSize: 14, fontWeight: 500 }}>
            {t("overview_stream_title")}
          </span>
          <SseStatusPill
            connected={connected}
            lastFetchAt={lastFetchAt}
            t={t}
          />
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
        {events.length === 0 ? (
          <div className="text-ink-3 text-[12px]">{t("overview_stream_empty")}</div>
        ) : (
          events.slice(0, 10).map((e, i) => <EventRow key={e.id ?? e.internal_id ?? i} entry={e} index={i} />)
        )}
      </div>
    </section>
  );
}

function SseStatusPill({
  connected,
  lastFetchAt,
  t,
}: {
  connected: boolean;
  lastFetchAt: Date | null;
  t: (k: string) => string;
}) {
  const label = connected
    ? t("overview_sse_connected")
    : lastFetchAt
      ? t("overview_sse_polling")
      : t("overview_sse_offline");
  const color = connected
    ? "var(--c-ok)"
    : lastFetchAt
      ? "oklch(0.6 0.14 75)"
      : "var(--c-ink-4)";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm mono"
      style={{
        fontSize: 10.5,
        padding: "1px 6px",
        color,
        background: `color-mix(in oklab, ${color} 12%, var(--c-bg))`,
        border: `1px solid color-mix(in oklab, ${color} 35%, var(--c-line))`,
      }}
    >
      <span
        className={connected ? "rounded-full anim-pulse" : "rounded-full"}
        style={{ width: 5, height: 5, background: color }}
      />
      {label}
    </span>
  );
}

function EventRow({ entry, index }: { entry: InngestEventRow; index: number }) {
  const tone = eventNameTone(entry.name);
  const ts =
    entry.received_at ??
    (typeof entry.ts === "number" ? new Date(entry.ts).toISOString() : null);
  const description = pickEventDescription(entry);
  return (
    <Link
      href={`/events/${encodeURIComponent(entry.name)}`}
      className="ao-stream-in ao-hover-lift flex items-start gap-3 rounded-sm cursor-pointer"
      style={
        {
          padding: "6px 6px",
          textDecoration: "none",
          color: "inherit",
          ["--ao-i"]: index,
        } as React.CSSProperties
      }
    >
      <span
        className="flex-none rounded-full"
        style={{
          width: 7,
          height: 7,
          background: tone.color,
          marginTop: 7,
          boxShadow:
            tone.kind === "err" || tone.kind === "warn"
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
            {entry.name}
          </span>
        </div>
        {description && (
          <div className="text-ink-2 truncate" style={{ fontSize: 12, marginTop: 2 }}>
            {description}
          </div>
        )}
      </div>
      <span className="text-ink-4 mono text-[10.5px] flex-none" style={{ paddingTop: 4 }}>
        {ts ? relativeTime(ts) : "—"}
      </span>
    </Link>
  );
}

// ── Agent runtime monitor ───────────────────────────────────────────────

function AgentRuntimePanel({
  t,
  entries,
  resolveName,
}: {
  t: (k: string) => string;
  entries: LogEntry[] | null;
  resolveName: (short: string) => string;
}) {
  // Keep only step-level / decision / anomaly / hitl rows — those are the
  // "agent is doing something now" signals. step.completed for already-done
  // work also passes through as the trailing context.
  const filtered = React.useMemo(() => {
    if (!entries) return null;
    const interestingKinds: LogKind[] = [
      "step.started",
      "step.completed",
      "step.failed",
      "step.retrying",
      "anomaly",
      "decision",
      "tool",
      "hitl",
    ];
    return entries.filter((e) => interestingKinds.includes(e.kind)).slice(0, 8);
  }, [entries]);

  return (
    <section
      className="border border-line rounded-md bg-surface"
      style={{ padding: "14px 18px" }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <div className="flex items-center gap-2">
          <span className="text-ink-1" style={{ fontSize: 14, fontWeight: 500 }}>
            {t("overview_runtime_title")}
          </span>
          <span className="text-ink-3 mono text-[10.5px]">
            {t("overview_runtime_sub")}
          </span>
        </div>
        <Link
          href="/monitor"
          className="text-ink-3 text-[11.5px] hover:text-ink-1"
          style={{ textDecoration: "none" }}
        >
          {t("overview_health_link") === "智能体舰队" ? "监控" : "Monitor"} →
        </Link>
      </div>
      {filtered === null ? (
        <div className="text-ink-3 text-[12px]">加载中…</div>
      ) : filtered.length === 0 ? (
        <div className="text-ink-3 text-[12px]" style={{ padding: "12px 0" }}>
          {t("overview_runtime_empty")}
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: 4 }}>
          {filtered.map((e, i) => (
            <RuntimeRow
              key={e.id}
              entry={e}
              index={i}
              t={t}
              resolveName={resolveName}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RuntimeRow({
  entry,
  index,
  t,
  resolveName,
}: {
  entry: LogEntry;
  index: number;
  t: (k: string) => string;
  resolveName: (short: string) => string;
}) {
  const tone = kindTone(entry.kind);
  const verb = kindVerb(entry.kind, t);
  const agentLabel =
    entry.agent === "system" ? t("nav_system") || "系统" : resolveName(entry.agent);
  const runHref = entry.runId ? `/monitor/runs/${encodeURIComponent(entry.runId)}` : null;
  const body = (
    <>
      <span
        className="flex-none rounded-full"
        style={{
          width: 6,
          height: 6,
          background: tone.color,
          marginTop: 7,
        }}
      />
      <span
        className="text-ink-1 flex-none"
        style={{ fontSize: 12.5, fontWeight: 500, minWidth: 92 }}
      >
        {agentLabel}
      </span>
      <span
        className="mono flex-none"
        style={{
          fontSize: 10.5,
          color: tone.color,
          padding: "1px 6px",
          background: `color-mix(in oklab, ${tone.color} 12%, var(--c-bg))`,
          borderRadius: 3,
          minWidth: 44,
          textAlign: "center",
        }}
      >
        {verb}
      </span>
      <span className="text-ink-2 truncate flex-1" style={{ fontSize: 12 }}>
        {entry.message}
      </span>
      <span className="text-ink-4 mono text-[10.5px] flex-none" style={{ paddingTop: 2 }}>
        {relativeTime(entry.ts)}
      </span>
    </>
  );
  if (runHref) {
    return (
      <Link
        href={runHref}
        className="ao-stream-in ao-hover-lift flex items-center gap-3 rounded-sm cursor-pointer"
        style={
          {
            padding: "5px 6px",
            textDecoration: "none",
            color: "inherit",
            ["--ao-i"]: index,
          } as React.CSSProperties
        }
      >
        {body}
      </Link>
    );
  }
  return (
    <div
      className="ao-stream-in flex items-center gap-3 rounded-sm"
      style={{ padding: "5px 6px", ["--ao-i"]: index } as React.CSSProperties}
    >
      {body}
    </div>
  );
}

// ── Agent health grid ───────────────────────────────────────────────────

type AgentCard = {
  agent: (typeof AGENT_MAP)[number];
  kind: "real" | "shell" | "unbuilt";
  paused: boolean;
  health: AgentHealth | null;
};

function statusOrder(c: AgentCard): number {
  if (c.kind === "unbuilt") return 2;
  if (c.paused) return 1;
  return 0;
}

function agentStatus(c: AgentCard): "online" | "offline" | "paused" {
  if (c.kind === "unbuilt") return "offline";
  if (c.paused) return "paused";
  return "online";
}

function AgentHealthGrid({
  t,
  cards,
  resolveName,
}: {
  t: (k: string) => string;
  cards: AgentCard[];
  resolveName: (short: string) => string;
}) {
  const onlineCount = cards.filter((c) => agentStatus(c) === "online").length;
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
            {t("overview_health_running").replace("{n}", String(onlineCount))}
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
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(228px, 1fr))",
            gap: 10,
          }}
        >
          {cards.map((c, i) => (
            <AgentHealthCard
              key={c.agent.short}
              card={c}
              index={i}
              t={t}
              resolveName={resolveName}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AgentHealthCard({
  card,
  index,
  t,
  resolveName,
}: {
  card: AgentCard;
  index: number;
  t: (k: string) => string;
  resolveName: (short: string) => string;
}) {
  const { agent, health } = card;
  const status = agentStatus(card);
  const name = resolveName(agent.short);
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

  const statusMeta = STATUS_META[status];
  const showMetrics = runs > 0 || (health?.counts.completed ?? 0) > 0;

  return (
    <Link
      href={`/fleet/${encodeURIComponent(agent.short)}`}
      className="ao-fade-rise ao-hover-lift flex flex-col gap-2 rounded-md border border-line cursor-pointer"
      style={
        {
          padding: "12px 14px",
          background: "var(--c-bg)",
          textDecoration: "none",
          color: "inherit",
          ["--ao-i"]: Math.min(index, 12),
        } as React.CSSProperties
      }
    >
      <div className="flex items-center gap-2.5">
        <span
          className="flex-none flex items-center justify-center rounded-sm text-[12px] font-medium"
          style={{ width: 30, height: 30, background: glyph.bg, color: glyph.color }}
        >
          {glyph.label}
        </span>
        <div className="flex-1 min-w-0">
          <div
            className="text-ink-1 truncate"
            style={{ fontSize: 13, fontWeight: 500 }}
          >
            {name}
          </div>
          <div
            className="mono text-ink-4 truncate"
            style={{ fontSize: 10, marginTop: 1, letterSpacing: "0.02em" }}
          >
            {agent.short}
          </div>
        </div>
        <span
          className="rounded-sm mono flex-none inline-flex items-center gap-1"
          style={{
            fontSize: 10,
            padding: "2px 7px",
            color: statusMeta.color,
            background: `color-mix(in oklab, ${statusMeta.color} 14%, var(--c-bg))`,
            border: `1px solid color-mix(in oklab, ${statusMeta.color} 35%, var(--c-line))`,
          }}
        >
          <span
            className={status === "online" ? "rounded-full anim-pulse" : "rounded-full"}
            style={{ width: 5, height: 5, background: statusMeta.color }}
          />
          {t(statusMeta.labelKey)}
        </span>
      </div>
      {showMetrics ? (
        <div
          className="mono text-ink-3 tabular-nums"
          style={{ fontSize: 11, paddingLeft: 40 }}
        >
          {runs} 次 ·{" "}
          <span style={{ color: successPctColor(successPct) }}>
            {successPct === null ? "—" : `${successPct}%`}
          </span>
        </div>
      ) : (
        <div className="text-ink-4" style={{ fontSize: 10.5, paddingLeft: 40 }}>
          {t("overview_idle")}
        </div>
      )}
    </Link>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

function greetingForHour(h: number, t: (k: string) => string): string {
  if (h < 5) return t("overview_greeting_dawn");
  if (h < 11) return t("overview_greeting_morning");
  if (h < 13) return t("overview_greeting_noon");
  if (h < 18) return t("overview_greeting_afternoon");
  return t("overview_greeting_evening");
}

function computeTone(failed1h: number, alertsActive: number): OverallTone {
  if (failed1h >= 10 || alertsActive >= 5) return "alarm";
  if (failed1h >= 3 || alertsActive >= 2) return "tense";
  return "calm";
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
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

function kindVerb(kind: LogKind, t: (k: string) => string): string {
  switch (kind) {
    case "step.started":
      return t("overview_runtime_verb_started");
    case "step.completed":
      return t("overview_runtime_verb_completed");
    case "step.failed":
      return t("overview_runtime_verb_failed");
    case "step.retrying":
      return t("overview_runtime_verb_retrying");
    case "anomaly":
      return t("overview_runtime_verb_anomaly");
    case "decision":
      return t("overview_runtime_verb_decision");
    case "tool":
      return t("overview_runtime_verb_tool");
    case "hitl":
      return t("overview_runtime_verb_hitl");
    default:
      return t("overview_runtime_verb_info");
  }
}

/** Event name → tone color. `_FAILED` / `_ERROR` are err; `_SENT` / `_PASSED`
 *  / `_COMPLETED` / `_GENERATED` are ok; the rest default to info. */
function eventNameTone(name: string): { color: string; kind: "ok" | "info" | "warn" | "err" } {
  const upper = name.toUpperCase();
  if (/_FAILED$|_ERROR$|_BLOCKED$/.test(upper)) return { color: "var(--c-err)", kind: "err" };
  if (/_RETRY$|_PENDING$|_WAITING$/.test(upper)) return { color: "oklch(0.6 0.14 75)", kind: "warn" };
  if (/_SENT$|_PASSED$|_COMPLETED$|_GENERATED$|_PROCESSED$|_APPROVED$|_PUBLISHED$|_OPTIMIZED$|_SUBMITTED$|_READY$/.test(upper)) {
    return { color: "var(--c-ok)", kind: "ok" };
  }
  return { color: "var(--c-info)", kind: "info" };
}

/** Best-effort: pull a short, readable description from the event payload.
 *  Tries common payload keys (candidate_id, jr_id, message, reason). */
function pickEventDescription(entry: InngestEventRow): string | null {
  const d = entry.data as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") return null;
  // Prefer human-written reason/message
  if (typeof d.message === "string" && d.message.trim()) return d.message;
  if (typeof d.reason === "string" && d.reason.trim()) return d.reason;
  // Fall back to candidate × jr pair
  const cand = typeof d.candidate_id === "string" ? d.candidate_id.slice(0, 8) : null;
  const jr =
    typeof d.job_requisition_id === "string"
      ? d.job_requisition_id.split("-").pop()
      : null;
  const parts = [cand, jr].filter(Boolean) as string[];
  if (parts.length) return parts.join(" · ");
  return null;
}

function successPctColor(p: number | null): string {
  if (p === null) return "var(--c-ink-3)";
  if (p >= 95) return "var(--c-ok)";
  if (p >= 85) return "oklch(0.6 0.14 75)";
  return "var(--c-err)";
}

const STATUS_META: Record<
  "online" | "paused" | "offline",
  { color: string; labelKey: string }
> = {
  online: { color: "var(--c-ok)", labelKey: "overview_status_online" },
  paused: { color: "oklch(0.6 0.14 75)", labelKey: "overview_status_paused" },
  offline: { color: "var(--c-ink-4)", labelKey: "overview_status_offline" },
};

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
