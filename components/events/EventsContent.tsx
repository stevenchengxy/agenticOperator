"use client";
import React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AGENT_MAP, displayName as agentDisplayName, type DeploymentKind } from "@/lib/agent-mapping";
import { useDeploymentMap } from "@/lib/hooks/useDeploymentMap";
import type { InngestEventRow, InngestEventsResponse } from "@/lib/api/inngest-events";
import { useEmHealth } from "@/lib/api/em-health";
import { fetchJson } from "@/lib/api/client";
import type { EventsResponse, EventContract } from "@/lib/api/types";
import { paginationFrom, readPage, readPageSize, setPaginationParams } from "@/lib/api/pagination";
import { AllmetaSyncStrip } from "./AllmetaSyncStrip";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";
import { eventLeafName, eventMatchesDomain } from "@/lib/events/domain-scope";
import { classifyByPublishers, DIRECTION_META } from "@/lib/events/event-direction";
import { HelpTip } from "@/components/shared/HelpTip";
import { Pagination } from "@/components/shared/Pagination";
import { OutcomeBadges } from "@/components/monitor/OutcomeBadges";
import { useDeepLinkFocus } from "@/lib/hooks/useDeepLinkFocus";

// /events — 事件
//
// Job: "What events have flowed through the bus? What payload? What did each trigger?"
// Inspired by the Inngest dev server's Events view (received_at · name · functions
// triggered) — left list + right payload viewer.
//
// Per IA spec (2026-05-19):
//   - Pure event-bus log (no agent identity, no run trace — those live elsewhere)
//   - Functions-triggered pills are clickable → /monitor?event=<name>&agent=<short>
//   - Click event row → right panel shows payload + functions triggered

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

// Build reverse map: event_name → list of agent shorts that subscribe.
const EVENT_TO_SUBSCRIBERS: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const a of AGENT_MAP) {
    for (const ev of a.triggersEvents ?? []) {
      if (!map[ev]) map[ev] = [];
      map[ev].push(a.short);
    }
  }
  return map;
})();

function subscribersOf(
  eventName: string,
  realnessMap: Map<string, DeploymentKind>,
): { short: string; isReal: boolean; kind: DeploymentKind }[] {
  const list = EVENT_TO_SUBSCRIBERS[eventName] ?? EVENT_TO_SUBSCRIBERS[eventLeafName(eventName)] ?? [];
  return list.map((short) => {
    const kind = realnessMap.get(short) ?? "unbuilt";
    return { short, isReal: kind === "real", kind };
  });
}

type EventPageResponse = InngestEventsResponse & {
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  pagination?: { page?: number; pageSize?: number; total?: number; totalPages?: number };
};

function useEventPage({
  active,
  domain,
  name,
  windowId,
  page,
  pageSize,
}: {
  active: boolean;
  domain: string;
  name: string | null;
  windowId: "1h" | "24h" | "7d" | "all";
  page: number;
  pageSize: number;
}) {
  const [events, setEvents] = React.useState<InngestEventRow[] | null>(null);
  const [total, setTotal] = React.useState<number | null>(null);
  const [totalPages, setTotalPages] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = React.useState<Date | null>(null);

  const refresh = React.useCallback(async () => {
    if (!active) return;
    const params = new URLSearchParams({ domain });
    setPaginationParams(params, page, pageSize);
    if (name) params.set("name", name);
    if (windowId !== "all") {
      const windowMs = windowId === "1h" ? 3600_000 : windowId === "24h" ? 86400_000 : 7 * 86400_000;
      params.set("since", new Date(Date.now() - windowMs).toISOString());
    }
    setLoading(true);
    try {
      const body = await fetchJson<EventPageResponse>(`/api/inngest-events?${params.toString()}`, {
        cache: "no-store",
        // The first read after upgrading an existing installation may perform
        // a one-time domain/occurredAt backfill over the durable archive.
        timeoutMs: 30_000,
      });
      const rows = Array.isArray(body.events) ? body.events : [];
      const pagination = paginationFrom(body, { page, pageSize, rowCount: rows.length });
      setEvents(rows);
      setTotal(pagination.total);
      setTotalPages(pagination.totalPages);
      setLastFetchAt(new Date(body.fetchedAt || Date.now()));
      setError(body.errors?.length
        ? body.errors.map((item) => `${item.source}: ${item.message}`).join("; ")
        : null);
    } catch (cause) {
      const message = cause && typeof cause === "object" && "message" in cause
        ? String((cause as { message: unknown }).message)
        : String(cause);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [active, domain, name, windowId, page, pageSize]);

  React.useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(refresh, page === 1 ? 5_000 : 15_000);
    return () => clearInterval(timer);
  }, [active, page, refresh]);

  return {
    events,
    total,
    totalPages,
    loading,
    error,
    lastFetchAt,
    connected: events != null && error == null,
    refresh,
  };
}

