"use client";
import React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Btn } from "@/components/shared/atoms";
import { InngestPill } from "@/components/shared/InngestPill";
import { fetchJson } from "@/lib/api/client";
import type { AgentsResponse, AgentRow } from "@/lib/api/types";
import { isReal, deploymentKind, type DeploymentKind } from "@/lib/agent-mapping";
import { useDomain } from "@/lib/domains";
import { useInngestLiveOverlay, WSID_TO_INNGEST_SLUG, type LiveAgentState } from "@/lib/api/inngest-live-overlay";

// Fleet IA v2.1 — see docs/superpowers/specs/2026-05-19-fleet-ia-design.md
// Three-pillar entry surface: deploy (Behavior) · monitor · govern (Manage).
// This pass tightens typography and drops decorative chrome — glyph tiles,
// chevrons, all-caps pills — to land closer to Claude's calm aesthetic.
//
// Realness (real vs stub) is orthogonal to lifecycle. See spec §3.
// "real" = registered as an Inngest function (4 production agents today,
// see docs/workflow-agents-inngest-spec.md §10).

type Lifecycle = "active" | "paused" | "deprecated" | "draft";
// Status semantics (per Kenny's "Speed/subway control board" framing):
// the headline answers "is this agent online?" — deployment state, NOT
// transient runtime success. Past run failures are operational details
// surfaced in the 近期运行 column and the detail page, not the headline.
//   deployed     — real or shell Inngest function, not paused → 绿
//   paused       — real, manually paused                     → 灰
//   not_deployed — unbuilt (no Inngest function yet)         → 红
type FleetStatus = "deployed" | "paused" | "not_deployed";
type Realness = DeploymentKind; // "real" | "shell" | "unbuilt"

type FleetRow = {
  short: string;
  name: string;
  roleK: string;
  ownerTeam: string;
  stage: AgentRow["stage"];
  version: string;
  status: FleetStatus;
  lifecycle: Lifecycle;
  realness: Realness;
  // Run statistics — all from Inngest admin API for real agents, null for stubs.
  liveTotal: number | null;
  liveCompleted: number | null;
  liveFailed: number | null;
  liveRunning: number | null;
  successRate: number | null;   // computed: completed / total
  p95Ms: number | null;         // P95 run duration over the sampled window
  lastActiveAt: string | null;  // ISO timestamp from latest run
  paused: boolean;
  // Inngest slug for pause/resume mutation
  slug: string | null;
};

// Status answers "is this agent currently online?", not "have past runs
// succeeded?". Run-level failures live in the 近期运行 column and detail page.
function deriveStatus(realness: Realness, paused: boolean, live: LiveAgentState | undefined): FleetStatus {
  if (realness === "unbuilt") return "not_deployed";
  if (paused) return "paused";
  if (live?.paused) return "paused";
  return "deployed";
}


// "Anomaly" = operational attention needed on a deployed agent. Paused is
// intentional (not anomalous); stubs are a known gap (also not anomalous).
// Anomaly only fires on a deployed agent whose recent quality dropped.
function isAnomalous(r: FleetRow): boolean {
  if (r.status !== "deployed") return false;
  if (r.successRate != null && r.successRate < 80) return true;
  return false;
}

function buildRows(api: AgentsResponse, liveByWsId: Map<string, LiveAgentState>): FleetRow[] {
  return api.agents.map((a) => {
    // Read realness + slug directly from the API response (which sources them
    // from lib/inngest-registry.ts server-side). Do NOT call deploymentKind()
    // here — that's the sync helper that reads server-process module cache,
    // which is empty in the browser → would mark every agent as 'unbuilt'.
    const realness: Realness = a.realness;
    const deployed = realness !== "unbuilt";
    const live = deployed ? liveByWsId.get(a.wsId) : undefined;
    const slug = a.slug ?? (deployed ? WSID_TO_INNGEST_SLUG[a.wsId] ?? null : null);
    // `paused` comes from the API (which sources it from AgentConfig +
    // registry), not from `live` — Inngest doesn't report paused functions
    // so live?.paused would be undefined for the 19 paused shells.
    const paused = a.paused;

    let lifecycle: Lifecycle;
    if (realness === "unbuilt") lifecycle = "draft";
    else if (paused) lifecycle = "paused";
    else lifecycle = "active";

    return {
      short: a.short,
      name: a.inngestName ?? a.short,
      roleK: a.displayName,
      ownerTeam: a.ownerTeam,
      stage: a.stage,
      version: a.version,
      status: deriveStatus(realness, paused, live),
      lifecycle,
      realness,
      liveTotal: live?.total ?? null,
      liveCompleted: live?.completed ?? null,
      liveFailed: live?.failed ?? null,
      liveRunning: live?.running ?? null,
      successRate: live?.successRate ?? null,
      p95Ms: live?.p95Ms ?? null,
      lastActiveAt: live?.latestStartedAt ?? null,
      paused,
      slug,
    };
  });
}

