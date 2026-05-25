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

function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffSec = Math.max(0, (Date.now() - t) / 1000);
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
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

const STAGE_ZH: Record<string, string> = {
  system: "系统",
  requirement: "需求",
  jd: "JD",
  resume: "简历",
  match: "匹配",
  interview: "面试",
  eval: "评估",
  package: "推荐包",
  submit: "提交",
};

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
    return { ...agentsRes, agents: agentsRes.agents.filter((a) => a.domain === domain) };
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
  // "实装" = currently online (registered AND not paused). Includes real + shell.
  // Moves up/down when user clicks 上线/下线.
  const liveCount = effectiveRows.filter((r) => r.realness !== "unbuilt" && !r.paused).length;
  const realRowsWithRuns = effectiveRows.filter((r) => r.realness === "real" && r.successRate != null);
  const aggSuccessRate = realRowsWithRuns.length
    ? realRowsWithRuns.reduce((sum, r) => sum + (r.successRate as number), 0) / realRowsWithRuns.length
    : null;
  const anomalies = effectiveRows.filter((r) => r.realness === "real" && isAnomalous(r)).length;
  const teams = new Set(effectiveRows.map((r) => r.ownerTeam)).size;

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
            <h1
              className="m-0 text-ink-1"
              style={{
                fontFamily: 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif',
                fontWeight: 500,
                fontSize: 26,
                letterSpacing: "-0.015em",
                lineHeight: 1.15,
              }}
            >
              {t("fleet_title")}
            </h1>
            <div className="text-ink-2 mt-1.5" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
              {t("fleet_sub")}
            </div>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <InngestPill />
            <LiveIndicator lastRefresh={lastRefresh} />
            {partial && (
              <span className="text-[11.5px] text-ink-3 flex items-center gap-1.5">
                <span className="rounded-full" style={{ width: 6, height: 6, background: "var(--c-warn)" }} />
                部分数据未到
              </span>
            )}
            <Btn variant="primary" size="sm" onClick={() => setBehaviorModal(true)}>
              <Ic.plus /> {t("deploy_agent")}
            </Btn>
          </div>
        </div>
      </div>

      {/* summary strip + period */}
      <div className="border-b border-line flex items-center gap-x-8 gap-y-3 flex-wrap" style={{ padding: "16px 32px" }}>
        <SummaryChip
          label={t("f2_kind_real")}
          value={`${liveCount}`}
          sub={`/ ${total}`}
          tone="ok"
          active={statusFilter === "live"}
          onClick={() => setStatusFilter(statusFilter === "live" ? "all" : "live")}
        />
        <SummaryChip
          label={t("f2_chip_success_7d")}
          value={aggSuccessRate == null ? "—" : `${aggSuccessRate.toFixed(1)}%`}
          tone={aggSuccessRate == null ? "muted" : aggSuccessRate >= 95 ? "ok" : aggSuccessRate >= 90 ? "warn" : "err"}
        />
        <SummaryChip
          label="需关注"
          value={String(anomalies)}
          tone={anomalies === 0 ? "muted" : "err"}
          active={statusFilter === "anomalies"}
          onClick={() => setStatusFilter(anomalies > 0 ? (statusFilter === "anomalies" ? "all" : "anomalies") : "all")}
        />
        <SummaryChip
          label={t("f2_chip_teams")}
          value={String(teams)}
          tone="muted"
        />
        <div className="flex-1" />
        <PeriodDropdown value={windowId} onChange={setWindow} t={t} />
      </div>

      {/* secondary toolbar — active-filter pill only.
          Grouping chooser removed per user request: not enough rows to
          justify 4 grouping modes; flat list reads cleaner. */}
      <div className="flex items-center gap-3 text-[12.5px]" style={{ padding: "10px 32px" }}>
        <div className="flex-1" />
        {statusFilter !== "all" && (
          <button
            onClick={() => setStatusFilter("all")}
            className="flex items-center gap-1.5 text-ink-2 hover:text-ink-1 rounded border border-line bg-surface"
            style={{ padding: "3px 9px", fontSize: 12 }}
          >
            <span className="text-ink-3">筛选:</span>
            <span className="font-medium">{filterLabel(statusFilter, t)}</span>
            <span className="text-ink-3 ml-1">×</span>
          </button>
        )}
        <FilterMenu value={statusFilter} onChange={setStatusFilter} t={t} />
      </div>

      {/* list */}
      <div className="flex-1 min-h-0" style={{ padding: "4px 32px 48px" }}>
        {agentsRes === null && (
          <div className="text-ink-3 text-[13px] text-center py-16">加载中…</div>
        )}
        {agentsRes !== null && grouped.length > 0 && (
          <div
            className="grid gap-4 text-ink-3 border-b border-line"
            style={{ gridTemplateColumns: GRID, padding: "8px 12px", fontSize: 11.5 }}
          >
            <span>智能体</span>
            <span>部署状态</span>
            <span>近期运行</span>
            <span style={{ textAlign: "right" }}>最近活动</span>
            <span style={{ textAlign: "right" }}>版本</span>
          </div>
        )}
        {agentsRes !== null && grouped.map((g) => (
          <section key={g.key}>
            {group !== "flat" && <GroupHeader title={groupTitle(g.title, group, t)} rows={g.rows} />}
            {g.rows.map((r) => (
              <AgentListRow key={r.short} row={r} t={t} onTogglePause={togglePause} />
            ))}
          </section>
        ))}
        {agentsRes !== null && grouped.length === 0 && (
          <div className="text-ink-3 text-[13px] text-center py-16">
            没有匹配当前筛选的智能体。
          </div>
        )}
        {agentsRes !== null && filtered.length > 0 && (
          <div className="flex items-center gap-2 text-[12px] text-ink-3 mt-6">
            <span>显示 {filtered.length} / {total}</span>
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

function filterLabel(f: FilterId, t: (k: string) => string): string {
  switch (f) {
    case "all": return t("f2_filter_all");
    case "live": return t("f2_kind_real");
    case "blueprint": return t("f2_kind_stub");
    case "anomalies": return t("f2_filter_anomalies");
    case "paused": return t("f2_filter_paused");
    case "deprecated": return t("f2_filter_deprecated");
  }
}

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

function groupTitle(title: string, group: string, _t: (k: string) => string): string {
  if (group === "stage") return STAGE_ZH[title] ?? title;
  return title;
}

// ── chips ──────────────────────────────────────────────────────────

function SummaryChip({
  label, value, sub, tone, active, onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "warn" | "err" | "muted";
  active?: boolean;
  onClick?: () => void;
}) {
  const color =
    tone === "ok" ? "var(--c-ok)" :
    tone === "warn" ? "oklch(0.5 0.14 75)" :
    tone === "err" ? "var(--c-err)" :
    tone === "muted" ? "var(--c-ink-2)" :
    "var(--c-ink-1)";
  const Tag: React.ElementType = onClick ? "button" : "div";
  return (
    <Tag
      className={"flex items-baseline gap-2 transition-opacity " + (onClick ? "cursor-pointer hover:opacity-75" : "")}
      onClick={onClick}
      style={{
        borderBottom: active ? "1.5px solid var(--c-ink-1)" : "1.5px solid transparent",
        paddingBottom: 2,
      }}
    >
      <span className="text-ink-3" style={{ fontSize: 12 }}>{label}</span>
      <span className="font-semibold tabular-nums" style={{ fontSize: 18, color, letterSpacing: "-0.015em" }}>{value}</span>
      {sub && <span className="text-ink-3 tabular-nums" style={{ fontSize: 12 }}>{sub}</span>}
    </Tag>
  );
}

// ── segmented links (quieter than SegGroup) ───────────────────────

function SegLinks({
  options, value, onChange,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map((o) => (
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
        <span className="text-ink-3">区间</span>
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

// ── filter menu (popover with all 6 filters) ──────────────────────

function FilterMenu({ value, onChange, t }: { value: FilterId; onChange: (v: FilterId) => void; t: (k: string) => string }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const options: { id: FilterId; label: string }[] = [
    { id: "all",        label: t("f2_filter_all") },
    { id: "live",       label: t("f2_kind_real") },
    { id: "blueprint",  label: t("f2_kind_stub") },
    { id: "anomalies",  label: t("f2_filter_anomalies") },
    { id: "paused",     label: t("f2_filter_paused") },
    { id: "deprecated", label: t("f2_filter_deprecated") },
  ];
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-ink-2 hover:text-ink-1 transition-colors"
        style={{ fontSize: 12.5 }}
      >
        <Ic.search style={{ width: 12, height: 12 }} />
        <span>筛选</span>
        <Ic.chevD style={{ width: 10, height: 10 }} />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 bg-surface border border-line rounded-md shadow-sh-2 z-30" style={{ minWidth: 160 }}>
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => { onChange(o.id); setOpen(false); }}
              className="w-full text-left hover:bg-panel transition-colors flex items-center justify-between"
              style={{ padding: "8px 12px", fontSize: 12.5, color: value === o.id ? "var(--c-ink-1)" : "var(--c-ink-2)" }}
            >
              {o.label}
              {value === o.id && <Ic.check style={{ width: 12, height: 12 }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── list ──────────────────────────────────────────────────────────

// Last column (button + version) widened from 70px → 150px to fit the
// always-visible "上线"/"下线" button (was icon-only on hover before).
const GRID = "minmax(280px, 1fr) 120px 140px 100px 150px";

function GroupHeader({ title, rows }: { title: string; rows: FleetRow[] }) {
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
        {deployed > 0 && <><span style={{ color: "var(--c-ok)" }}>{deployed}</span> 已上线</>}
        {paused > 0 && <>{deployed > 0 && " · "}{paused} 已暂停</>}
        {notDeployed > 0 && <>{(deployed > 0 || paused > 0) && " · "}<span style={{ color: "var(--c-err)" }}>{notDeployed}</span> 未上线</>}
        {anomalous > 0 && <> · <span style={{ color: "var(--c-err)" }}>{anomalous} 需关注</span></>}
      </span>
    </div>
  );
}

function AgentListRow({ row, t, onTogglePause }: { row: FleetRow; t: (k: string) => string; onTogglePause: (slug: string, paused: boolean) => void }) {
  const stub = row.realness === "unbuilt";
  const dim = row.lifecycle === "deprecated";
  return (
    <div
      className="group relative grid gap-4 border-b border-line transition-colors hover:bg-panel"
      style={{
        gridTemplateColumns: GRID,
        padding: stub ? "8px 12px" : "16px 12px",
        opacity: dim ? 0.55 : 1,
        alignItems: "center",
      }}
    >
      {/* the row itself is a link; the action button is a sibling that
          captures clicks before the Link does */}
      <Link
        href={`/fleet/${row.short}`}
        className="absolute inset-0"
        style={{ textDecoration: "none" }}
        aria-label={`open ${row.name}`}
      />

      {/* identity */}
      <div className="relative flex items-baseline gap-2.5 min-w-0">
        <RowStatusDot status={row.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 min-w-0">
            <span
              className="truncate text-ink-1"
              style={{
                fontSize: stub ? 13 : 14,
                fontWeight: stub ? 400 : 500,
                letterSpacing: "-0.005em",
                textDecoration: row.lifecycle === "deprecated" ? "line-through" : "none",
              }}
            >
              {row.name}
            </span>
          </div>
          <div className="truncate text-ink-3" style={{ fontSize: 12, marginTop: stub ? 0 : 2 }}>
            {t(row.roleK)} · {row.ownerTeam}
          </div>
        </div>
      </div>

      {/* status */}
      <div className="relative">
        <StatusCell status={row.status} t={t} />
      </div>

      {/* runs: total + breakdown (real data) */}
      <div className="relative">
        {stub ? <span /> : <RunsCell row={row} />}
      </div>

      {/* last active */}
      <div className="relative text-ink-3 tabular-nums" style={{ textAlign: "right", fontSize: 12 }}>
        {stub ? "" : relTime(row.lastActiveAt)}
      </div>

      {/* version + hover action — fixed column width (see GRID const).
          flex-nowrap + min-w-0 + whitespace-nowrap on button keeps the
          "上线"/"下线" pill from overflowing into the 最近活动 column. */}
      <div className="relative text-ink-3 tabular-nums flex items-center justify-end gap-2 min-w-0 flex-nowrap overflow-hidden" style={{ fontSize: 12 }}>
        {!stub && row.slug && (
          <PauseToggleButton
            paused={row.paused}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (row.slug) onTogglePause(row.slug, !row.paused);
            }}
          />
        )}
        <span>{stub ? "" : row.version}</span>
      </div>
    </div>
  );
}

function PauseToggleButton({ paused, onClick }: { paused: boolean; onClick: (e: React.MouseEvent) => void }) {
  // Paused agents: button always visible (resume is the affordance the user
  // is looking for). Running agents: button hover-only to keep the row calm.
  const visibility = paused ? "opacity-100" : "opacity-0 group-hover:opacity-100";
  return (
    <button
      onClick={onClick}
      title={paused ? "上线 (恢复运行)" : "下线 (暂停)"}
      className={`${visibility} rounded transition-all hover:bg-surface inline-flex items-center gap-1 leading-none whitespace-nowrap shrink-0`}
      style={{
        padding: "2px 6px",
        border: `1px solid ${paused ? "var(--c-ok)" : "var(--c-line)"}`,
        color: paused ? "var(--c-ok)" : "var(--c-ink-2)",
        fontSize: 11,
        lineHeight: 1.2,
      }}
    >
      {paused ? <Ic.play /> : <Ic.pause />}
      <span>{paused ? "上线" : "下线"}</span>
    </button>
  );
}

function RunsCell({ row }: { row: FleetRow }) {
  const total = row.liveTotal;
  if (total == null) return <span className="text-ink-4" style={{ fontSize: 13 }}>—</span>;
  if (total === 0) {
    return <span className="text-ink-4" style={{ fontSize: 13 }}>无运行</span>;
  }
  const succ = row.liveCompleted ?? 0;
  const fail = row.liveFailed ?? 0;
  return (
    <div className="flex items-baseline gap-2 tabular-nums">
      <span className="text-ink-1" style={{ fontSize: 13 }}>{total}</span>
      <span className="text-ink-3" style={{ fontSize: 11.5 }}>
        <span style={{ color: "var(--c-ok)" }}>✓{succ}</span>
        {fail > 0 && <> · <span style={{ color: "var(--c-err)" }}>✗{fail}</span></>}
      </span>
    </div>
  );
}

function RowStatusDot({ status }: { status: FleetStatus }) {
  const color =
    status === "deployed"     ? "var(--c-ok)" :
    status === "paused"       ? "var(--c-ink-4)" :
    status === "not_deployed" ? "var(--c-err)" :
    "var(--c-ink-4)";
  return (
    <span
      className="rounded-full shrink-0"
      style={{
        width: 7, height: 7, background: color,
        marginTop: 4,
        boxShadow: status === "deployed" ? `0 0 0 3px color-mix(in oklab, ${color} 18%, transparent)` : "none",
      }}
    />
  );
}

function StatusCell({ status }: { status: FleetStatus; t: (k: string) => string }) {
  const label =
    status === "deployed"     ? "已上线" :
    status === "paused"       ? "已暂停" :
    status === "not_deployed" ? "未上线" :
    "";
  const color =
    status === "not_deployed" ? "var(--c-err)" :
    status === "paused"       ? "var(--c-ink-3)" :
    "var(--c-ink-1)";
  return (
    <span style={{ fontSize: 13, color }}>{label}</span>
  );
}

// ── live indicator ───────────────────────────────────────────────

function LiveIndicator({ lastRefresh }: { lastRefresh: string | null }) {
  const live = !!lastRefresh;
  return (
    <span
      className="flex items-center gap-1.5 text-ink-3"
      title={live ? `数据来自 Inngest · 最后刷新 ${lastRefresh}` : "正在连接 Inngest…"}
      style={{ fontSize: 11.5 }}
    >
      <span
        className={live ? "rounded-full anim-pulse" : "rounded-full"}
        style={{
          width: 6, height: 6,
          background: live ? "var(--c-ok)" : "var(--c-ink-4)",
        }}
      />
      {live ? "实时" : "连接中"}
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
          <Btn variant="primary" size="sm" onClick={onClose}>关闭</Btn>
        </div>
      </div>
    </div>
  );
}
