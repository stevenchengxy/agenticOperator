"use client";
import React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { AgentsResponse, AgentRow } from "@/lib/api/types";
import { isReal } from "@/lib/agent-mapping";
import { useInngestLiveOverlay, WSID_TO_INNGEST_SLUG, type LiveAgentState } from "@/lib/api/inngest-live-overlay";

// Fleet IA v2.1 — agent detail page (`/fleet/[short]`).
// Matches the Claude-style tightening applied to FleetContent: serif h1,
// no uppercase pills, no glyph blocks, quiet typography. Only the Overview
// tab is fleshed out; tabs 2-7 render an EmptyState (see spec §5.3).

type Lifecycle = "active" | "paused" | "deprecated" | "draft";
type Realness = "real" | "stub";

type DetailRow = {
  short: string;
  wsId: string;
  displayName: string;
  ownerTeam: string;
  stage: AgentRow["stage"];
  version: string;
  lifecycle: Lifecycle;
  realness: Realness;
  slug: string | null;
  // Live data from Inngest (real agents only — null for stubs)
  paused: boolean;
  liveTotal: number | null;
  liveCompleted: number | null;
  liveFailed: number | null;
  liveRunning: number | null;
  successRate: number | null;
  latestStartedAt: string | null;
  latestStatus: LiveAgentState["latestStatus"];
  latestDurationMs: number | null;
};

const TAB_DEFS = [
  { id: "overview", labelK: "ad_tab_overview" },
  { id: "versions", labelK: "ad_tab_versions" },
  { id: "runs", labelK: "ad_tab_runs" },
  { id: "alerts", labelK: "ad_tab_alerts" },
  { id: "events", labelK: "ad_tab_events" },
  { id: "perm", labelK: "ad_tab_perm" },
  { id: "audit", labelK: "ad_tab_audit" },
] as const;
type TabId = typeof TAB_DEFS[number]["id"];

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

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

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

// ────────────────────────────────────────────────────────────────────

