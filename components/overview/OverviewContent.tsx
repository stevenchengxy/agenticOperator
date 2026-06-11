"use client";
import React from "react";
import Link from "next/link";
import { Ic, type IcName } from "@/components/shared/Ic";
import { fetchJson } from "@/lib/api/client";
import type { RunsResponse } from "@/lib/api/types";
import type { NotificationRow, NotificationsResponse } from "@/lib/api/notification-types";
import { useAgentsHealth } from "@/lib/api/agents-health";
import { useInngestEventsStream } from "@/lib/api/inngest-events-stream";
import type { InngestEventRow } from "@/lib/api/inngest-events";
import { displayName as agentDisplayName } from "@/lib/agent-mapping";
import { useDeploymentMap } from "@/lib/hooks/useDeploymentMap";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";
import { useDisplayNameResolver } from "@/lib/agent-names";
import { runDomainOf, useAgentDomainMap, slugToShort } from "@/lib/monitor/run-domain";
import { statusLabel, statusDotColor, type RunRow } from "@/components/shared/RunTrace";
import {
  buildOverviewAgentCards,
  agentStatus,
  type OverviewAgentCard,
} from "@/lib/overview-agent-cards";

// /overview — operations dashboard, redesigned 2026-06-01.
//
// Sections:
//   A. Hero — overline, time-of-day greeting, refresh.
//   B. 2-column body — left: 待我处理 = needs-human, unread notifications from
//      the 消息通知中心 (/api/notifications); right: live event stream via SSE
//      (实时事件流). Stream falls back to polling.
//   C. Agent runtime monitor (智能体运行) — compact full-width strip of recent
//      runs from the same live Inngest feed /monitor reads
//      (/api/inngest-admin/runs), one row per run, scoped to the active domain.
//   D. Agent health grid — deployed agents in the active domain, one
//      card each. Status badge (上线/下线/暂停) + invocations + success.
//      Hides metrics row when there are no runs.

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

type OverallTone = "calm" | "tense" | "alarm";