// ────────────────────────────────────────────────────────────────────

// Stages in workflow order — used to sort groups when grouping by stage so
// the page reads top-to-bottom in pipeline order (需求 → JD → 简历 → ...)
// regardless of how many live agents each stage currently has.
const STAGE_ORDER = [
  "system",
  "requirement",
  "jd",
  "resume",
  "match",
  "interview",
  "eval",
  "package",
  "submit",
] as const;

const STAGE_KEYS: Record<string, string> = {
  system: "flx_stage_system",
  requirement: "flx_stage_requirement",
  jd: "flx_stage_jd",
  resume: "flx_stage_resume",
  match: "flx_stage_match",
  interview: "flx_stage_interview",
  eval: "flx_stage_eval",
  package: "flx_stage_package",
  submit: "flx_stage_submit",
};

function stageLabel(stage: string, t: (k: string) => string): string {
  const k = STAGE_KEYS[stage];
  return k ? t(k) : stage;
}

export function FleetContent() {
  const { t } = useApp();
  const router = useRouter();
  const sp = useSearchParams();

  // Grouping chooser removed per user request — Fleet now always renders flat.
  // Variable kept (assigned constant) so existing groupRows/render code is untouched.
  const group: "team" | "status" | "stage" | "flat" = "flat";
  const statusFilter = (sp.get("status") ?? "all") as FilterId;
  const windowId = (sp.get("window") ?? "7d") as "7d" | "30d" | "90d";

  const setUrl = React.useCallback(
    (mut: (params: URLSearchParams) => void) => {
      const next = new URLSearchParams(sp.toString());
      mut(next);
      router.replace(`/fleet${next.toString() ? `?${next.toString()}` : ""}`);
    },
    [router, sp],
  );

  const [agentsRes, setAgentsRes] = React.useState<AgentsResponse | null>(null);
  const [partial, setPartial] = React.useState(false);
  const { byWsId: liveByWsId, lastRefresh } = useInngestLiveOverlay();

  // Refetch /api/agents on mount, every 5s, AND on demand (after toggle).
  // Without polling the "实装" count only reflected what was true at page-load
  // time — pause/resume actions never moved the number.
  const refetchAgents = React.useCallback(() => {
    fetchJson<AgentsResponse>("/api/agents")
      .then((res) => {
        if (res.meta.partial?.includes("ws")) setPartial(true);
        setAgentsRes(res);
      })
      .catch(() => {
        setPartial(true);
        setAgentsRes((prev) => prev ?? { agents: [], meta: { generatedAt: new Date().toISOString() } });
      });
  }, []);

  React.useEffect(() => {
    refetchAgents();
    const id = setInterval(refetchAgents, 5_000);
    return () => clearInterval(id);
  }, [refetchAgents]);

  // Domain filter — scopes Fleet to current top-level container (RAAS / R7 / …).
  // Switcher lives in AppBar; state persists via lib/domains.tsx provider.
  const { domain } = useDomain();
  const scopedRes = React.useMemo(() => {
    if (!agentsRes) return null;
    // Chatbot is the UI assistant (AO·UI), not a recruitment-pipeline agent —
    // hide it from the fleet list / counts.
    return { ...agentsRes, agents: agentsRes.agents.filter((a) => a.domain === domain && a.short !== "Chatbot") };
  }, [agentsRes, domain]);

  const rows: FleetRow[] | null = scopedRes ? buildRows(scopedRes, liveByWsId) : null;
  const safeRows = rows ?? [];

  // Local optimistic toggle — reflect new state immediately, then await
  // server confirmation before clearing the override. Bug history:
  //   - v1: cleared optimistic state on a blind 1.5s timer. Could expose a
  //     stale /api/agents snapshot (registry cache served pre-toggle data,
  //     making the agent render as 'unbuilt' for a few seconds).
  //   - v2 (now): clear optimistic only when the refetched row reflects the
  //     new paused state. Toggle endpoint also invalidates registry cache,
  //     so first refetch normally already shows the new state.
  const [optimisticPause, setOptimisticPause] = React.useState<Record<string, boolean>>({});
  const togglePause = React.useCallback(async (slug: string, next: boolean) => {
    setOptimisticPause((m) => ({ ...m, [slug]: next }));
    try {
      await fetch(`/api/inngest-admin/functions/${encodeURIComponent(slug)}/toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: next }),
      });
      refetchAgents();
    } catch {
      // Toggle failed server-side — drop the optimistic flip so the UI
      // returns to the actual current state.
      setOptimisticPause((m) => { const c = { ...m }; delete c[slug]; return c; });
    }
  }, [refetchAgents]);

  // Clear optimistic overrides once the freshly-fetched row matches them.
  // Decoupling from a timer means we never expose a stale snapshot during
  // the refetch window, regardless of network latency or cache TTLs.
  React.useEffect(() => {
    if (!agentsRes) return;
    setOptimisticPause((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const k of keys) {
        const row = agentsRes.agents.find((a) => a.slug === k);
        if (row && row.paused === prev[k]) {
          // server matches optimistic; drop the override
          changed = true;
          continue;
        }
        next[k] = prev[k];
      }
      return changed ? next : prev;
    });
  }, [agentsRes]);
  // Apply optimistic overrides
  const effectiveRows = safeRows.map((r) => {
    if (!r.slug || !(r.slug in optimisticPause)) return r;
    const paused = optimisticPause[r.slug];
    return {
      ...r,
      paused,
      status: paused ? ("paused" as FleetStatus) : ("deployed" as FleetStatus),
      lifecycle: paused ? ("paused" as Lifecycle) : ("active" as Lifecycle),
    };
  });

  const filtered = React.useMemo(() => {
    if (statusFilter === "all") return effectiveRows;
    if (statusFilter === "live") return effectiveRows.filter((r) => r.status === "deployed");
    if (statusFilter === "blueprint") return effectiveRows.filter((r) => r.status === "not_deployed");
    if (statusFilter === "anomalies") return effectiveRows.filter((r) => isAnomalous(r));
    if (statusFilter === "paused") return effectiveRows.filter((r) => r.status === "paused");
    if (statusFilter === "deprecated") return effectiveRows.filter((r) => r.lifecycle === "deprecated");
    return effectiveRows;
  }, [effectiveRows, statusFilter]);

  const grouped = React.useMemo(() => groupRows(filtered, group), [filtered, group]);

  const total = effectiveRows.length;
  // Tab counts. "在线" = deployed & not paused; "蓝图" = not yet built.
  const onlineCount = effectiveRows.filter((r) => r.status === "deployed").length;
  const blueprintCount = effectiveRows.filter((r) => r.status === "not_deployed").length;
  const realRowsWithRuns = effectiveRows.filter((r) => r.realness === "real" && r.successRate != null);
  const aggSuccessRate = realRowsWithRuns.length
    ? realRowsWithRuns.reduce((sum, r) => sum + (r.successRate as number), 0) / realRowsWithRuns.length
    : null;
  const anomalies = effectiveRows.filter((r) => r.realness === "real" && isAnomalous(r)).length;

  const setStatusFilter = (next: FilterId) =>
    setUrl((p) => { if (next === "all") p.delete("status"); else p.set("status", next); });
  const setWindow = (next: typeof windowId) =>
    setUrl((p) => { if (next === "7d") p.delete("window"); else p.set("window", next); });

  const [behaviorModal, setBehaviorModal] = React.useState(false);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-auto bg-bg">
      {/* page header */}
      <div className="border-b border-line" style={{ padding: "28px 32px 18px" }}>
        <div className="flex items-start gap-6">
          <div className="flex-1 min-w-0">
            <div className="text-[10.5px] uppercase tracking-[0.16em] font-medium text-ink-4 mb-2">
              {t("fleet_title")} · AGENT FLEET
            </div>
            <h1
              className="m-0 text-ink-1 tabular-nums"
              style={{
                fontFamily: 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif',
                fontWeight: 500,
                fontSize: 30,
                letterSpacing: "-0.015em",
                lineHeight: 1.15,
              }}
            >
              {agentsRes === null ? t("fleet_title") : `${total} ${t("flx_count_suffix")}`}
            </h1>
            <div className="text-ink-2 mt-1.5" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
              {t("fleet_sub")}
            </div>
          </div>
          <div className="flex items-center gap-3 mt-1 shrink-0">
            <InngestPill />
            <LiveIndicator lastRefresh={lastRefresh} t={t} />
            {partial && (
              <span className="text-[11.5px] text-ink-3 flex items-center gap-1.5">
                <span className="rounded-full" style={{ width: 6, height: 6, background: "var(--c-warn)" }} />
                {t("flx_partial_data")}
              </span>
            )}
            <Btn variant="primary" size="sm" onClick={() => setBehaviorModal(true)}>
              <Ic.plus /> {t("deploy_agent")}
            </Btn>
          </div>
        </div>
      </div>

      {/* tabs — replaces the old chip strip + filter dropdown. The four
          tabs map straight onto the existing status filters. */}
      <div className="border-b border-line flex items-end gap-x-2 flex-wrap" style={{ padding: "0 32px" }}>
        <FleetTabs
          value={statusFilter}
          onChange={setStatusFilter}
          counts={{ all: total, live: onlineCount, anomalies, blueprint: blueprintCount }}
          t={t}
        />
        <div className="flex-1" />
        <div className="flex items-center gap-4 pb-2.5">
          {aggSuccessRate != null && (
            <span className="text-[12px] text-ink-3 tabular-nums">
              {t("f2_chip_success_7d")}{" "}
              <span
                className="font-semibold"
                style={{ color: aggSuccessRate >= 95 ? "var(--c-ok)" : aggSuccessRate >= 90 ? "oklch(0.5 0.14 75)" : "var(--c-err)" }}
              >
                {aggSuccessRate.toFixed(1)}%
              </span>
            </span>
          )}
          <PeriodDropdown value={windowId} onChange={setWindow} t={t} />
        </div>
      </div>

      {/* list */}
      <div className="flex-1 min-h-0" style={{ padding: "4px 32px 48px" }}>
        {agentsRes === null && (
          <div className="text-ink-3 text-[13px] text-center py-16">{t("flx_loading")}</div>
        )}
        {agentsRes !== null && grouped.length > 0 && (
          <div
            className="grid gap-4 text-ink-3 border-b border-line"
            style={{ gridTemplateColumns: GRID, padding: "8px 12px", fontSize: 11.5 }}
          >
            <span>{t("flx_col_agent")}</span>
            <span>{t("flx_col_deploy_status")}</span>
            <span>{t("flx_col_recent_runs")}</span>
            <span>{t("flx_col_success_rate")}</span>
            <span style={{ textAlign: "right" }}>{t("flx_col_p95")}</span>
            <span style={{ textAlign: "right" }}>{t("flx_col_actions")}</span>
          </div>
        )}
        {agentsRes !== null && effectiveRows.length === 0 ? (
          <DomainEmptyStateCard onDeploy={() => setBehaviorModal(true)} t={t} />
        ) : (
          <>
            {agentsRes !== null && grouped.map((g) => (
              <section key={g.key}>
                {group !== "flat" && <GroupHeader title={groupTitle(g.title, group, t)} rows={g.rows} t={t} />}
                {g.rows.map((r, i) => (
                  <AgentListRow key={r.short} row={r} idx={i} t={t} onTogglePause={togglePause} />
                ))}
              </section>
            ))}
            {agentsRes !== null && grouped.length === 0 && (
              <div className="text-ink-3 text-[13px] text-center py-16">
                {t("flx_no_match")}
              </div>
            )}
          </>
        )}
        {agentsRes !== null && filtered.length > 0 && (
          <div className="flex items-center gap-2 text-[12px] text-ink-3 mt-6">
            <span>{t("flx_showing")} {filtered.length} / {total}</span>
          </div>
        )}
      </div>

      {behaviorModal && (
        <BehaviorPlaceholderModal onClose={() => setBehaviorModal(false)} t={t} />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

type FilterId = "all" | "live" | "blueprint" | "anomalies" | "paused" | "deprecated";

function sortWithinGroup(rs: FleetRow[]): FleetRow[] {
  return [...rs].sort((a, b) => {
    if (a.realness !== b.realness) return a.realness === "real" ? -1 : 1;
    const ar = a.successRate ?? -1;
    const br = b.successRate ?? -1;
    return br - ar;
  });
}

function groupRows(rows: FleetRow[], group: "team" | "status" | "stage" | "flat") {
  if (group === "flat") {
    return [{ key: "flat", title: "", rows: sortWithinGroup(rows) }];
  }
  const map = new Map<string, FleetRow[]>();
  for (const r of rows) {
    const key =
      group === "team" ? r.ownerTeam :
      group === "stage" ? r.stage :
      r.status;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  const entries = [...map.entries()];
  if (group === "stage") {
    // Workflow pipeline order — fixed regardless of live count.
    entries.sort((a, b) => {
      const ai = STAGE_ORDER.indexOf(a[0] as typeof STAGE_ORDER[number]);
      const bi = STAGE_ORDER.indexOf(b[0] as typeof STAGE_ORDER[number]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  } else {
    // For team/status: real-heavy first, then alphabetical.
    entries.sort((a, b) => {
      const aLive = a[1].filter((r) => r.realness === "real").length;
      const bLive = b[1].filter((r) => r.realness === "real").length;
      if (aLive !== bLive) return bLive - aLive;
      return a[0].localeCompare(b[0]);
    });
  }
  return entries.map(([k, rs]) => ({ key: k, title: k, rows: sortWithinGroup(rs) }));
}

function groupTitle(title: string, group: string, t: (k: string) => string): string {
  if (group === "stage") return stageLabel(title, t);
  return title;
}

// ── tabs ───────────────────────────────────────────────────────────
// 全部 / 在线 / 需关注 / 蓝图 — map straight onto the status filters. The
// active indicator is a sliding underline (ao-tab-underline) measured from
// the active button's offset so it animates between tabs.

function FleetTabs({
  value, onChange, counts, t,
}: {
  value: FilterId;
  onChange: (v: FilterId) => void;
  counts: { all: number; live: number; anomalies: number; blueprint: number };
  t: (k: string) => string;
}) {
  const tabs: { id: FilterId; label: string; count: number; tone?: "err" }[] = [
    { id: "all",       label: t("f2_filter_all"),     count: counts.all },
    { id: "live",      label: t("flx_tab_online"),    count: counts.live },
    { id: "anomalies", label: t("flx_need_attention"), count: counts.anomalies, tone: counts.anomalies > 0 ? "err" : undefined },
    { id: "blueprint", label: t("f2_kind_stub"),      count: counts.blueprint },
  ];
  // "anomalies"/"blueprint" are valid filter ids; "live" maps to deployed.
  const active = (["all", "live", "anomalies", "blueprint"] as FilterId[]).includes(value) ? value : "all";
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [ind, setInd] = React.useState<{ left: number; width: number } | null>(null);
  React.useLayoutEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
  }, [active, counts.all, counts.live, counts.anomalies, counts.blueprint]);
  return (
    <div ref={containerRef} className="relative flex items-end gap-1">
      {tabs.map((tab) => {
        const on = active === tab.id;
        return (
          <button
            key={tab.id}
            data-tab={tab.id}
            onClick={() => onChange(tab.id)}
            className="flex items-baseline gap-1.5 transition-colors"
            style={{
              padding: "12px 12px 11px",
              color: on ? "var(--c-ink-1)" : "var(--c-ink-3)",
              fontWeight: on ? 600 : 400,
              fontSize: 13.5,
            }}
          >
            <span>{tab.label}</span>
            <span
              className="tabular-nums"
              style={{ fontSize: 12, color: tab.tone === "err" ? "var(--c-err)" : on ? "var(--c-ink-2)" : "var(--c-ink-4)" }}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
      {ind && (
        <span
          className="absolute ao-tab-underline"
          style={{ bottom: 0, height: 2, background: "var(--c-ink-1)", left: ind.left, width: ind.width }}
        />
      )}
    </div>
  );
}

// ── agent identity tile ────────────────────────────────────────────
// Colored rounded square + glyph (first char of the localized role name),
// echoing the design reference. Color is a stable hash of the agent short
// name → OKLCH hue, so the palette is varied but deterministic.

function tileHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function AgentTile({ seed, label, dim }: { seed: string; label: string; dim?: boolean }) {
  const hue = tileHue(seed);
  const glyph = [...label.trim()][0] ?? "·";
  return (
    <span
      className="rounded-[8px] grid place-items-center flex-shrink-0 font-semibold"
      style={{
        width: 30,
        height: 30,
        fontSize: 13,
        color: `oklch(0.98 0.02 ${hue})`,
        background: `linear-gradient(145deg, oklch(0.62 0.16 ${hue}), oklch(0.52 0.17 ${(hue + 28) % 360}))`,
        opacity: dim ? 0.55 : 1,
        letterSpacing: 0,
      }}
    >
      {glyph}
    </span>
  );
}

// Success-rate bar — track + filled bar (grows on mount) colored by threshold.
function SuccessBar({ rate }: { rate: number | null }) {
  const [grown, setGrown] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  if (rate == null) return <span className="text-ink-4" style={{ fontSize: 13 }}>—</span>;
  const color = rate >= 95 ? "var(--c-ok)" : rate >= 90 ? "oklch(0.62 0.14 75)" : "var(--c-err)";
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className="relative rounded-full overflow-hidden flex-1" style={{ height: 5, background: "color-mix(in oklab, var(--c-line) 70%, transparent)", maxWidth: 90 }}>
        <span
          className="absolute left-0 top-0 bottom-0 rounded-full ao-bar-grow"
          style={{ width: grown ? `${Math.max(2, Math.min(100, rate))}%` : "0%", background: color }}
        />
      </span>
      <span className="tabular-nums" style={{ fontSize: 12.5, color: rate < 90 ? "var(--c-err)" : "var(--c-ink-1)" }}>
        {rate.toFixed(1)}%
      </span>
    </div>
  );
}

function fmtP95(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── period dropdown ───────────────────────────────────────────────

function PeriodDropdown({ value, onChange, t }: { value: "7d" | "30d" | "90d"; onChange: (v: "7d" | "30d" | "90d") => void; t: (k: string) => string }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const label = value === "7d" ? t("f2_window_7d") : value === "30d" ? t("f2_window_30d") : t("f2_window_90d");
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-ink-2 hover:text-ink-1 transition-colors"
        style={{ fontSize: 12.5 }}
      >
        <span className="text-ink-3">{t("flx_period_label")}</span>
        <span className="font-medium">{label}</span>
        <Ic.chevD style={{ width: 10, height: 10 }} />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 bg-surface border border-line rounded-md shadow-sh-2 z-30" style={{ minWidth: 120 }}>
          {(["7d", "30d", "90d"] as const).map((id) => (
            <button
              key={id}
              onClick={() => { onChange(id); setOpen(false); }}
              className="w-full text-left hover:bg-panel transition-colors flex items-center justify-between"
              style={{ padding: "8px 12px", fontSize: 12.5, color: value === id ? "var(--c-ink-1)" : "var(--c-ink-2)" }}
            >
              {id === "7d" ? t("f2_window_7d") : id === "30d" ? t("f2_window_30d") : t("f2_window_90d")}
              {value === id && <Ic.check style={{ width: 12, height: 12 }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── list ──────────────────────────────────────────────────────────

// 智能体 / 状态 / 近期运行 / 成功率 / P95 / 操作
const GRID = "minmax(260px, 1fr) 110px 96px 160px 80px 96px";

function GroupHeader({ title, rows, t }: { title: string; rows: FleetRow[]; t: (k: string) => string }) {
  const deployed = rows.filter((r) => r.status === "deployed").length;
  const paused = rows.filter((r) => r.status === "paused").length;
  const notDeployed = rows.filter((r) => r.status === "not_deployed").length;
  const anomalous = rows.filter((r) => isAnomalous(r)).length;
  return (
    <div className="mt-7 mb-2 flex items-baseline gap-3" style={{ paddingInline: 12 }}>
      <h3 className="m-0 text-ink-1" style={{ fontSize: 14, fontWeight: 500, letterSpacing: "-0.01em" }}>
        {title}
      </h3>
      <span className="text-ink-3" style={{ fontSize: 12 }}>
        {deployed > 0 && <><span style={{ color: "var(--c-ok)" }}>{deployed}</span> {t("flx_status_deployed")}</>}
        {paused > 0 && <>{deployed > 0 && " · "}{paused} {t("flx_status_paused")}</>}
        {notDeployed > 0 && <>{(deployed > 0 || paused > 0) && " · "}<span style={{ color: "var(--c-err)" }}>{notDeployed}</span> {t("flx_status_not_deployed")}</>}
        {anomalous > 0 && <> · <span style={{ color: "var(--c-err)" }}>{anomalous} {t("flx_need_attention")}</span></>}
      </span>
    </div>
  );
}

function AgentListRow({ row, idx, t, onTogglePause }: { row: FleetRow; idx: number; t: (k: string) => string; onTogglePause: (slug: string, paused: boolean) => void }) {
  const stub = row.realness === "unbuilt";
  const dim = row.lifecycle === "deprecated";
  const roleLabel = t(row.roleK);
  return (
    <div
      className="group relative grid gap-4 border-b border-line ao-fade-rise ao-hover-lift"
      style={{
        gridTemplateColumns: GRID,
        padding: "14px 12px",
        opacity: dim ? 0.55 : 1,
        alignItems: "center",
        border: "1px solid transparent",
        borderBottom: "1px solid var(--c-line)",
        ["--ao-i"]: Math.min(idx, 18),
      } as React.CSSProperties}
    >
      {/* the row itself is a link; the action button is a sibling that
          captures clicks before the Link does */}
      <Link
        href={`/fleet/${row.short}`}
        className="absolute inset-0"
        style={{ textDecoration: "none" }}
        aria-label={`open ${row.name}`}
      />

      {/* identity — color tile + name + role/team */}
      <div className="relative flex items-center gap-2.5 min-w-0">
        <AgentTile seed={row.short} label={roleLabel || row.name} dim={stub} />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-ink-1"
            style={{
              fontSize: 13.5,
              fontWeight: 500,
              letterSpacing: "-0.005em",
              textDecoration: row.lifecycle === "deprecated" ? "line-through" : "none",
            }}
          >
            {roleLabel || row.name}
          </div>
          <div className="truncate text-ink-3" style={{ fontSize: 11.5, marginTop: 1 }}>
            {row.short} · {row.ownerTeam}
          </div>
        </div>
      </div>

      {/* status pill */}
      <div className="relative">
        <StatusPill row={row} t={t} />
      </div>

      {/* recent runs — total count */}
      <div className="relative tabular-nums" style={{ fontSize: 13 }}>
        {stub || row.liveTotal == null ? (
          <span className="text-ink-4">—</span>
        ) : (
          <span className="text-ink-1">{row.liveTotal.toLocaleString()} <span className="text-ink-3" style={{ fontSize: 11.5 }}>次</span></span>
        )}
      </div>

      {/* success rate bar */}
      <div className="relative">
        {stub ? <span className="text-ink-4" style={{ fontSize: 13 }}>—</span> : <SuccessBar rate={row.successRate} />}
      </div>

      {/* P95 */}
      <div className="relative text-ink-2 tabular-nums" style={{ textAlign: "right", fontSize: 12.5 }}>
        {stub ? <span className="text-ink-4">—</span> : fmtP95(row.p95Ms)}
      </div>

      {/* action — always-visible 上线/下线 */}
      <div className="relative flex items-center justify-end min-w-0 flex-nowrap overflow-hidden">
        {!stub && row.slug ? (
          <PauseToggleButton
            paused={row.paused}
            t={t}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (row.slug) onTogglePause(row.slug, !row.paused);
            }}
          />
        ) : (
          <span className="text-ink-4 tabular-nums" style={{ fontSize: 12 }}>{row.version}</span>
        )}
      </div>
    </div>
  );
}

function PauseToggleButton({ paused, onClick, t }: { paused: boolean; onClick: (e: React.MouseEvent) => void; t: (k: string) => string }) {
  // Always visible (matches the design reference) — outlined pill with an
  // icon. Resume (上线) glows green; pause (下线) is neutral.
  return (
    <button
      onClick={onClick}
      title={paused ? t("flx_bring_online_tip") : t("flx_take_offline_tip")}
      className="rounded-md transition-all hover:bg-surface inline-flex items-center gap-1 leading-none whitespace-nowrap shrink-0"
      style={{
        padding: "4px 10px",
        border: `1px solid ${paused ? "var(--c-ok)" : "var(--c-line)"}`,
        color: paused ? "var(--c-ok)" : "var(--c-ink-2)",
        fontSize: 11.5,
        lineHeight: 1.2,
      }}
    >
      {paused ? <Ic.play /> : <Ic.pause />}
      <span>{paused ? t("flx_bring_online") : t("flx_take_offline")}</span>
    </button>
  );
}

// Status pill — dot + label.
function StatusPill({ row, t }: { row: FleetRow; t: (k: string) => string }) {
  const { color, label } =
    row.status === "not_deployed" ? { color: "var(--c-err)",  label: t("flx_status_not_deployed") } :
    row.status === "paused"       ? { color: "var(--c-ink-4)", label: t("flx_status_paused") } :
                                    { color: "var(--c-ok)",   label: t("flx_status_deployed") };
  const online = row.status === "deployed";
  return (
    <span className="inline-flex items-center gap-2" style={{ fontSize: 12.5 }}>
      <span
        className={online ? "rounded-full anim-pulse" : "rounded-full"}
        style={{
          width: 7, height: 7, background: color,
          boxShadow: online ? `0 0 0 3px color-mix(in oklab, ${color} 18%, transparent)` : "none",
        }}
      />
      <span style={{ color: row.status === "deployed" ? "var(--c-ink-1)" : color }}>{label}</span>
    </span>
  );
}

// ── live indicator ───────────────────────────────────────────────

function LiveIndicator({ lastRefresh, t }: { lastRefresh: string | null; t: (k: string) => string }) {
  const live = !!lastRefresh;
  return (
    <span
      className="flex items-center gap-1.5 text-ink-3"
      title={live ? `${t("flx_data_from_inngest")} · ${t("flx_last_refresh")} ${lastRefresh}` : t("flx_connecting_inngest")}
      style={{ fontSize: 11.5 }}
    >
      <span
        className={live ? "rounded-full anim-pulse" : "rounded-full"}
        style={{
          width: 6, height: 6,
          background: live ? "var(--c-ok)" : "var(--c-ink-4)",
        }}
      />
      {live ? t("flx_live") : t("flx_connecting")}
    </span>
  );
}

// ── modal ─────────────────────────────────────────────────────────

function BehaviorPlaceholderModal({ onClose, t }: { onClose: () => void; t: (k: string) => string }) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center"
      style={{ background: "color-mix(in oklab, var(--c-ink-1) 35%, transparent)" }}
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg border border-line shadow-sh-3"
        style={{ padding: "24px 28px", maxWidth: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="m-0 text-ink-1" style={{ fontSize: 17, fontWeight: 500, letterSpacing: "-0.01em" }}>
          {t("f2_behavior_not_live_title")}
        </h2>
        <p className="text-ink-2 mt-3" style={{ fontSize: 13, lineHeight: 1.55 }}>
          {t("f2_behavior_not_live_body")}
        </p>
        <div className="flex justify-end mt-6">
          <Btn variant="primary" size="sm" onClick={onClose}>{t("flx_close")}</Btn>
        </div>
      </div>
    </div>
  );
}

// Phase 0 (2026-06-01) — empty-state card shown when the active domain has
// zero agents (user-created domain pre-Codegen). The "+ 部署智能体" button is
// the same placeholder as the page-header CTA; Behavior axis spec will swap
// the modal for the real deployment wizard.
function DomainEmptyStateCard({
  onDeploy,
  t,
}: {
  onDeploy: () => void;
  t: (k: string) => string;
}) {
  return (
    <div
      className="border border-line rounded-md text-center"
      style={{
        padding: "48px 24px",
        marginTop: 16,
        background: "var(--c-panel)",
      }}
    >
      <div className="text-ink-1" style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>
        {t("domain_empty_fleet")}
      </div>
      <div className="text-ink-3" style={{ fontSize: 12.5, marginBottom: 18, lineHeight: 1.55 }}>
        {t("domain_empty_fleet_hint")}
      </div>
      <Btn variant="primary" size="sm" onClick={onDeploy}>
        <Ic.plus /> {t("deploy_agent")}
      </Btn>
    </div>
  );
}