export function EventsContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const { t, lang } = useApp();
  const { domain } = useDomain();
  const { realness: realnessMap } = useDeploymentMap();

  const filterName = sp.get("name");
  const windowId = (sp.get("window") ?? "1h") as "1h" | "24h" | "7d" | "all";
  const selectedId = sp.get("id");
  const focusParam = sp.get("focus");
  const view = (sp.get("view") ?? "stream") as "stream" | "dlq";
  // registration filter — disabled in UI for now (development), but the
  // URL state and filtering logic are wired so we can flip the disable bit
  // when the team's ready to QA it.
  const regFilter = (sp.get("reg") ?? "all") as "all" | "registered" | "unregistered";
  const dirFilter = (sp.get("dir") ?? "all") as "all" | "in" | "out";
  const page = readPage(sp.get("page"));
  const pageSize = readPageSize(sp.get("pageSize"), [20, 50, 100], 50);

  const setUrl = React.useCallback((mut: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(sp.toString());
    mut(next);
    router.replace(`/events${next.toString() ? `?${next.toString()}` : ""}`);
  }, [router, sp]);

  const setDirFilter = React.useCallback((next: "all" | "in" | "out") => {
    setUrl((p) => {
      if (next === "all") p.delete("dir");
      else p.set("dir", next);
      p.delete("page");
      p.delete("id");
    });
  }, [setUrl]);

  const eventPage = useEventPage({
    active: view === "stream",
    domain,
    name: filterName,
    windowId,
    page,
    pageSize,
  });
  const events = eventPage.events ?? [];
  const { error, lastFetchAt, connected } = eventPage;
  const emHealth = useEmHealth();
  const { registry, syncing, refreshRegistry, syncNow } = useEventRegistry();
  const dlq = useDlq(view === "dlq", domain, page, pageSize);

  const filtered = React.useMemo(() => {
    const cutoff = windowId === "all"
      ? null
      : Date.now() - (windowId === "1h" ? 3600_000 : windowId === "24h" ? 86400_000 : 7 * 86400_000);
    return events.filter((e) => {
      if (!eventMatchesDomain(e, domain)) return false;
      if (!e.received_at) return true;
      if (cutoff !== null && new Date(e.received_at).getTime() < cutoff) return false;
      // Registration filter (logic wired but UI disabled for now)
      if (regFilter !== "all") {
        const isReg = registry.has(e.name);
        if (regFilter === "registered" && !isReg) return false;
        if (regFilter === "unregistered" && isReg) return false;
      }
      // Direction filter — stream view only. Type-level: derive from the
      // event's catalog publishers (see classifyByPublishers), not the
      // per-instance source (which the firehose can't reliably join to).
      if (dirFilter !== "all") {
        if (classifyByPublishers(registry.get(e.name)?.publishers) !== dirFilter) return false;
      }
      return true;
    });
  }, [events, windowId, regFilter, registry, dirFilter, domain]);

  const selected = React.useMemo(() => {
    if (!selectedId) return filtered[0] ?? null;
    return filtered.find((e) => (e.internal_id ?? e.id) === selectedId) ?? filtered[0] ?? null;
  }, [filtered, selectedId]);
  useDeepLinkFocus(focusParam, focusParam ? filtered.some((event) => `event-stream:${event.internal_id ?? event.id}` === focusParam) : true);

  React.useEffect(() => {
    const pages = view === "dlq" ? dlq.totalPages : eventPage.totalPages;
    if (pages != null && page > pages) {
      setUrl((params) => {
        if (pages <= 1) params.delete("page");
        else params.set("page", String(pages));
        params.delete("id");
      });
    }
  }, [dlq.totalPages, eventPage.totalPages, page, setUrl, view]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-auto bg-bg">
      {/* Allmeta sync state strip */}
      <AllmetaSyncStrip />
      {/* header */}
      <div className="border-b border-line" style={{ padding: "28px 32px 18px" }}>
        <div className="flex items-start gap-6">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontWeight: 500, fontSize: 26, letterSpacing: "-0.015em", lineHeight: 1.15 }}>
                {t("evx_page_title")}
              </h1>
              <HelpTip tip={t("evx_page_sub")} />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <LiveDot connected={connected} lastFetchAt={lastFetchAt} t={t} />
          </div>
        </div>

        {/* view toggle: stream vs DLQ */}
        <div className="flex items-center gap-1 mt-4">
          <ViewToggle
            value={view}
            dlqCount={dlq.total}
            onChange={(v) => setUrl((p) => {
              if (v === "stream") p.delete("view");
              else p.set("view", v);
              p.delete("page");
              p.delete("id");
            })}
            t={t}
          />
        </div>

        {/* Event Manager status bar */}
        <EmStatusBar
          emHealth={emHealth.data}
          registryCount={registry.size}
          onSync={async () => { await syncNow(); await refreshRegistry(); }}
          syncing={syncing}
          t={t}
        />

        <div className="flex items-center gap-x-7 gap-y-1.5 mt-4 flex-wrap">
          <CountChip
            label={t("evx_count_events")}
            value={eventPage.total == null ? String(filtered.length) : `${filtered.length} / ${eventPage.total}`}
          />
          {filterName && (
            <span
              className="inline-flex items-center gap-1.5 rounded border border-line bg-surface text-ink-2"
              style={{ padding: "3px 9px", fontSize: 12 }}
            >
              <span className="text-ink-3">{t("evx_name")}</span> {filterName}
              <button onClick={() => setUrl((p) => { p.delete("name"); p.delete("page"); p.delete("id"); })} className="text-ink-3 hover:text-ink-1 ml-1">×</button>
            </span>
          )}
          {error && (
            <span style={{ fontSize: 12, color: "var(--c-err)" }}>
              {error}
            </span>
          )}
          <div className="flex-1" />
          {view === "stream" && (
            <div className="flex items-center gap-1">
              {(["all", "in", "out"] as const).map((d) => {
                const active = dirFilter === d;
                const label = d === "all"
                  ? t("em_dir_all")
                  : lang === "zh" ? DIRECTION_META[d].zh : DIRECTION_META[d].en;
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirFilter(d)}
                    className="cursor-pointer rounded-full transition-colors"
                    style={{
                      padding: "2px 9px",
                      fontSize: 10.5,
                      border: "1px solid",
                      borderColor: active ? "var(--c-accent)" : "var(--c-line)",
                      background: active ? "var(--c-accent-bg)" : "transparent",
                      color: active ? "var(--c-accent)" : "var(--c-ink-3)",
                    }}
                    title={d !== "all" ? t(`em_dir_tip_${d}`) : undefined}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          <RegistrationFilter value={regFilter} disabled t={t} />
          <div className="w-px h-5 bg-line" />
          <WindowSelector value={windowId} onChange={(v) => setUrl((p) => {
            if (v === "1h") p.delete("window");
            else p.set("window", v);
            p.delete("page");
            p.delete("id");
          })} t={t} />
        </div>
      </div>

      {view === "dlq" ? (
        <DlqView
          dlq={dlq}
          page={page}
          pageSize={pageSize}
          onPageChange={(nextPage) => setUrl((params) => {
            if (nextPage <= 1) params.delete("page");
            else params.set("page", String(nextPage));
            params.delete("id");
          })}
          t={t}
        />
      ) : (
      /* main split: list left, payload right */
      <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(380px, 520px)" }}>
        <div className="border-r border-line flex flex-col min-h-0">
          <div className="flex-1 overflow-auto min-h-0">
            <div
              className="grid gap-4 text-ink-4 uppercase tracking-[0.1em] font-medium border-b border-line sticky top-0 bg-bg z-10"
              style={{ gridTemplateColumns: "112px 70px minmax(0, 1.2fr) 80px minmax(140px, .8fr) minmax(190px, 1fr)", padding: "10px 24px", fontSize: 10.5 }}
            >
              <span>{t("evx_col_received_at")}</span>
              <span>{t("evx_col_direction")}</span>
              <span>{t("evx_col_event_name")}</span>
              <span>{t("evx_col_registration")}</span>
              <span>{t("evx_col_triggered_agents")}</span>
              <span>{lang === "zh" ? "处理 / 业务结果" : "Processing / business"}</span>
            </div>
            {eventPage.loading && eventPage.events == null && (
              <div className="text-ink-3 text-center py-16" style={{ fontSize: 13 }}>{t("evx_loading")}</div>
            )}
            {!eventPage.loading && filtered.length === 0 && (
              <div className="text-ink-3 text-center py-16" style={{ fontSize: 13 }}>
                {eventPage.error ? `${t("evx_load_failed")}: ${eventPage.error}` : t("evx_no_recent_events")}
                {eventPage.error && (
                  <div className="mt-3">
                    <button className="text-accent hover:underline" onClick={() => void eventPage.refresh()}>{t("evx_retry")}</button>
                  </div>
                )}
              </div>
            )}
            {filtered.map((e) => {
            const id = e.internal_id ?? e.id;
            const isSelected = selected && (selected.internal_id ?? selected.id) === id;
            const subs = subscribersOf(e.name, realnessMap);
            const contract = registry.get(e.name) ?? null;
            return (
              <button
                key={id}
                data-focus-key={`event-stream:${id}`}
                onClick={() => setUrl((p) => p.set("id", id))}
                className="w-full grid items-center gap-4 border-b border-line transition-colors text-left"
                style={{
                  padding: "11px 24px",
                  gridTemplateColumns: "112px 70px minmax(0, 1.2fr) 80px minmax(140px, .8fr) minmax(190px, 1fr)",
                  background: isSelected ? "var(--c-panel)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <span className="text-ink-3 tabular-nums" style={{ fontSize: 11.5 }}>
                  {fmtTime(e.received_at)}
                </span>
                <DirectionIndicator publishers={contract?.publishers} source={e.source} t={t} lang={lang} />
                <span className="text-ink-1 truncate" style={{ fontSize: 13, fontWeight: 500 }}>
                  {e.name}
                </span>
                <RegistrationBadge contract={contract} t={t} />
                <span className="flex items-center gap-1.5 flex-wrap min-w-0">
                  {subs.length === 0 && (
                    <span className="text-ink-4" style={{ fontSize: 11.5 }}>{t("evx_no_subscribers")}</span>
                  )}
                  {subs.map((s) => (
                    <Link
                      key={s.short}
                      href={`/monitor?agent=${encodeURIComponent(s.short)}&event=${encodeURIComponent(e.name)}`}
                      onClick={(ev) => ev.stopPropagation()}
                      className="inline-flex items-center gap-1 rounded border border-line bg-surface hover:bg-panel transition-colors"
                      style={{
                        padding: "2px 7px", fontSize: 11,
                        color: s.kind === "unbuilt" ? "var(--c-ink-3)" : "var(--c-ink-1)",
                        textDecoration: "none",
                      }}
                      title={s.kind === "unbuilt" ? `${s.short} — ${t("evx_pill_unbuilt_tip")}` : `${s.short} — ${t("evx_pill_real_tip")}`}
                    >
                      {s.kind !== "unbuilt" && (
                        <span className="rounded-full" style={{ width: 5, height: 5, background: "var(--c-ok)" }} />
                      )}
                      {agentDisplayName(s.short)}
                    </Link>
                  ))}
                </span>
                <EventOutcomeCell event={e} lang={lang} />
              </button>
            );
            })}
          </div>
          <Pagination
            page={page}
            pageSize={pageSize}
            rowCount={events.length}
            total={eventPage.total}
            totalPages={eventPage.totalPages}
            loading={eventPage.loading}
            onPageChange={(nextPage) => setUrl((params) => {
              if (nextPage <= 1) params.delete("page");
              else params.set("page", String(nextPage));
              params.delete("id");
            })}
            onPageSizeChange={(nextSize) => setUrl((params) => {
              if (nextSize === 50) params.delete("pageSize");
              else params.set("pageSize", String(nextSize));
              params.delete("page");
              params.delete("id");
            })}
          />
        </div>

        <div className="overflow-auto">
          {selected ? (
            <PayloadViewer event={selected} contract={registry.get(selected.name) ?? null} setUrl={setUrl} t={t} />
          ) : (
            <div className="text-ink-3 text-center py-16" style={{ fontSize: 13 }}>
              {t("evx_pick_event_for_payload")}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function PayloadViewer({ event, contract, setUrl, t }: { event: InngestEventRow; contract: EventContract | null; setUrl: (mut: (p: URLSearchParams) => void) => void; t: (k: string) => string }) {
  const { realness: realnessMap } = useDeploymentMap();
  const subs = subscribersOf(event.name, realnessMap);
  const [showSchema, setShowSchema] = React.useState(false);
  const [replayBusy, setReplayBusy] = React.useState(false);
  const [replayMsg, setReplayMsg] = React.useState<string | null>(null);

  async function handleReplay() {
    const evId = event.internal_id ?? event.id;
    if (!evId) {
      setReplayMsg(t('evx_no_event_id'));
      setTimeout(() => setReplayMsg(null), 2000);
      return;
    }
    setReplayBusy(true);
    setReplayMsg(null);
    try {
      const r = await fetch('/api/inngest-admin/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: evId }),
      });
      const b = await r.json();
      setReplayMsg(b.ok ? `✓ ${t('evx_resent')} · ${t('evx_new_event')} ${b.new_event_id?.slice(0, 12)}…` : `✗ ${b.message ?? b.error ?? 'failed'}`);
    } catch (err) {
      setReplayMsg(`✗ ${(err as Error).message}`);
    } finally {
      setReplayBusy(false);
      setTimeout(() => setReplayMsg(null), 4000);
    }
  }

  return (
    <div style={{ padding: "20px 24px" }}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap min-w-0">
          <h2 className="m-0 text-ink-1 break-all" style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 500, letterSpacing: "-0.01em" }}>
            {event.name}
          </h2>
          <RegistrationBadge contract={contract} large t={t} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReplay}
            disabled={replayBusy}
            title={t("evx_resend_tip")}
            className="text-[12px] px-2.5 py-1 rounded border border-accent text-accent hover:bg-accent-bg disabled:opacity-40 disabled:cursor-not-allowed font-medium"
          >
            {replayBusy ? t("evx_sending") : `↺ ${t("evx_resend")}`}
          </button>
          <button onClick={() => setUrl((p) => p.delete("id"))} className="text-ink-3 hover:text-ink-1" style={{ fontSize: 13 }}>×</button>
        </div>
      </div>
      {replayMsg && (
        <div className="mt-2 text-[11px]" style={{ color: replayMsg.startsWith('✓') ? 'var(--c-ok)' : 'var(--c-err)' }}>
          {replayMsg}
        </div>
      )}

      <div className="mt-3 grid gap-y-1.5" style={{ gridTemplateColumns: "auto 1fr", columnGap: 16, fontSize: 12 }}>
        {event.outcome && (
          <>
            <span className="text-ink-3">技术 / 业务</span>
            <span className="flex items-center gap-2 flex-wrap">
              <OutcomeBadges outcome={event.outcome} />
              {event.processingRuns?.[0] && (
                <Link
                  href={`/monitor?run=${encodeURIComponent(event.processingRuns[0].runId)}&focus=${encodeURIComponent(`run:${event.processingRuns[0].runId}`)}`}
                  className="text-accent hover:underline text-[11px]"
                >
                  查看处理 Run →
                </Link>
              )}
            </span>
          </>
        )}
        <span className="text-ink-3">{t("evx_event_id")}</span>
        <code className="text-ink-2 tabular-nums break-all" style={{ fontFamily: "var(--f-mono)", fontSize: 11.5 }}>
          {event.internal_id ?? event.id}
        </code>
        <span className="text-ink-3">{t("evx_received_at")}</span>
        <span className="text-ink-2 tabular-nums" style={{ fontSize: 12 }}>
          {fmtTimeFull(event.received_at)}
        </span>
        {contract && (
          <>
            <span className="text-ink-3">Stage / Kind</span>
            <span className="text-ink-2" style={{ fontSize: 12 }}>
              {contract.stage} · {contract.kind}
            </span>
            {contract.retiredAt && (
              <>
                <span className="text-ink-3">{t("evx_lifecycle")}</span>
                <span style={{ fontSize: 12, color: "var(--c-warn)" }}>{t("evx_retired_full")}</span>
              </>
            )}
            {contract.isBreakingChange && (
              <>
                <span className="text-ink-3">{t("evx_change")}</span>
                <span style={{ fontSize: 12, color: "var(--c-err)" }}>Breaking change ⚠</span>
              </>
            )}
          </>
        )}
        <span className="text-ink-3">{t("evx_filter")}</span>
        <button
          onClick={() => setUrl((p) => {
            p.set("name", event.name);
            p.delete("page");
            p.delete("id");
          })}
          className="text-left text-ink-2 hover:text-ink-1"
          style={{ fontSize: 12 }}
        >
          {t("evx_only_show_pre")}{event.name}{t("evx_only_show_post")}
        </button>
      </div>

      {contract?.desc && <div className="mt-3"><HelpTip tip={contract.desc} /></div>}

      <div className="mt-5">
        <div className="text-ink-3 mb-2" style={{ fontSize: 12 }}>{t("evx_triggered_agents")}</div>
        {subs.length === 0 ? (
          <div className="text-ink-4" style={{ fontSize: 12 }}>{t("evx_no_agent_subscribes")}</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {subs.map((s) => (
              <Link
                key={s.short}
                href={`/monitor?agent=${encodeURIComponent(s.short)}&event=${encodeURIComponent(event.name)}`}
                className="inline-flex items-center gap-1.5 rounded border border-line bg-surface hover:bg-panel transition-colors"
                style={{ padding: "4px 10px", fontSize: 12, textDecoration: "none", color: s.kind === "unbuilt" ? "var(--c-ink-3)" : "var(--c-ink-1)" }}
                title={s.short}
              >
                {s.kind !== "unbuilt" && <span className="rounded-full" style={{ width: 6, height: 6, background: "var(--c-ok)" }} />}
                {agentDisplayName(s.short)}
                {s.kind === "unbuilt" && <span className="text-ink-4" style={{ fontSize: 11 }}>{t("evx_blueprint")}</span>}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6">
        <div className="text-ink-3 mb-2" style={{ fontSize: 12 }}>Payload</div>
        <pre
          className="text-ink-1 whitespace-pre-wrap break-words"
          style={{
            fontFamily: "var(--f-mono)", fontSize: 11.5,
            margin: 0, padding: "12px 14px",
            background: "var(--c-surface)",
            border: "1px solid var(--c-line)",
            borderRadius: 6,
            maxHeight: 460,
            overflow: "auto",
            lineHeight: 1.55,
          }}
        >
          {safeJsonStringify(event.data)}
        </pre>
      </div>

      {contract?.schema && (
        <div className="mt-5">
          <button
            onClick={() => setShowSchema((s) => !s)}
            className="flex items-center gap-1.5 text-ink-3 hover:text-ink-1"
            style={{ fontSize: 12 }}
          >
            <span style={{ display: "inline-block", transition: "transform 0.15s", transform: showSchema ? "rotate(90deg)" : "rotate(0deg)" }}>›</span>
            {t("evx_registered_schema")}
          </button>
          {showSchema && (
            <pre
              className="text-ink-1 whitespace-pre-wrap break-words mt-2"
              style={{
                fontFamily: "var(--f-mono)", fontSize: 11,
                margin: 0, padding: "10px 12px",
                background: "var(--c-surface)",
                border: "1px solid color-mix(in oklab, var(--c-ok) 18%, var(--c-line))",
                borderRadius: 6, maxHeight: 320, overflow: "auto", lineHeight: 1.55,
              }}
            >
              {safeJsonStringify(contract.schema)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function EventOutcomeCell({ event, lang }: { event: InngestEventRow; lang: "zh" | "en" }) {
  const runs = event.processingRuns ?? [];
  const primary = runs.find((run) => run.outcome.technical === "failed") ?? runs[0];
  const meaningful = event.outcome && event.outcome.business !== "not_applicable";
  return (
    <span className="min-w-0 flex items-center gap-1.5 flex-wrap" onClick={(e) => e.stopPropagation()}>
      {event.outcome && (runs.length > 0 || meaningful) ? (
        <OutcomeBadges outcome={event.outcome} compact />
      ) : (
        <span className="text-[10.5px] text-ink-4">{lang === "zh" ? "事件已记录" : "Recorded"}</span>
      )}
      {primary && (
        <Link
          href={`/monitor?run=${encodeURIComponent(primary.runId)}&focus=${encodeURIComponent(`run:${primary.runId}`)}`}
          className="text-[10.5px] text-accent hover:underline whitespace-nowrap"
        >
          Run →
        </Link>
      )}
    </span>
  );
}

// ── Direction indicator ───────────────────────────────────────────

function DirectionIndicator({ publishers, source, t, lang }: { publishers: string[] | null | undefined; source?: string | null; t: (k: string) => string; lang: "zh" | "en" }) {
  const dir = classifyByPublishers(publishers);
  const meta = DIRECTION_META[dir];
  const label = lang === "zh" ? meta.zh : meta.en;
  const arrow = meta.arrow === "in" ? "↓" : meta.arrow === "out" ? "↑" : "·";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full"
      style={{
        padding: "1px 7px 1px 5px",
        fontSize: 10,
        color: meta.color,
        background: "color-mix(in oklab, " + meta.color + " 12%, transparent)",
        border: "1px solid color-mix(in oklab, " + meta.color + " 25%, transparent)",
        fontWeight: 500,
        flexShrink: 0,
      }}
      title={`${label} · publishers=${publishers?.length ? publishers.join(", ") : "—"}${source ? ` · source=${source}` : ""}`}
    >
      <span style={{ fontFamily: "var(--f-mono)", lineHeight: 1 }}>{arrow}</span>
      <span>{label}</span>
    </span>
  );
}

// ── helpers ──────────────────────────────────────────────────────

function fmtTime(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  } catch { return "—"; }
}

function fmtTimeFull(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", { hour12: false });
  } catch { return "—"; }
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ── controls ─────────────────────────────────────────────────────

function CountChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-ink-4 uppercase tracking-[0.12em] font-medium" style={{ fontSize: 10.5 }}>{label}</span>
      <span className="font-semibold tabular-nums text-ink-1" style={{ fontSize: 18, letterSpacing: "-0.015em" }}>
        {value}
      </span>
    </div>
  );
}

function WindowSelector({ value, onChange, t }: { value: "1h" | "24h" | "7d" | "all"; onChange: (v: "1h" | "24h" | "7d" | "all") => void; t: (k: string) => string }) {
  const opts = [
    { id: "1h" as const, label: t("evx_window_1h") },
    { id: "24h" as const, label: t("evx_window_24h") },
    { id: "7d" as const, label: t("evx_window_7d") },
    { id: "all" as const, label: t("evx_window_all") },
  ];
  return (
    <div className="flex items-center gap-1">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className="transition-colors rounded"
          style={{
            padding: "3px 9px",
            color: value === o.id ? "var(--c-ink-1)" : "var(--c-ink-3)",
            background: value === o.id ? "var(--c-panel)" : "transparent",
            fontWeight: value === o.id ? 500 : 400,
            fontSize: 12.5,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function LiveDot({ connected, lastFetchAt, t }: { connected: boolean; lastFetchAt: Date | null; t: (k: string) => string }) {
  return (
    <span
      className="flex items-center gap-1.5 text-ink-3"
      title={connected ? `${t("evx_last_refresh")} ${lastFetchAt?.toLocaleTimeString("zh-CN", { hour12: false }) ?? ""}` : t("evx_connecting_inngest")}
      style={{ fontSize: 11.5 }}
    >
      <span
        className={connected ? "rounded-full anim-pulse" : "rounded-full"}
        style={{ width: 6, height: 6, background: connected ? "var(--c-ok)" : "var(--c-ink-4)" }}
      />
      {connected ? t("evx_live") : t("evx_connecting")}
    </span>
  );
}

// ── Event registry (Ontology / Neo4j) ───────────────────────────

function useEventRegistry() {
  const { domain } = useDomain();
  const [registry, setRegistry] = React.useState<Map<string, EventContract>>(new Map());
  const [syncing, setSyncing] = React.useState(false);

  const refreshRegistry = React.useCallback(async () => {
    try {
      const body = await fetchJson<EventsResponse>(
        `/api/events?includeRetired=1&domain=${encodeURIComponent(domain)}`,
      );
      const m = new Map<string, EventContract>();
      for (const e of body.events ?? []) m.set(e.name, e);
      setRegistry(m);
    } catch { /* soft */ }
  }, [domain]);

  const syncNow = React.useCallback(async () => {
    setSyncing(true);
    try {
      await fetch("/api/em/sync-now", { method: "POST" });
      await new Promise((r) => setTimeout(r, 1500)); // give the sync worker a moment
    } catch { /* soft */ } finally {
      setSyncing(false);
    }
  }, []);

  React.useEffect(() => {
    refreshRegistry();
    const t = setInterval(refreshRegistry, 60_000);
    return () => clearInterval(t);
  }, [refreshRegistry]);

  return { registry, syncing, refreshRegistry, syncNow };
}

// ── EM status bar (Event Manager + Neo4j sync) ──────────────────

function EmStatusBar({
  emHealth, registryCount, onSync, syncing, t,
}: {
  emHealth: ReturnType<typeof useEmHealth>["data"];
  registryCount: number;
  onSync: () => Promise<void>;
  syncing: boolean;
  t: (k: string) => string;
}) {
  if (!emHealth) {
    return (
      <div className="mt-3 text-ink-4" style={{ fontSize: 12 }}>{t("evx_loading_em_status")}</div>
    );
  }
  const emState = emHealth.em.state;
  const emColor =
    emState === "healthy"  ? "var(--c-ok)" :
    emState === "degraded" ? "var(--c-warn)" :
    "var(--c-err)";
  const neo4jReachable = emHealth.neo4j.reachable;
  const neo4jColor = neo4jReachable ? "var(--c-ok)" : "var(--c-err)";
  const lastSync = emHealth.neo4j.lastSyncAt;
  return (
    <div
      className="mt-3 flex items-center gap-x-5 gap-y-1 flex-wrap text-ink-2"
      style={{
        fontSize: 12,
        padding: "10px 14px",
        background: "var(--c-panel)",
        border: "1px solid var(--c-line)",
        borderRadius: 8,
      }}
    >
      <span className="flex items-center gap-1.5">
        <span className="rounded-full" style={{ width: 6, height: 6, background: emColor }} />
        <span className="text-ink-3">{t("evx_event_manager")}</span>
        <span className="text-ink-1">{stateZh(emState, t)}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="rounded-full" style={{ width: 6, height: 6, background: neo4jColor }} />
        <span className="text-ink-3">Ontology</span>
        <span className="text-ink-1">{neo4jReachable ? t("evx_reachable") : t("evx_unreachable")}</span>
      </span>
      <span>
        <span className="text-ink-3">{t("evx_registered_events")}</span>{" "}
        <span className="text-ink-1 tabular-nums">{registryCount}</span>
      </span>
      <span>
        <span className="text-ink-3">{t("evx_last_sync")}</span>{" "}
        <span className="text-ink-1 tabular-nums">{lastSync ? relativeTimeZh(lastSync, t) : "—"}</span>
      </span>
      <span>
        <span className="text-ink-3">{t("evx_24h_fallback")}</span>{" "}
        <span
          className="tabular-nums"
          style={{ color: emHealth.em.fallbackCount24h > 0 ? "var(--c-warn)" : "var(--c-ink-1)" }}
        >
          {emHealth.em.fallbackCount24h}
        </span>
      </span>
      <div className="flex-1" />
      <button
        onClick={() => onSync()}
        disabled={syncing}
        className="rounded border border-line bg-surface hover:bg-panel transition-colors"
        style={{
          padding: "3px 10px", fontSize: 12,
          color: "var(--c-ink-1)",
          cursor: syncing ? "wait" : "pointer",
          opacity: syncing ? 0.6 : 1,
        }}
      >
        {syncing ? t("evx_syncing") : `↻ ${t("evx_sync_ontology")}`}
      </button>
    </div>
  );
}

function stateZh(s: string, t: (k: string) => string): string {
  if (s === "healthy") return t("evx_em_healthy");
  if (s === "degraded") return t("evx_em_degraded");
  if (s === "down") return t("evx_em_down");
  if (s === "unconfigured") return t("evx_em_unconfigured");
  return s;
}

function relativeTimeZh(iso: string | null, t: (k: string) => string): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "—";
  const diffSec = Math.max(0, (Date.now() - ts) / 1000);
  if (diffSec < 60) return `${Math.floor(diffSec)} ${t("evx_ago_sec")}`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} ${t("evx_ago_min")}`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} ${t("evx_ago_hour")}`;
  return `${Math.floor(diffSec / 86400)} ${t("evx_ago_day")}`;
}

// ── Registration badge ──────────────────────────────────────────

function RegistrationBadge({ contract, large, t }: { contract: EventContract | null; large?: boolean; t: (k: string) => string }) {
  const padding = large ? "3px 9px" : "1px 6px";
  const size = large ? 12 : 10.5;
  if (contract) {
    const retired = !!contract.retiredAt;
    if (retired) {
      return (
        <span
          className="inline-flex items-center gap-1 rounded"
          title={t("evx_badge_retired_tip")}
          style={{
            padding, fontSize: size,
            background: "var(--c-warn-bg)",
            color: "oklch(0.5 0.14 75)",
            border: "1px solid color-mix(in oklab, var(--c-warn) 30%, transparent)",
          }}
        >
          {t("evx_badge_retired")}
        </span>
      );
    }
    return (
      <span
        className="inline-flex items-center gap-1 rounded"
        title={t("evx_badge_registered_tip")}
        style={{
          padding, fontSize: size,
          background: "var(--c-ok-bg)",
          color: "var(--c-ok)",
          border: "1px solid color-mix(in oklab, var(--c-ok) 25%, transparent)",
        }}
      >
        <span className="rounded-full" style={{ width: 4, height: 4, background: "var(--c-ok)" }} />
        {t("evx_badge_registered")}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded"
      title={t("evx_badge_unregistered_tip")}
      style={{
        padding, fontSize: size,
        background: "transparent",
        color: "var(--c-ink-3)",
        border: "1px dashed var(--c-line-strong)",
      }}
    >
      {t("evx_badge_unregistered")}
    </span>
  );
}

// ── DLQ (rejected events) ───────────────────────────────────────

type DlqRow = {
  id: string;
  externalEventId: string | null;
  name: string;
  source: string;
  status: string;
  rejectionType: string | null;
  rejectionReason: string | null;
  schemaErrors: unknown | null;
  schemaVersionUsed: string | null;
  triedVersions: string[] | null;
  payloadSummary: string | null;
  domain?: string | null;
  ts: string;
};

type DlqState = {
  rows: DlqRow[];
  total: number;
  totalPages: number | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const DLQ_STATUSES = "rejected_schema,rejected_filter,duplicate,meta_rejection,em_degraded";

function useDlq(active: boolean, domain: string, page: number, pageSize: number): DlqState {
  const [rows, setRows] = React.useState<DlqRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ statusIn: DLQ_STATUSES, domain });
      setPaginationParams(params, page, pageSize);
      const res = await fetch(`/api/em/event-instances?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const nextRows = Array.isArray(body.rows) ? body.rows : [];
      const pagination = paginationFrom(body, { page, pageSize, rowCount: nextRows.length });
      setRows(nextRows);
      setTotal(pagination.total ?? nextRows.length);
      setTotalPages(pagination.totalPages);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [domain, page, pageSize]);

  React.useEffect(() => {
    refresh();
    // Keep DLQ count fresh in background even when not viewing it.
    const t = setInterval(refresh, active ? 5000 : 30_000);
    return () => clearInterval(t);
  }, [refresh, active]);

  return { rows, total, totalPages, loading, error, refresh };
}

function ViewToggle({
  value, dlqCount, onChange, t,
}: {
  value: "stream" | "dlq";
  dlqCount: number;
  onChange: (v: "stream" | "dlq") => void;
  t: (k: string) => string;
}) {
  const opts: { id: "stream" | "dlq"; label: string; count?: number }[] = [
    { id: "stream", label: t("evx_view_stream") },
    { id: "dlq", label: t("evx_view_dlq"), count: dlqCount },
  ];
  return (
    <div className="flex items-center gap-1">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className="transition-colors rounded flex items-center gap-1.5"
          style={{
            padding: "5px 12px",
            fontSize: 13,
            color: value === o.id ? "var(--c-ink-1)" : "var(--c-ink-3)",
            background: value === o.id ? "var(--c-panel)" : "transparent",
            fontWeight: value === o.id ? 500 : 400,
            border: value === o.id ? "1px solid var(--c-line)" : "1px solid transparent",
          }}
        >
          {o.label}
          {typeof o.count === "number" && (
            <span
              className="tabular-nums"
              style={{
                fontSize: 11,
                padding: "1px 6px",
                borderRadius: 10,
                background: o.count > 0 ? "var(--c-err-bg)" : "var(--c-panel)",
                color: o.count > 0 ? "var(--c-err)" : "var(--c-ink-3)",
                border: "1px solid var(--c-line)",
              }}
            >
              {o.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function DlqView({
  dlq,
  page,
  pageSize,
  onPageChange,
  t,
}: {
  dlq: DlqState;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  t: (k: string) => string;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = dlq.rows.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(380px, 520px)" }}>
      <div className="border-r border-line flex flex-col min-h-0">
        <div className="flex-1 overflow-auto min-h-0">
          <div
            className="grid gap-4 text-ink-4 uppercase tracking-[0.1em] font-medium border-b border-line sticky top-0 bg-bg z-10"
            style={{ gridTemplateColumns: "130px minmax(0, 1.2fr) 130px minmax(0, 1fr)", padding: "10px 24px", fontSize: 10.5 }}
          >
            <span>{t("evx_col_time")}</span>
            <span>{t("evx_col_event_name")}</span>
            <span>{t("evx_col_reject_type")}</span>
            <span>{t("evx_col_reason")}</span>
          </div>
          {dlq.loading && dlq.rows.length === 0 && (
            <div className="text-ink-3 text-center py-16" style={{ fontSize: 13 }}>{t("evx_loading")}</div>
          )}
          {!dlq.loading && dlq.rows.length === 0 && (
            <div className="text-ink-3 text-center py-16" style={{ fontSize: 13 }}>
              {dlq.error ? `${t("evx_load_failed")}: ${dlq.error}` : t("evx_dlq_empty")}
              {dlq.error && (
                <div className="mt-3"><button className="text-accent hover:underline" onClick={() => void dlq.refresh()}>{t("evx_retry")}</button></div>
              )}
            </div>
          )}
          {dlq.rows.map((r) => {
          const isSelected = r.id === selectedId;
          return (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className="w-full grid items-center gap-4 border-b border-line transition-colors text-left"
              style={{
                padding: "11px 24px",
                gridTemplateColumns: "130px minmax(0, 1.2fr) 130px minmax(0, 1fr)",
                background: isSelected ? "var(--c-panel)" : "transparent",
                cursor: "pointer",
              }}
            >
              <span className="text-ink-3 tabular-nums" style={{ fontSize: 11.5 }}>
                {fmtTime(r.ts)}
              </span>
              <span className="text-ink-1 truncate" style={{ fontSize: 13, fontWeight: 500 }}>
                {r.name}
              </span>
              <span>
                <RejectionBadge status={r.status} type={r.rejectionType} t={t} />
              </span>
              <span className="text-ink-3 truncate" style={{ fontSize: 12 }}>
                {r.rejectionReason ?? "—"}
              </span>
            </button>
          );
          })}
        </div>
        <Pagination
          page={page}
          pageSize={pageSize}
          rowCount={dlq.rows.length}
          total={dlq.total}
          totalPages={dlq.totalPages}
          loading={dlq.loading}
          onPageChange={onPageChange}
        />
      </div>
      <div className="overflow-auto">
        {selected ? (
          <DlqDetailViewer row={selected} onClose={() => setSelectedId(null)} t={t} />
        ) : (
          <div className="text-ink-3 text-center py-16" style={{ fontSize: 13 }}>
            {t("evx_pick_rejected_for_detail")}
          </div>
        )}
      </div>
    </div>
  );
}

function RejectionBadge({ status, type, t }: { status: string; type: string | null; t: (k: string) => string }) {
  const label =
    status === "rejected_schema"  ? t("evx_rej_schema") :
    status === "rejected_filter"  ? t("evx_rej_filter") :
    status === "duplicate"        ? t("evx_rej_duplicate") :
    status === "meta_rejection"   ? t("evx_rej_meta") :
    status === "em_degraded"      ? t("evx_rej_em_degraded") :
    status;
  const color =
    status === "duplicate"   ? "var(--c-ink-3)" :
    status === "em_degraded" ? "oklch(0.5 0.14 75)" :
    "var(--c-err)";
  const bg =
    status === "duplicate"   ? "var(--c-panel)" :
    status === "em_degraded" ? "var(--c-warn-bg)" :
    "var(--c-err-bg)";
  return (
    <span
      className="inline-flex items-center gap-1 rounded"
      style={{
        padding: "2px 7px",
        fontSize: 11,
        color,
        background: bg,
        border: "1px solid " + (status === "duplicate" ? "var(--c-line)" : `color-mix(in oklab, ${color} 25%, transparent)`),
      }}
      title={type ?? undefined}
    >
      {label}
    </span>
  );
}

function DlqDetailViewer({ row, onClose, t }: { row: DlqRow; onClose: () => void; t: (k: string) => string }) {
  return (
    <div style={{ padding: "20px 24px" }}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap min-w-0">
          <h2 className="m-0 text-ink-1 break-all" style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 500, letterSpacing: "-0.01em" }}>
            {row.name}
          </h2>
          <RejectionBadge status={row.status} type={row.rejectionType} t={t} />
        </div>
        <button onClick={onClose} className="text-ink-3 hover:text-ink-1" style={{ fontSize: 13 }}>×</button>
      </div>

      <div className="mt-3 grid gap-y-1.5" style={{ gridTemplateColumns: "auto 1fr", columnGap: 16, fontSize: 12 }}>
        <span className="text-ink-3">{t("evx_instance_id")}</span>
        <code className="text-ink-2 tabular-nums break-all" style={{ fontFamily: "var(--f-mono)", fontSize: 11.5 }}>{row.id}</code>
        {row.externalEventId && (
          <>
            <span className="text-ink-3">External ID</span>
            <code className="text-ink-2 tabular-nums break-all" style={{ fontFamily: "var(--f-mono)", fontSize: 11.5 }}>{row.externalEventId}</code>
          </>
        )}
        <span className="text-ink-3">{t("evx_source")}</span>
        <span className="text-ink-2" style={{ fontSize: 12 }}>{row.source || "—"}</span>
        <span className="text-ink-3">{t("evx_reject_time")}</span>
        <span className="text-ink-2 tabular-nums" style={{ fontSize: 12 }}>{fmtTimeFull(row.ts)}</span>
        {row.schemaVersionUsed && (
          <>
            <span className="text-ink-3">{t("evx_tried_schema_version")}</span>
            <span className="text-ink-2 tabular-nums" style={{ fontSize: 12 }}>
              {row.schemaVersionUsed}
              {row.triedVersions && row.triedVersions.length > 1 && (
                <span className="text-ink-4 ml-2">({t("evx_tried_count_pre")}{row.triedVersions.length}{t("evx_tried_count_mid")}{row.triedVersions.join(", ")})</span>
              )}
            </span>
          </>
        )}
      </div>

      {row.rejectionReason && (
        <div className="mt-5">
          <div className="text-ink-3 mb-2" style={{ fontSize: 12 }}>{t("evx_reject_reason")}</div>
          <pre
            className="text-ink-1 whitespace-pre-wrap break-words"
            style={{
              fontFamily: "var(--f-mono)", fontSize: 11.5,
              margin: 0, padding: "10px 12px",
              background: "var(--c-surface)",
              border: "1px solid color-mix(in oklab, var(--c-err) 18%, var(--c-line))",
              borderRadius: 6,
              maxHeight: 200, overflow: "auto", lineHeight: 1.55,
            }}
          >
            {row.rejectionReason}
          </pre>
        </div>
      )}

      {row.schemaErrors != null && (
        <div className="mt-5">
          <div className="text-ink-3 mb-2" style={{ fontSize: 12 }}>{t("evx_schema_errors")}</div>
          <pre
            className="text-ink-1 whitespace-pre-wrap break-words"
            style={{
              fontFamily: "var(--f-mono)", fontSize: 11,
              margin: 0, padding: "10px 12px",
              background: "var(--c-surface)",
              border: "1px solid var(--c-line)",
              borderRadius: 6,
              maxHeight: 280, overflow: "auto", lineHeight: 1.55,
            }}
          >
            {safeJsonStringify(row.schemaErrors)}
          </pre>
        </div>
      )}

      {row.payloadSummary && (
        <div className="mt-5">
          <div className="text-ink-3 mb-2" style={{ fontSize: 12 }}>{t("evx_payload_summary")}</div>
          <pre
            className="text-ink-1 whitespace-pre-wrap break-words"
            style={{
              fontFamily: "var(--f-mono)", fontSize: 11,
              margin: 0, padding: "10px 12px",
              background: "var(--c-surface)",
              border: "1px solid var(--c-line)",
              borderRadius: 6,
              maxHeight: 280, overflow: "auto", lineHeight: 1.55,
            }}
          >
            {row.payloadSummary}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Registration filter (disabled for now per user request 2026-05-19) ──

function RegistrationFilter({
  value, disabled, t,
}: {
  value: "all" | "registered" | "unregistered";
  disabled?: boolean;
  t: (k: string) => string;
}) {
  const opts: { id: "all" | "registered" | "unregistered"; label: string }[] = [
    { id: "all", label: t("evx_reg_all") },
    { id: "registered", label: t("evx_reg_registered") },
    { id: "unregistered", label: t("evx_reg_unregistered") },
  ];
  return (
    <div
      className="flex items-center gap-1"
      title={disabled ? t("evx_in_development") : ""}
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <span className="text-ink-3" style={{ fontSize: 11.5 }}>{t("evx_col_registration")}</span>
      {opts.map((o) => (
        <button
          key={o.id}
          disabled={disabled}
          className="transition-colors rounded"
          style={{
            padding: "3px 9px",
            color: value === o.id ? "var(--c-ink-1)" : "var(--c-ink-3)",
            background: value === o.id ? "var(--c-panel)" : "transparent",
            fontWeight: value === o.id ? 500 : 400,
            fontSize: 12.5,
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