export function AgentDetailContent({ short }: { short: string }) {
  const { t } = useApp();
  const router = useRouter();
  const sp = useSearchParams();
  const tab = (sp.get("tab") ?? "overview") as TabId;

  const [agentRow, setAgentRow] = React.useState<AgentRow | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const { byWsId: liveByWsId, lastRefresh } = useInngestLiveOverlay();

  React.useEffect(() => {
    fetchJson<AgentsResponse>("/api/agents")
      .then((res) => {
        const found = res.agents.find((a) => a.short === short);
        if (!found) {
          setNotFound(true);
          return;
        }
        setAgentRow(found);
      })
      .catch(() => setNotFound(true));
  }, [short]);

  // Local optimistic pause toggle so the button reflects state immediately.
  const [optimisticPause, setOptimisticPause] = React.useState<boolean | null>(null);

  const real = agentRow ? isReal(agentRow.short) : false;
  const wsId = agentRow?.wsId ?? "";
  const slug = real ? WSID_TO_INNGEST_SLUG[wsId] ?? null : null;
  const live: LiveAgentState | undefined = real ? liveByWsId.get(wsId) : undefined;
  const livePaused = live?.paused ?? false;
  const effectivePaused = optimisticPause ?? livePaused;

  const agent: DetailRow | null = agentRow ? {
    short: agentRow.short,
    wsId: agentRow.wsId,
    displayName: agentRow.displayName,
    ownerTeam: agentRow.ownerTeam,
    stage: agentRow.stage,
    version: agentRow.version,
    lifecycle: !real ? "draft" : effectivePaused ? "paused" : "active",
    realness: real ? "real" : "stub",
    slug,
    paused: effectivePaused,
    liveTotal: live?.total ?? null,
    liveCompleted: live?.completed ?? null,
    liveFailed: live?.failed ?? null,
    liveRunning: live?.running ?? null,
    successRate: live?.successRate ?? null,
    latestStartedAt: live?.latestStartedAt ?? null,
    latestStatus: live?.latestStatus ?? null,
    latestDurationMs: live?.latestDurationMs ?? null,
  } : null;

  const togglePause = React.useCallback(async () => {
    if (!slug) return;
    const next = !effectivePaused;
    setOptimisticPause(next);
    try {
      await fetch(`/api/inngest-admin/functions/${encodeURIComponent(slug)}/toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: next }),
      });
    } catch {
      setOptimisticPause(null);
    }
  }, [slug, effectivePaused]);

  const setTab = (next: TabId) => {
    const params = new URLSearchParams(sp.toString());
    if (next === "overview") params.delete("tab");
    else params.set("tab", next);
    router.replace(`/fleet/${short}${params.toString() ? `?${params.toString()}` : ""}`);
  };

  if (notFound) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-16">
        <EmptyState
          title="找不到这个智能体"
          hint={`Short code "${short}" 不在当前舰队列表里。`}
          action={
            <Link href="/fleet">
              <Btn size="sm" variant="primary">返回舰队</Btn>
            </Link>
          }
        />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center p-16 text-ink-3 text-[13px]">
        加载中…
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-auto bg-bg">
      <DetailHeader agent={agent} t={t} onTogglePause={togglePause} lastRefresh={lastRefresh} />
      <TabBar tab={tab} setTab={setTab} t={t} />
      <div className="flex-1 min-h-0" style={{ padding: "24px 32px 48px" }}>
        {tab === "overview" && <OverviewTab agent={agent} t={t} />}
        {tab !== "overview" && <StubTab tabId={tab} t={t} />}
      </div>
    </div>
  );
}

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
        style={{ width: 6, height: 6, background: live ? "var(--c-ok)" : "var(--c-ink-4)" }}
      />
      {live ? "实时" : "连接中"}
    </span>
  );
}

// ── header band ──────────────────────────────────────────────────────

function DetailHeader({ agent, t, onTogglePause, lastRefresh }: { agent: DetailRow; t: (k: string) => string; onTogglePause: () => void; lastRefresh: string | null }) {
  const stub = agent.realness === "stub";
  return (
    <div className="border-b border-line" style={{ padding: "24px 32px 22px" }}>
      <div className="flex items-start gap-4">
        <Link
          href="/fleet"
          className="text-ink-3 hover:text-ink-1 inline-block"
          style={{ transform: "scaleX(-1)", marginTop: 8 }}
        >
          <Ic.chev />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1
              className="m-0 text-ink-1"
              style={{
                fontFamily: SERIF,
                fontWeight: 500,
                fontSize: 26,
                letterSpacing: "-0.015em",
                lineHeight: 1.15,
              }}
            >
              {agent.short}
            </h1>
            <RealnessTag realness={agent.realness} paused={agent.paused} t={t} />
          </div>
          <div className="text-ink-2 mt-1.5" style={{ fontSize: 13.5 }}>{t(agent.displayName)}</div>
          <div className="mt-3 flex items-center gap-x-5 gap-y-1 flex-wrap text-ink-3" style={{ fontSize: 12.5 }}>
            <MetaItem label={t("ad_meta_owner")} value={agent.ownerTeam} />
            <MetaItem label="阶段" value={STAGE_ZH[agent.stage] ?? agent.stage} />
            <MetaItem label={t("ad_meta_version")} value={agent.version} />
            {!stub && agent.latestStartedAt && (
              <MetaItem label="最近活动" value={relTime(agent.latestStartedAt)} />
            )}
          </div>
          {stub && (
            <div
              className="mt-4 text-ink-2 leading-relaxed"
              style={{
                fontSize: 13,
                padding: "10px 14px",
                background: "var(--c-panel)",
                border: "1px solid var(--c-line)",
                borderRadius: 8,
              }}
            >
              这个 agent 尚未上线——工作流蓝图里有占位,但还没注册为 Inngest function。所以没有运行历史 · 告警 · 审计等数据。
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0 mt-2">
          {!stub && <LiveIndicator lastRefresh={lastRefresh} />}
          {!stub && agent.slug && (
            <PauseResumeButton paused={agent.paused} onClick={onTogglePause} />
          )}
          <ManageMenu t={t} stub={stub} />
        </div>
      </div>
    </div>
  );
}

function PauseResumeButton({ paused, onClick }: { paused: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded border transition-colors"
      style={{
        padding: "6px 12px",
        fontSize: 13,
        background: paused ? "var(--c-ok-bg)" : "var(--c-surface)",
        borderColor: paused ? "color-mix(in oklab, var(--c-ok) 25%, transparent)" : "var(--c-line)",
        color: paused ? "var(--c-ok)" : "var(--c-ink-1)",
        fontWeight: 500,
      }}
    >
      {paused ? <Ic.play /> : <Ic.pause />}
      {paused ? "恢复运行" : "暂停"}
    </button>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-ink-4">{label}</span>{" "}
      <span className="text-ink-2">{value}</span>
    </span>
  );
}

function RealnessTag({ realness, paused, t }: { realness: Realness; paused?: boolean; t: (k: string) => string }) {
  if (realness === "real") {
    if (paused) {
      return (
        <span className="inline-flex items-center gap-1.5 text-ink-3" style={{ fontSize: 12 }}>
          <span className="rounded-full" style={{ width: 6, height: 6, background: "var(--c-ink-4)" }} />
          已暂停
        </span>
      );
    }
    return (
      <span
        className="inline-flex items-center gap-1.5"
        title={t("f2_kind_real_tip")}
        style={{ fontSize: 12, color: "var(--c-ok)" }}
      >
        <span
          className="rounded-full anim-pulse"
          style={{ width: 6, height: 6, background: "var(--c-ok)" }}
        />
        已上线
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={t("f2_kind_stub_tip")}
      style={{ fontSize: 12, color: "var(--c-err)" }}
    >
      <span className="rounded-full" style={{ width: 6, height: 6, background: "var(--c-err)" }} />
      未上线
    </span>
  );
}

// Manage actions live in a popover, not a row of disabled buttons.
// They're future Manage-module operations — we keep the surface area visible
// but quiet, so the page doesn't shout "look at all these greyed buttons!".
function ManageMenu({ t, stub }: { t: (k: string) => string; stub: boolean }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const tip = stub ? "蓝图 agent 没有可治理的运行实例" : t("f2_manage_disabled_tooltip");
  // Pause/Resume is now its own primary action (see PauseResumeButton).
  // The dropdown holds the remaining Manage actions that aren't wired yet.
  const items: [string, React.ReactNode][] = [
    [t("ad_action_rollback"), null],
    [t("ad_action_reassign"), null],
    [t("ad_action_deprecate"), null],
  ];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-ink-2 hover:text-ink-1 rounded border border-line bg-surface transition-colors"
        style={{ padding: "5px 10px", fontSize: 12.5 }}
      >
        治理 <Ic.chevD style={{ width: 10, height: 10 }} />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 bg-surface border border-line rounded-md shadow-sh-2 z-30" style={{ minWidth: 180 }}>
          <div className="text-ink-4 border-b border-line" style={{ padding: "8px 12px", fontSize: 11 }}>
            {tip}
          </div>
          {items.map(([label, icon]) => (
            <button
              key={label}
              disabled
              className="w-full text-left flex items-center gap-2 cursor-not-allowed"
              style={{ padding: "8px 12px", fontSize: 12.5, color: "var(--c-ink-4)" }}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── tab bar ──────────────────────────────────────────────────────────

function TabBar({ tab, setTab, t }: { tab: TabId; setTab: (t: TabId) => void; t: (k: string) => string }) {
  return (
    <div className="border-b border-line" style={{ paddingInline: 32 }}>
      <div className="flex items-center gap-x-1">
        {TAB_DEFS.map((td) => (
          <button
            key={td.id}
            onClick={() => setTab(td.id)}
            className="transition-colors"
            style={{
              padding: "12px 14px",
              borderBottom: tab === td.id ? "1.5px solid var(--c-ink-1)" : "1.5px solid transparent",
              color: tab === td.id ? "var(--c-ink-1)" : "var(--c-ink-3)",
              fontWeight: tab === td.id ? 500 : 400,
              fontSize: 13,
              marginBottom: -1,
            }}
          >
            {t(td.labelK)}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── overview tab ────────────────────────────────────────────────────

function OverviewTab({ agent, t }: { agent: DetailRow; t: (k: string) => string }) {
  const stub = agent.realness === "stub";
  return (
    <div className="grid gap-8" style={{ gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr)" }}>
      <div className="flex flex-col gap-7">
        <Health30dSection agent={agent} stub={stub} t={t} />
        {!stub && <MonitorLinkSection agent={agent} />}
      </div>
      <div className="flex flex-col gap-7">
        <IdentitySection agent={agent} t={t} />
        <WorkflowPositionSection agent={agent} t={t} />
      </div>
    </div>
  );
}

// Light "→ go look at this agent's runs in Monitor" section.
// Replaces the in-Fleet RecentRunsSection per the 2026-05-19 IA carve-up:
// run-level data is owned by /monitor, Fleet just links over.
function MonitorLinkSection({ agent }: { agent: DetailRow }) {
  const total = agent.liveTotal ?? 0;
  const succ = agent.liveCompleted ?? 0;
  const fail = agent.liveFailed ?? 0;
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 500, letterSpacing: "-0.01em" }}>
          运行记录
        </h2>
      </div>
      <Link
        href={`/monitor?agent=${encodeURIComponent(agent.short)}`}
        className="block border border-line rounded-lg hover:bg-panel transition-colors"
        style={{ padding: "16px 18px", textDecoration: "none" }}
      >
        <div className="flex items-baseline justify-between">
          <div>
            <div className="flex items-baseline gap-3 tabular-nums">
              <span className="text-ink-1" style={{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.015em" }}>
                {total}
              </span>
              <span className="text-ink-3" style={{ fontSize: 13 }}>
                <span style={{ color: "var(--c-ok)" }}>✓{succ}</span>
                {fail > 0 && <> · <span style={{ color: "var(--c-err)" }}>✗{fail}</span></>}
              </span>
            </div>
            <div className="text-ink-3 mt-1" style={{ fontSize: 12 }}>
              近期运行 · 失败详情 / trace 时间轴 / step output 等在 Monitor 查看
            </div>
          </div>
          <span className="text-ink-2" style={{ fontSize: 12.5 }}>查看 →</span>
        </div>
      </Link>
    </section>
  );
}

function SectionHead({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-3">
      <div className="flex items-baseline gap-2.5">
        <h2 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 500, letterSpacing: "-0.01em" }}>
          {title}
        </h2>
        {hint && <span className="text-ink-3" style={{ fontSize: 12 }}>{hint}</span>}
      </div>
      {action}
    </div>
  );
}

function Health30dSection({ agent, stub, t }: { agent: DetailRow; stub: boolean; t: (k: string) => string }) {
  const rate = agent.successRate;
  const pct = rate != null ? `${rate.toFixed(1)}%` : "—";
  const pctColor =
    rate == null ? "var(--c-ink-3)" :
    rate >= 95 ? "var(--c-ink-1)" :
    rate >= 90 ? "oklch(0.5 0.14 75)" :
    "var(--c-err)";

  return (
    <section>
      <SectionHead
        title="运行概览"
        hint={stub ? "蓝图 agent 无运行数据" : "实时 · 来自 Inngest"}
      />
      <div className="grid grid-cols-4 gap-x-6 gap-y-1">
        <Stat
          label="总运行"
          value={agent.liveTotal != null ? String(agent.liveTotal) : "—"}
        />
        <Stat
          label="成功"
          value={agent.liveCompleted != null ? String(agent.liveCompleted) : "—"}
          valueColor={agent.liveCompleted ? "var(--c-ok)" : undefined}
        />
        <Stat
          label="失败"
          value={agent.liveFailed != null ? String(agent.liveFailed) : "—"}
          valueColor={(agent.liveFailed ?? 0) > 0 ? "var(--c-err)" : undefined}
        />
        <Stat
          label="成功率"
          value={pct}
          valueColor={pctColor}
        />
      </div>
      {!stub && (agent.liveRunning ?? 0) > 0 && (
        <div className="mt-4 flex items-center gap-2 text-ink-2" style={{ fontSize: 12.5 }}>
          <span className="rounded-full anim-pulse" style={{ width: 6, height: 6, background: "var(--c-ok)" }} />
          当前有 {agent.liveRunning} 个运行进行中
        </div>
      )}
      {!stub && agent.latestStartedAt && (
        <div className="mt-2 text-ink-3" style={{ fontSize: 12 }}>
          最近一次运行 {relTime(agent.latestStartedAt)}
          {agent.latestStatus && <> · 结果 {agent.latestStatus}</>}
          {agent.latestDurationMs != null && <> · 耗时 {Math.round(agent.latestDurationMs / 100) / 10}s</>}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, valueColor, sub }: { label: string; value: string; valueColor?: string; sub?: React.ReactNode }) {
  return (
    <div>
      <div className="text-ink-3" style={{ fontSize: 12 }}>{label}</div>
      <div className="flex items-baseline gap-2 mt-1">
        <span
          className="tabular-nums"
          style={{
            fontFamily: SERIF,
            fontSize: 26,
            fontWeight: 500,
            letterSpacing: "-0.015em",
            color: valueColor ?? "var(--c-ink-1)",
            lineHeight: 1.1,
          }}
        >
          {value}
        </span>
        {sub}
      </div>
    </div>
  );
}

function IdentitySection({ agent, t }: { agent: DetailRow; t: (k: string) => string }) {
  const rows: Array<[string, React.ReactNode]> = [
    ["Short", <span key="s" className="tabular-nums">{agent.short}</span>],
    ["Display", t(agent.displayName)],
    ["部署状态", <RealnessTag key="r" realness={agent.realness} paused={agent.paused} t={t} />],
    ["Owner team", agent.ownerTeam],
    ["Version", <span key="v" className="tabular-nums">{agent.version}</span>],
    ["Stage", STAGE_ZH[agent.stage] ?? agent.stage],
    ...(agent.slug ? [["Inngest slug", <span key="sl" className="tabular-nums text-ink-3" style={{ fontSize: 11.5 }}>{agent.slug}</span>] as [string, React.ReactNode]] : []),
  ];
  return (
    <section>
      <SectionHead title={t("ad_card_identity")} />
      <div className="border-t border-line">
        {rows.map(([label, val]) => (
          <div
            key={label}
            className="grid items-center border-b border-line"
            style={{ gridTemplateColumns: "112px 1fr", padding: "8px 4px", fontSize: 12.5 }}
          >
            <span className="text-ink-3">{label}</span>
            <span className="text-ink-1">{val}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkflowPositionSection({ agent, t }: { agent: DetailRow; t: (k: string) => string }) {
  return (
    <section>
      <SectionHead
        title={t("ad_card_workflow_position")}
        action={
          <Link href={`/workflow?node=${encodeURIComponent(agent.short)}`} className="text-ink-3 hover:text-ink-1" style={{ fontSize: 12 }}>
            在工作流图中查看 →
          </Link>
        }
      />
      <div className="text-ink-2 leading-relaxed" style={{ fontSize: 12.5 }}>
        参与阶段 <span className="text-ink-1">{STAGE_ZH[agent.stage] ?? agent.stage}</span>，
        归属团队 <span className="text-ink-1">{agent.ownerTeam}</span>。
        <div className="text-ink-3 mt-2" style={{ fontSize: 12 }}>
          完整上下游关系待 Workflow API 接通后实装。
        </div>
      </div>
    </section>
  );
}

// Data sources / Permissions sections were removed from the Overview because
// they rendered hardcoded mock inventories (RAAS / Neo4j / OpenAI scopes that
// weren't actually queried). When a real permissions inventory becomes
// available, restore them under their own spec.

// ── stub tab ─────────────────────────────────────────────────────

function StubTab({ tabId, t }: { tabId: TabId; t: (k: string) => string }) {
  const tabDef = TAB_DEFS.find((td) => td.id === tabId)!;
  return (
    <EmptyState
      icon={<Ic.workflow />}
      title={t(tabDef.labelK)}
      hint={t("ad_stub_tab")}
      variant="info"
    />
  );
}