export function OverviewContent() {
  const { t } = useApp();
  const { domain } = useDomain();
  const health = useAgentsHealth(4_000);
  const { rows: agentRows } = useDeploymentMap();
  const resolveName = useDisplayNameResolver();
  // Run → domain attribution map (shared with /monitor) for the 智能体运行 panel.
  const slugToDomain = useAgentDomainMap();

  // SSE-backed Inngest event stream (real-time). Falls back to 2s polling.
  const eventStream = useInngestEventsStream();

  // KPI + panels (polled every 8s — these are aggregate snapshots).
  const [failed1hCount, setFailed1hCount] = React.useState<number | null>(null);
  // 待我处理 — needs-human, unread notifications (消息通知中心). Domain scope is
  // applied server-side (system always shows; recruitment absorbs null-domain).
  const [notifications, setNotifications] = React.useState<NotificationRow[] | null>(null);
  const [needsHumanCount, setNeedsHumanCount] = React.useState<number | null>(null);
  // 智能体运行 — recent runs from the live Inngest feed /monitor reads.
  const [runs, setRuns] = React.useState<RunRow[] | null>(null);
  const [alertsActive, setAlertsActive] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const since1h = new Date(Date.now() - 60 * 60_000).toISOString();
    try {
      // Each fetch degrades independently — one slow / failing endpoint (an
      // Inngest 502, a 5s timeout) blanks only its own panel, never the whole
      // page. fetchJson throws on non-2xx, so the per-fetch .catch is required.
      const [failed, notif, runsRes, alerts] = await Promise.all([
        fetchJson<RunsResponse>(
          `/api/runs?status=failed,timed_out,interrupted&since=${encodeURIComponent(since1h)}&limit=20`,
        ).catch(() => ({ runs: [] })),
        fetchJson<NotificationsResponse>(
          `/api/notifications?needsHuman=1&unread=1&limit=20&domain=${encodeURIComponent(domain)}`,
        ).catch(
          (): NotificationsResponse => ({ notifications: [], nextCursor: null, counts: null }),
        ),
        fetchJson<{ runs: RunRow[] }>("/api/inngest-admin/runs?limit=60").catch(
          () => ({ runs: [] as RunRow[] }),
        ),
        fetchJson<{ alerts: Array<{ acked: boolean }> }>("/api/alerts").catch(
          () => ({ alerts: [] as Array<{ acked: boolean }> }),
        ),
      ]);
      setFailed1hCount(failed.runs.length);
      setNotifications(notif.notifications);
      setNeedsHumanCount(notif.counts?.needsHuman ?? notif.notifications.length);
      setRuns(runsRes.runs ?? []);
      setAlertsActive(alerts.alerts.filter((a) => !a.acked).length);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [domain]);

  React.useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 8_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Recent runs scoped to the active business domain — attributed via the run's
  // Inngest function slug, the same way /monitor scopes its run list.
  const runsInDomain = React.useMemo<RunRow[] | null>(
    () =>
      runs
        ? runs.filter((r) => runDomainOf(r, slugToDomain) === domain).slice(0, 8)
        : null,
    [runs, slugToDomain, domain],
  );

  // Deployed agents in domain, sorted by recent activity (most active first).
  // Sourced from the live /api/agents roster so every business domain's agents
  // appear — including energy / 费控, registered as their own Inngest apps.
  const agentCards = React.useMemo<OverviewAgentCard[]>(
    () => buildOverviewAgentCards(agentRows, domain, health.byShort, resolveName),
    [agentRows, domain, health.byShort, resolveName],
  );

  const tone: OverallTone = computeTone(
    failed1hCount ?? 0,
    alertsActive ?? 0,
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto">
      <HeroHeader
        t={t}
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
          <div
            className="grid"
            style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}
          >
            <TodoPanel t={t} notifications={notifications} count={needsHumanCount} />
            <EventStreamPanel
              t={t}
              events={eventStream.events}
              connected={eventStream.connected}
              lastFetchAt={eventStream.lastFetchAt}
            />
          </div>
          <div className="mt-6">
            <AgentRuntimePanel t={t} runs={runsInDomain} />
          </div>
          <div className="mt-6">
            <AgentHealthGrid t={t} cards={agentCards} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Hero ────────────────────────────────────────────────────────────────

function HeroHeader({
  t,
  alertsActive,
  tone,
  fetchedAt,
  onRefresh,
}: {
  t: (k: string) => string;
  alertsActive: number | null;
  tone: OverallTone;
  fetchedAt: Date | null;
  onRefresh: () => void;
}) {
  const greeting = greetingForHour(new Date().getHours(), t);
  const toneAccent =
    tone === "calm"
      ? "var(--c-ok)"
      : tone === "tense"
        ? "oklch(0.6 0.14 75)"
        : "var(--c-err)";
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

// ── 待我处理 (needs-human, unread notifications) ─────────────────────────

// Category → icon + severity → ink, mirroring the 消息通知中心
// (components/notifications/NotificationsContent.tsx) so the overview row reads
// the same as the full center.
const NOTIF_CAT_ICON: Record<NotificationRow["category"], IcName> = {
  system: "shield",
  agent: "cpu",
  event: "bolt",
  candidate: "user",
  job: "branch",
};
const NOTIF_SEV_INK: Record<NotificationRow["severity"], string> = {
  critical: "var(--c-err)",
  warning: "oklch(0.62 0.15 70)",
  info: "var(--c-accent)",
};

function TodoPanel({
  t,
  notifications,
  count,
}: {
  t: (k: string) => string;
  notifications: NotificationRow[] | null;
  count: number | null;
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
          {count != null && count > 0 && (
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
              {count}
            </span>
          )}
        </div>
        <Link
          href="/notifications"
          className="text-ink-3 text-[11.5px] hover:text-ink-1"
          style={{ textDecoration: "none" }}
        >
          {t("overview_todo_inbox")} →
        </Link>
      </div>
      <div className="flex-1 flex flex-col" style={{ gap: 8 }}>
        {notifications === null ? (
          <div className="text-ink-3 text-[12px]">{t("common_loading")}</div>
        ) : notifications.length === 0 ? (
          <div className="text-ink-3 text-[12px]">{t("overview_todo_empty")}</div>
        ) : (
          notifications.slice(0, 6).map((n, i) => (
            <TodoRow key={n.id} n={n} index={i} t={t} />
          ))
        )}
      </div>
    </section>
  );
}

function TodoRow({
  n,
  index,
  t,
}: {
  n: NotificationRow;
  index: number;
  t: (k: string) => string;
}) {
  const ink = NOTIF_SEV_INK[n.severity] ?? "var(--c-accent)";
  const Glyph = Ic[NOTIF_CAT_ICON[n.category] ?? "bolt"];
  // Deep-link to the notification's single process (run / audit / event) when it
  // has one; otherwise fall back to the 消息通知中心.
  const href = n.href ?? "/notifications";
  return (
    <Link
      href={href}
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
        className="flex-none flex items-center justify-center rounded-sm"
        style={{
          width: 28,
          height: 28,
          background: `color-mix(in oklab, ${ink} 14%, var(--c-bg))`,
          color: ink,
        }}
      >
        <Glyph style={{ width: 14, height: 14 }} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-ink-1 truncate" style={{ fontSize: 12.5 }}>
          {n.title}
        </div>
        <div className="text-ink-3 mono text-[10.5px] truncate" style={{ marginTop: 2 }}>
          {n.source}
        </div>
      </div>
      <span className="text-ink-4 mono text-[10.5px] flex-none" style={{ paddingTop: 2 }}>
        {relativeTime(n.ts, t)}
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
          events.slice(0, 10).map((e, i) => <EventRow key={e.id ?? e.internal_id ?? i} entry={e} index={i} t={t} />)
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

function EventRow({ entry, index, t }: { entry: InngestEventRow; index: number; t: (k: string) => string }) {
  const tone = eventNameTone(entry.name);
  const ts =
    entry.received_at ??
    (typeof entry.ts === "number" ? new Date(entry.ts).toISOString() : null);
  const description = pickEventDescription(entry);
  return (
    <Link
      href={`/events?name=${encodeURIComponent(entry.name)}`}
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
        {ts ? relativeTime(ts, t) : "—"}
      </span>
    </Link>
  );
}

// ── 智能体运行 (recent runs — same live Inngest feed as /monitor) ─────────

function AgentRuntimePanel({
  t,
  runs,
}: {
  t: (k: string) => string;
  runs: RunRow[] | null;
}) {
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
          {t("nav_monitor")} →
        </Link>
      </div>
      {runs === null ? (
        <div className="text-ink-3 text-[12px]">{t("common_loading")}</div>
      ) : runs.length === 0 ? (
        <div className="text-ink-3 text-[12px]" style={{ padding: "12px 0" }}>
          {t("overview_runtime_empty")}
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: 4 }}>
          {runs.map((r, i) => (
            <RuntimeRow key={r.id} run={r} index={i} t={t} />
          ))}
        </div>
      )}
    </section>
  );
}

function RuntimeRow({
  run,
  index,
  t,
}: {
  run: RunRow;
  index: number;
  t: (k: string) => string;
}) {
  // Resolve the agent the run belongs to from its Inngest function slug, the
  // same way /monitor labels its run rows.
  const short = slugToShort(run.function?.slug);
  // Visible label stays jargon-free — fall back to the run's human function
  // name, never the raw Inngest slug (that's kept on the title tooltip below).
  const agentLabel = short ? agentDisplayName(short) : run.function?.name ?? "—";
  const dot = statusDotColor(run.status);
  const statusInk = run.status === "Failed" ? "var(--c-err)" : "var(--c-ink-2)";
  return (
    <Link
      href={`/monitor/runs/${encodeURIComponent(run.id)}`}
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
      <span
        className="flex-none rounded-full"
        style={{ width: 6, height: 6, background: dot }}
      />
      <span
        className="text-ink-1 flex-none truncate"
        style={{ fontSize: 12.5, fontWeight: 500, minWidth: 92, maxWidth: 148 }}
        title={short ?? run.function?.slug ?? undefined}
      >
        {agentLabel}
      </span>
      <span
        className="mono flex-none"
        style={{
          fontSize: 10.5,
          color: statusInk,
          padding: "1px 6px",
          background: `color-mix(in oklab, ${dot} 12%, var(--c-bg))`,
          borderRadius: 3,
          minWidth: 44,
          textAlign: "center",
        }}
      >
        {statusLabel(run.status, t)}
      </span>
      <span className="text-ink-2 truncate flex-1" style={{ fontSize: 12 }}>
        {run.eventName ?? "—"}
      </span>
      <span
        className="text-ink-4 mono text-[10.5px] flex-none tabular-nums"
        style={{ minWidth: 34, textAlign: "right" }}
      >
        {run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : ""}
      </span>
      <span className="text-ink-4 mono text-[10.5px] flex-none" style={{ paddingLeft: 2 }}>
        {run.startedAt ? relativeTime(run.startedAt, t) : "—"}
      </span>
    </Link>
  );
}

// ── Agent health grid ───────────────────────────────────────────────────
// Card shape + status/sort helpers live in lib/overview-agent-cards.ts
// (pure + unit-tested); the grid below is presentation only.

function AgentHealthGrid({
  t,
  cards,
}: {
  t: (k: string) => string;
  cards: OverviewAgentCard[];
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
            <AgentHealthCard key={c.short} card={c} index={i} t={t} />
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
}: {
  card: OverviewAgentCard;
  index: number;
  t: (k: string) => string;
}) {
  const { name, health } = card;
  const status = agentStatus(card);
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
  const glyph = stageGlyph(card.stage);

  const statusMeta = STATUS_META[status];
  const showMetrics = runs > 0 || (health?.counts.completed ?? 0) > 0;

  return (
    <Link
      href={`/fleet/${encodeURIComponent(card.short)}`}
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
            {card.short}
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

function relativeTime(iso: string, t: (k: string) => string): string {
  const ts = new Date(iso).getTime();
  const diff = Date.now() - ts;
  if (diff < 60_000) return t("common_just_now");
  if (diff < 60 * 60_000) return t("common_minutes_ago").replace("{n}", String(Math.floor(diff / 60_000)));
  if (diff < 24 * 60 * 60_000) return t("common_hours_ago").replace("{n}", String(Math.floor(diff / (60 * 60_000))));
  return t("common_days_ago").replace("{n}", String(Math.floor(diff / (24 * 60 * 60_000))));
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
