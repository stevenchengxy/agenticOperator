"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Ic, IcName } from "@/components/shared/Ic";
import { Badge, Btn } from "@/components/shared/atoms";
import { AgenticToggle } from "@/components/shared/AgenticToggle";
import { WORKFLOW_META } from "@/lib/workflow-meta";
import { fetchJson } from "@/lib/api/client";
import { byShortFunction } from "@/lib/agent-functions";
import { displayName as agentDisplayName } from "@/lib/agent-mapping";
import type { ExplainResponse } from "@/app/api/agents/[short]/explain/route";
import { LogStream } from "@/components/shared/LogStream";
import { useAgentsHealth } from "@/lib/api/agents-health";
import type { AgentHealth, AgentHealthStatus } from "@/app/api/agents/health/route";
import { NeighborhoodPanel } from "./NeighborhoodPanel";
import { RecentEntitiesPanel } from "./RecentEntitiesPanel";
import { AgentChatbot } from "./AgentChatbot";
import { NODES, EDGES, GRAPH_VIEWBOX, GRAPH_WIDTH, GRAPH_HEIGHT, CANONICAL_WORKFLOW, type WorkflowNode } from "@/lib/workflow-graph-meta";
import { useInngestLiveOverlay, WSID_TO_INNGEST_SLUG, type LiveAgentState } from "@/lib/api/inngest-live-overlay";
import { LiveAgentPanel } from "./LiveAgentPanel";
import Link from "next/link";

export function WorkflowContent() {
  const { t } = useApp();
  const [selectedId, setSelectedId] = React.useState("jd");

  const nodes = NODES;
  const edges = EDGES;

  const sel = nodes.find((n) => n.id === selectedId) || nodes[0];

  // Resolve a canonical agent short → the matching NodeDef on the canvas.
  // Used by NeighborhoodPanel to jump selection without scrolling.
  const jumpToAgent = React.useCallback(
    (short: string) => {
      const target = nodes.find((n) => nodeAgentShort(n) === short);
      if (target) setSelectedId(target.id);
    },
    // `nodes` is a stable literal in this component body — refs only on `t`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Real-time health from /api/agents/health (5-min window).
  // Replaces the legacy /api/workflow/active poll AND the hardcoded
  // status field on each NodeDef.
  const health = useAgentsHealth(4_000);

  // ★ v0_1_010: Inngest live overlay — for the 3 real PRA agents only.
  // wsId "4" (JDGenerator) / "9-1" (ResumeParser) / "10" (Matcher) become "live".
  // All other nodes are static blueprints (stub agents, not deployed).
  const liveOverlay = useInngestLiveOverlay();

  // Aggregate counts for the sub-header summary. `nodes` is a stable
  // literal in this component body — the only thing that changes between
  // renders is `health.byShort`, so memo against that.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const summary = React.useMemo(() => {
    const out = { running: 0, healthy: 0, degraded: 0, failed: 0, idle: 0 };
    for (const n of nodes) {
      if (n.kind !== "agent") continue;
      const short = nodeAgentShort(n);
      if (!short) continue;
      const h = health.byShort.get(short);
      if (!h) {
        out.idle += 1;
        continue;
      }
      out[h.status] += 1;
    }
    return out;
  }, [health.byShort]);

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* sub-header */}
      <div className="flex items-center gap-4 border-b border-line bg-surface" style={{ padding: "14px 22px" }}>
        <div className="flex-1">
          <div className="text-[15px] font-semibold tracking-tight">{t("wf_title")}</div>
          <div className="text-ink-3 text-[12px] mt-px">{t("wf_sub")}</div>
        </div>
        <HeaderHealthSummary summary={summary} />
        <Badge variant="info">{WORKFLOW_META.version} · {WORKFLOW_META.status}</Badge>
        <div className="w-px h-5 bg-line" />
        <Link
          href="/monitor"
          className="text-[12px] text-accent hover:underline flex items-center gap-1"
          title="切到运行监控 dashboard 看 agent 实时状态 / runs / DLQ"
        >
          <Ic.pulse /> 实时监控
        </Link>
        <div className="text-[11px] text-ink-3 mono">
          <span className="text-ok font-semibold">{liveOverlay.byWsId.size}</span> 已注册 ·{" "}
          <span className="text-ink-4">{nodes.filter(n => n.kind === "agent").length - liveOverlay.byWsId.size}</span> 蓝图
        </div>
        <div className="w-px h-5 bg-line" />
        <AgenticToggle />
        <div className="w-px h-5 bg-line" />
        <Btn size="sm"><Ic.clock /> 版本历史</Btn>
        <Btn size="sm"><Ic.play /> 试运行</Btn>
        <Btn variant="primary" size="sm">发布</Btn>
      </div>

      {/* work area */}
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "200px 1fr 300px" }}>
        {/* palette */}
        <aside className="border-r border-line bg-surface overflow-auto">
          <PaletteSection title="触发 · TRIGGERS" items={[
            { icon: "bolt", label: "客户 RMS 同步 / SCHEDULED_SYNC" },
            { icon: "plug", label: "渠道 Webhook (新简历)" },
            { icon: "calendar", label: "定时重扫" },
            { icon: "mail", label: "HSM 手动发起" },
          ]} />
          <PaletteSection title="智能体 · AGENTS" items={[
            { icon: "db", label: "ReqSync" },
            { icon: "sparkle", label: "ReqAnalyzer" },
            { icon: "sparkle", label: agentDisplayName("JDGenerator") },
            { icon: "plug", label: "Publisher" },
            { icon: "db", label: "ResumeCollector" },
            { icon: "cpu", label: agentDisplayName("ResumeParser") },
            { icon: "cpu", label: "DupeChecker" },
            { icon: "cpu", label: agentDisplayName("Matcher") },
            { icon: "sparkle", label: "AIInterviewer" },
            { icon: "cpu", label: "Evaluator" },
            { icon: "book", label: "PackageBuilder" },
            { icon: "mail", label: "PortalSubmitter" },
          ]} />
          <PaletteSection title="控制流 · LOGIC" items={[
            { icon: "branch", label: "分支 (匹配 / 完整性)" },
            { icon: "clock", label: "等待 / 重试" },
            { icon: "user", label: "HSM 审批" },
            { icon: "shield", label: "合规 / 黑名单护栏" },
            { icon: "db", label: "分布式锁" },
          ]} />
          <PaletteSection title="输出 · OUTPUT" items={[
            { icon: "plug", label: "渠道发布 API" },
            { icon: "mail", label: "客户门户提交" },
            { icon: "db", label: "写入知识库" },
            { icon: "check", label: "完成 Done" },
          ]} />
        </aside>

        {/* canvas */}
        <div className="relative overflow-hidden bg-bg">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: "radial-gradient(circle, oklch(0.92 0.005 260) 1px, transparent 1px)",
              backgroundSize: "20px 20px",
              opacity: 0.6,
            }}
          />
          <svg
            viewBox={GRAPH_VIEWBOX}
            preserveAspectRatio="xMidYMid meet"
            className="absolute inset-0 w-full h-full"
          >
            <defs>
              <marker id="arrowhead-b" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="var(--c-ink-3)" />
              </marker>
              <marker id="arrowhead-b-dim" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="var(--c-ink-4)" />
              </marker>
            </defs>

            {/* Stage column bands — visual grouping (one column = one workflow stage) */}
            <StageBands width={GRAPH_WIDTH} height={GRAPH_HEIGHT} />

            {edges.map((e, i) => {
              const a = nodes.find((n) => n.id === e.from);
              const b = nodes.find((n) => n.id === e.to);
              if (!a || !b) return null;
              const ax = a.x + 140;
              const ay = a.y + 22;  // node height 44 → center at 22
              const bx = b.x;
              const by = b.y + 22;
              const mid = (ax + bx) / 2;
              const d = `M ${ax} ${ay} C ${mid} ${ay}, ${mid} ${by}, ${bx} ${by}`;

              // Active edge = edge leading INTO a live agent that currently
              // has running steps. Renders marching-ants flow animation.
              const destLive = liveOverlay.byWsId.get(b.wsId);
              const isActive = !!destLive && destLive.running > 0 && !destLive.paused;
              const strokeColor = isActive
                ? "var(--c-ok)"
                : e.dashed ? "var(--c-ink-4)" : "var(--c-ink-3)";
              const strokeOpacity = isActive ? 0.85 : e.dashed ? 0.55 : 0.65;

              return (
                <g key={i}>
                  <path
                    d={d}
                    stroke={strokeColor}
                    strokeWidth={isActive ? 1.6 : 1.2}
                    strokeDasharray={isActive ? "6 4" : e.dashed ? "3 4" : "none"}
                    strokeOpacity={strokeOpacity}
                    fill="none"
                    markerEnd={e.dashed ? "url(#arrowhead-b-dim)" : "url(#arrowhead-b)"}
                  >
                    {isActive && (
                      <animate
                        attributeName="stroke-dashoffset"
                        from="0" to="-20" dur="0.8s" repeatCount="indefinite"
                      />
                    )}
                  </path>
                  {e.label && (
                    <g transform={`translate(${mid} ${(ay + by) / 2 - 2})`}>
                      <rect
                        x="-18" y="-8" width="36" height="14" rx="7"
                        fill="var(--c-bg)" opacity="0.95"
                      />
                      <text
                        x="0" y="3" textAnchor="middle" fontSize="9"
                        fontFamily="var(--f-sans)" fill="var(--c-ink-3)"
                      >
                        {e.label}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}

            {nodes.map((n) => {
              const short = n.kind === "agent" ? nodeAgentShort(n) : null;
              const liveHealth = short ? health.byShort.get(short) ?? null : null;
              // ★ Inngest live overlay — only 3 nodes match (wsId 4/9-1/10).
              // Others get rendered as "蓝图 / blueprint" (dimmed).
              const liveAgent = liveOverlay.byWsId.get(n.wsId) ?? null;
              const isBlueprintStub =
                n.kind === "agent" && !liveAgent;
              return (
                <WFNode
                  key={n.id}
                  node={n}
                  liveHealth={liveHealth}
                  liveAgent={liveAgent}
                  isBlueprintStub={isBlueprintStub}
                  selected={n.id === selectedId}
                  onSelect={() => setSelectedId(n.id)}
                />
              );
            })}
          </svg>

          {/* canvas chrome */}
          <div className="absolute top-3 left-3 flex gap-1.5 bg-surface border border-line rounded-md p-[3px] shadow-sh-1">
            <Btn size="sm" variant="ghost" style={{ height: 22, width: 22, padding: 0 }} title="undo">↶</Btn>
            <Btn size="sm" variant="ghost" style={{ height: 22, width: 22, padding: 0 }} title="redo">↷</Btn>
          </div>
          <div className="absolute bottom-3 left-3 flex gap-1.5 items-center bg-surface border border-line rounded-md mono text-[11px] text-ink-3 shadow-sh-1" style={{ padding: "3px 8px" }}>
            <Btn size="sm" variant="ghost" style={{ height: 22, width: 22, padding: 0 }}>−</Btn>
            <span>84%</span>
            <Btn size="sm" variant="ghost" style={{ height: 22, width: 22, padding: 0 }}>+</Btn>
            <span className="w-px h-3 bg-line mx-1" />
            <span>fit</span>
          </div>
          <div className="absolute bottom-3 right-3 bg-surface border border-line rounded-md text-[11px] text-ink-3 shadow-sh-1 flex gap-2.5 items-center" style={{ padding: "6px 10px" }}>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-accent-bg border border-accent-line" /> 触发</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-white border border-line-strong" /> 智能体</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[color:var(--c-warn-bg)] border border-[color:color-mix(in_oklab,var(--c-warn)_40%,transparent)]" /> 人工</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[color:var(--c-ok-bg)] border border-[color:color-mix(in_oklab,var(--c-ok)_30%,transparent)]" /> 护栏</span>
          </div>
        </div>

        {/* inspector */}
        <aside className="border-l border-line bg-surface flex flex-col min-h-0">
          <Inspector
            node={sel}
            liveHealth={
              sel.kind === "agent"
                ? health.byShort.get(nodeAgentShort(sel) ?? "") ?? null
                : null
            }
            liveAgent={liveOverlay.byWsId.get(sel.wsId) ?? null}
            isBlueprintStub={sel.kind === "agent" && !liveOverlay.byWsId.get(sel.wsId)}
            onJumpToAgent={jumpToAgent}
          />
        </aside>
      </div>
    </div>
  );
}

function PaletteSection({ title, items }: { title: string; items: { icon: IcName; label: string }[] }) {
  return (
    <div style={{ padding: "12px 10px 4px" }}>
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold" style={{ padding: "4px 6px 8px" }}>
        {title}
      </div>
      <div className="flex flex-col gap-0.5">
        {items.map((it, i) => {
          const Icon = Ic[it.icon];
          return (
            <div
              key={i}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[12.5px] cursor-grab text-ink-2 hover:bg-panel"
            >
              <span className="text-ink-3"><Icon /></span>
              <span>{it.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Maps a WorkflowNode.title (which may carry decoration like "ResumeParser +
// DupeCheck") to the AGENT_FUNCTIONS short. Single source of truth so
// /workflow canvas + Inspector + summary computation all agree.
function nodeAgentShort(node: WorkflowNode): string | null {
  if (node.kind !== "agent") return null;
  const tries = [node.title, node.title.split(/\s|\+|·/)[0]].filter(Boolean);
  for (const t of tries) {
    if (byShortFunction(t)) return t;
  }
  return null;
}

// Human label for a node — prefers the Inngest function name so the canvas
// matches the Fleet / Monitor / Events UIs. Falls back to the raw title for
// non-agent nodes (triggers, terminals, etc.).
function nodeTitleLabel(node: WorkflowNode): string {
  const short = nodeAgentShort(node);
  if (!short) return node.title;
  const inngestLabel = agentDisplayName(short);
  // If the raw title carries extra decoration like "ResumeParser + DupeCheck",
  // splice the inngest label in for the short while preserving the rest.
  if (node.title === short) return inngestLabel;
  return node.title.replace(short, inngestLabel);
}

const HEALTH_TONE: Record<AgentHealthStatus, { color: string; label: string; pulse: boolean }> = {
  idle: { color: "var(--c-ink-4)", label: "idle", pulse: false },
  running: { color: "var(--c-ok)", label: "running", pulse: true },
  healthy: { color: "var(--c-ok)", label: "healthy", pulse: false },
  degraded: { color: "var(--c-warn)", label: "degraded", pulse: false },
  failed: { color: "var(--c-err)", label: "failed", pulse: true },
};

function WFNode({
  node,
  liveHealth,
  liveAgent,
  isBlueprintStub,
  selected,
  onSelect,
}: {
  node: WorkflowNode;
  liveHealth: AgentHealth | null;
  liveAgent: LiveAgentState | null;
  isBlueprintStub: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const w = 140;
  const h = 44;
  // Dim blueprint stubs visually — they're not deployed, so don't pretend
  // they have status.
  const stubOpacity = isBlueprintStub ? 0.55 : 1;
  const isLive = !!liveAgent && !liveAgent.paused;
  const style = (() => {
    switch (node.kind) {
      case "trigger": return { fill: "var(--c-accent-bg)", stroke: "var(--c-accent-line)", accent: "var(--c-accent)" };
      case "hitl": return { fill: "var(--c-warn-bg)", stroke: "color-mix(in oklab, var(--c-warn) 30%, transparent)", accent: "oklch(0.5 0.14 75)" };
      case "guard": return { fill: "var(--c-ok-bg)", stroke: "color-mix(in oklab, var(--c-ok) 25%, transparent)", accent: "var(--c-ok)" };
      case "branch": return { fill: "var(--c-panel)", stroke: "var(--c-line-strong)", accent: "var(--c-ink-2)" };
      case "done": return { fill: "var(--c-raised)", stroke: "var(--c-line-strong)", accent: "var(--c-ink-3)" };
      default: return { fill: "var(--c-surface)", stroke: isLive ? "color-mix(in oklab, var(--c-ok) 35%, var(--c-line-strong))" : "var(--c-line-strong)", accent: "var(--c-ink-1)" };
    }
  })();
  // ★ Live overlay tone takes priority over the legacy /api/agents/health.
  // - Paused → warn (yellow)
  // - Has failed runs → err (red, pulse)
  // - Has running → ok (green, pulse)
  // - Has completed only → ok (green, steady)
  // - No runs → muted dot (idle blue-grey)
  const liveTone: { color: string; label: string; pulse: boolean } | null = liveAgent
    ? liveAgent.paused
      ? { color: "var(--c-warn)", label: "paused", pulse: false }
      : liveAgent.running > 0
      ? { color: "var(--c-ok)", label: `${liveAgent.running} running`, pulse: true }
      : liveAgent.failed > 0
      ? { color: "var(--c-err)", label: `${liveAgent.failed} failed`, pulse: true }
      : liveAgent.completed > 0
      ? { color: "var(--c-ok)", label: `${liveAgent.completed} ok`, pulse: false }
      : { color: "var(--c-ink-4)", label: "idle", pulse: false }
    : null;
  const tone =
    liveTone ??
    (node.kind === "agent" && liveHealth ? HEALTH_TONE[liveHealth.status] : null);
  const statusDot = tone?.color ?? null;
  const statusPulse = tone?.pulse ?? false;
  const Icon = Ic[node.icon];
  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      style={{ cursor: "pointer", opacity: stubOpacity }}
      onClick={onSelect}
      className="wf-node"
    >
      {/* Selection: subtle dark border ring */}
      {selected && (
        <rect
          x="-3" y="-3" width={w + 6} height={h + 6} rx="9"
          fill="none" stroke="var(--c-ink-1)" strokeWidth="1.5" opacity="0.9"
        />
      )}

      {/* Base card with subtle drop shadow on LIVE */}
      <rect
        x="0" y="0" width={w} height={h} rx="6"
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth="1"
        filter={isLive ? "drop-shadow(0 1px 3px color-mix(in oklab, var(--c-ok) 25%, transparent))" : undefined}
      />

      {/* Icon */}
      <foreignObject x="11" y={(h - 16) / 2} width="16" height="16">
        <div className="w-[16px] h-[16px] grid place-items-center" style={{ color: style.accent }}>
          <Icon />
        </div>
      </foreignObject>

      {/* Title — single primary label, vertically centered */}
      <text
        x="34" y={h / 2 + 1}
        fontSize="11.5" fontWeight="500"
        fill="var(--c-ink-1)"
        style={{ fontFamily: "var(--f-sans)" }}
        dominantBaseline="middle"
      >
        {nodeTitleLabel(node)}
      </text>

      {/* Status dot (top-right) — pulse uses a soft breathing ripple */}
      {statusDot && (
        <g transform={`translate(${w - 11} 10)`}>
          {statusPulse && (
            <>
              <circle r="3.5" fill={statusDot} opacity="0.25">
                <animate attributeName="r" values="3;7;3" dur="2.4s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1; 0.4 0 0.2 1" keyTimes="0;0.5;1" />
                <animate attributeName="opacity" values="0.35;0;0.35" dur="2.4s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1; 0.4 0 0.2 1" keyTimes="0;0.5;1" />
              </circle>
            </>
          )}
          <circle r="3" fill={statusDot} />
          {tone && (
            <title>
              {tone.label}
              {liveAgent?.total
                ? ` · ${liveAgent.completed}✓ ${liveAgent.failed > 0 ? `${liveAgent.failed}✗ ` : ""}${liveAgent.running > 0 ? `${liveAgent.running}●` : ""}`
                : ""}
              {liveHealth?.lastActivityAt
                ? ` · last ${new Date(liveHealth.lastActivityAt).toLocaleTimeString(undefined, { hour12: false })}`
                : ""}
            </title>
          )}
        </g>
      )}

      {/* Blueprint marker — tiny corner label */}
      {isBlueprintStub && (
        <text x={w - 7} y={h - 5} textAnchor="end" fontSize="8.5" fill="var(--c-ink-4)" style={{ fontFamily: "var(--f-sans)" }}>
          蓝图
        </text>
      )}

      {/* Run count strip — corner, only for LIVE with traffic */}
      {liveAgent && liveAgent.total > 0 && !isBlueprintStub && (
        <text
          x={w - 7} y={h - 5} textAnchor="end" fontSize="9" fontWeight="500"
          fill="var(--c-ink-2)" style={{ fontFamily: "var(--f-mono)" }}
        >
          {liveAgent.completed}✓{liveAgent.failed > 0 ? ` ${liveAgent.failed}✗` : ""}{liveAgent.running > 0 ? ` ${liveAgent.running}●` : ""}
        </text>
      )}
    </g>
  );
}


// ── Stage column background bands ───────────────────────────────────
// Visual grouping for the 8-column left-to-right pipeline. Tone-matched
// to each stage's role (intake / build / process / match / interview /
// package / submit). Soft colors — should be felt, not seen.

const STAGE_BANDS: Array<{ x: number; w: number; label: string; tint: string }> = [
  { x: 0,    w: 200,  label: "触发",   tint: "color-mix(in oklab, var(--c-accent) 4%, transparent)" },
  { x: 200,  w: 280,  label: "需求",   tint: "color-mix(in oklab, var(--c-ink-3) 3%, transparent)" },
  { x: 480,  w: 320,  label: "JD",     tint: "color-mix(in oklab, oklch(0.7 0.12 80) 5%, transparent)" },
  { x: 800,  w: 320,  label: "简历",   tint: "color-mix(in oklab, var(--c-info) 4%, transparent)" },
  { x: 1120, w: 280,  label: "匹配",   tint: "color-mix(in oklab, var(--c-ok) 5%, transparent)" },
  { x: 1400, w: 320,  label: "面试评估", tint: "color-mix(in oklab, var(--c-warn) 4%, transparent)" },
  { x: 1720, w: 320,  label: "推荐包", tint: "color-mix(in oklab, var(--c-ink-3) 3%, transparent)" },
  { x: 2040, w: 160,  label: "提交",   tint: "color-mix(in oklab, var(--c-accent) 4%, transparent)" },
];

function StageBands({ width: _width, height }: { width: number; height: number }) {
  // pointer-events="none" — bands are pure decoration; they must NOT capture
  // clicks intended for the node groups behind them in the DOM (SVG renders
  // bands before nodes, but a rect spanning the whole canvas would otherwise
  // catch clicks falling outside the small node boxes too).
  return (
    <g style={{ pointerEvents: "none" }}>
      {STAGE_BANDS.map((b, i) => (
        <g key={i}>
          <rect x={b.x} y={0} width={b.w} height={height} fill={b.tint} />
          <text
            x={b.x + b.w / 2} y={28}
            textAnchor="middle" fontSize="11"
            fill="var(--c-ink-4)"
            style={{ fontFamily: "var(--f-sans)", letterSpacing: "0.04em" }}
          >
            {b.label}
          </text>
          {i > 0 && (
            <line
              x1={b.x} y1={0} x2={b.x} y2={height}
              stroke="var(--c-line)" strokeWidth="0.5" strokeDasharray="2 4" opacity="0.5"
            />
          )}
        </g>
      ))}
    </g>
  );
}

function Inspector({
  node,
  liveHealth,
  liveAgent,
  isBlueprintStub,
  onJumpToAgent,
}: {
  node: WorkflowNode;
  liveHealth: AgentHealth | null;
  liveAgent: LiveAgentState | null;
  isBlueprintStub: boolean;
  onJumpToAgent: (short: string) => void;
}) {
  const { t } = useApp();
  const Icon = Ic[node.icon];
  const agentShort = nodeAgentShort(node);
  return (
    <>
      <div className="border-b border-line" style={{ padding: "14px 16px" }}>
        <div className="hint mb-1">{t("wf_inspector")}</div>
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-md grid place-items-center bg-panel border border-line text-[color:var(--c-accent)]"
          >
            <Icon />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[13px] font-semibold">{nodeTitleLabel(node)}</span>
              {liveAgent && !liveAgent.paused && (
                <span className="text-[9px] mono font-bold px-1.5 py-0.5 rounded bg-ok-bg text-ok">● LIVE</span>
              )}
              {liveAgent?.paused && (
                <span className="text-[9px] mono font-bold px-1.5 py-0.5 rounded bg-warn-bg text-warn">⏸ PAUSED</span>
              )}
              {isBlueprintStub && (
                <span className="text-[9px] mono font-medium px-1.5 py-0.5 rounded border border-line text-ink-4">蓝图(未部署)</span>
              )}
            </div>
            <div className="text-ink-3 text-[11px]">{node.sub}</div>
          </div>
          <Btn size="sm" variant="ghost" style={{ padding: "0 6px" }}><Ic.dots /></Btn>
        </div>
      </div>

      {/* ★ Live agent panel — only shown for the 3 real PRA agents */}
      {liveAgent && <LiveAgentPanel liveAgent={liveAgent} />}

      {/* ★ Blueprint warning — shown for non-deployed stub agents */}
      {isBlueprintStub && (
        <div className="border-b border-line mx-3 my-3 p-3 rounded-md bg-panel">
          <div className="text-[11px] text-ink-3 leading-relaxed">
            ⚠ 此节点是 <strong>蓝图设计</strong> — 实际 Inngest 上 <strong>未部署</strong>。
            <br />
            它定义了完整工作流的位置 / 触发事件 / 下游连接,作为 v0_1_010 实施路线图的参考。
            <br />
            <br />
            当前部署的实际 agent:Create JD Agent · Resume Parser Agent · Match Resume Agent · Rule Check Agent。
            <Link href="/workflow-agents" className="text-accent hover:underline ml-1">
              → 完整 list 视图
            </Link>
          </div>
        </div>
      )}
      <div className="overflow-auto py-1.5">
        {/* Canonical step details — show for EVERY node, not just real agents.
            This is the actual "步骤详情" content per the panel title. */}
        <CanonicalDetailsPanel node={node} />
        <NeighborhoodPanel short={agentShort} onJump={onJumpToAgent} />
        {agentShort && liveHealth !== undefined && (
          <AgentHealthPanel short={agentShort} health={liveHealth} />
        )}
        {agentShort && <RecentEntitiesPanel short={agentShort} />}
        {agentShort && <AgentExplainPanel short={agentShort} />}
        {agentShort && <AgentChatbot short={agentShort} />}
        {agentShort && <AgentLogsPanel short={agentShort} />}
      </div>
    </>
  );
}

// Renders description / trigger events / actions / emitted events from the
// canonical workflow JSON. Falls back gracefully when the node is the
// synthetic trigger (wsId='trig').
function CanonicalDetailsPanel({ node }: { node: WorkflowNode }) {
  const canonical = CANONICAL_WORKFLOW.find((n) => n.id === node.wsId);

  // Trigger node — no canonical entry; render a friendly summary so the panel
  // doesn't look blank.
  if (!canonical) {
    return (
      <div className="border-b border-line" style={{ padding: "12px 16px" }}>
        <SectionLabel>说明</SectionLabel>
        <div className="text-ink-2" style={{ fontSize: 12, lineHeight: 1.6 }}>
          {node.sub || "外部触发点 · 工作流的入口"}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Description */}
      <div className="border-b border-line" style={{ padding: "12px 16px" }}>
        <SectionLabel>描述</SectionLabel>
        <div className="text-ink-2" style={{ fontSize: 12, lineHeight: 1.6 }}>
          {canonical.description}
        </div>
      </div>

      {/* Actor */}
      {canonical.actor && canonical.actor.length > 0 && (
        <div className="border-b border-line" style={{ padding: "12px 16px" }}>
          <SectionLabel>执行者</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {canonical.actor.map((a) => (
              <span
                key={a}
                className="inline-flex items-center rounded border border-line bg-surface text-ink-2"
                style={{ padding: "2px 8px", fontSize: 11.5 }}
              >
                {a === "Agent" ? "Agent 自动" : a === "Human" ? "Human 人工" : a}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Trigger events (what fires this step) */}
      {canonical.trigger && canonical.trigger.length > 0 && (
        <div className="border-b border-line" style={{ padding: "12px 16px" }}>
          <SectionLabel>触发事件 ({canonical.trigger.length})</SectionLabel>
          <div className="flex flex-col gap-1">
            {canonical.trigger.map((ev) => (
              <Link
                key={ev}
                href={`/events?name=${encodeURIComponent(ev)}`}
                className="inline-flex items-center rounded text-ink-2 hover:text-ink-1 hover:bg-panel transition-colors"
                style={{
                  padding: "3px 8px", fontSize: 11.5,
                  fontFamily: "var(--f-mono)",
                  textDecoration: "none",
                  border: "1px solid var(--c-line)",
                  alignSelf: "flex-start",
                }}
              >
                ← {ev}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Actions (ordered step actions) */}
      {canonical.actions && canonical.actions.length > 0 && (
        <div className="border-b border-line" style={{ padding: "12px 16px" }}>
          <SectionLabel>步骤动作 ({canonical.actions.length})</SectionLabel>
          <div className="flex flex-col gap-2.5">
            {canonical.actions.map((act) => (
              <div key={act.order} className="flex gap-2.5">
                <span
                  className="tabular-nums text-ink-4 shrink-0"
                  style={{ fontSize: 10, marginTop: 2, fontFamily: "var(--f-mono)" }}
                >
                  {String(act.order).padStart(2, "0")}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <code className="text-ink-1" style={{ fontSize: 11.5, fontFamily: "var(--f-mono)" }}>
                      {act.name}
                    </code>
                    <span
                      className="text-ink-4 rounded"
                      style={{
                        fontSize: 10, padding: "1px 5px",
                        background: "var(--c-panel)",
                        border: "1px solid var(--c-line)",
                      }}
                    >
                      {act.type}
                    </span>
                  </div>
                  {act.condition && (
                    <div className="text-ink-3 mt-1" style={{ fontSize: 11, lineHeight: 1.5 }}>
                      <span className="text-ink-4">条件:</span> {act.condition}
                    </div>
                  )}
                  <div className="text-ink-2 mt-1" style={{ fontSize: 11.5, lineHeight: 1.55 }}>
                    {act.description}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Triggered events (emitted) */}
      {canonical.triggered_event && canonical.triggered_event.length > 0 && (
        <div className="border-b border-line" style={{ padding: "12px 16px" }}>
          <SectionLabel>发出事件 ({canonical.triggered_event.length})</SectionLabel>
          <div className="flex flex-col gap-1">
            {canonical.triggered_event.map((ev) => (
              <Link
                key={ev}
                href={`/events?name=${encodeURIComponent(ev)}`}
                className="inline-flex items-center rounded text-ink-2 hover:text-ink-1 hover:bg-panel transition-colors"
                style={{
                  padding: "3px 8px", fontSize: 11.5,
                  fontFamily: "var(--f-mono)",
                  textDecoration: "none",
                  border: "1px solid var(--c-line)",
                  alignSelf: "flex-start",
                }}
              >
                → {ev}
              </Link>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-ink-4 mb-2"
      style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}
    >
      {children}
    </div>
  );
}

// Renders the registry-driven snapshot inline, plus a "AI 解读" button that
// lazily fetches /api/agents/:short/explain. The endpoint serves a
// deterministic markdown rendering when no LLM gateway is configured —
// meaning the panel is useful even offline.
// Live health snapshot for the selected agent. Same data the canvas dot
// uses, expanded into counts + error rate + last activity timestamp so
// the user can see WHY the dot is the color it is.
function AgentHealthPanel({
  short,
  health,
}: {
  short: string;
  health: AgentHealth | null;
}) {
  const tone = health ? HEALTH_TONE[health.status] : null;
  const last = health?.lastActivityAt
    ? new Date(health.lastActivityAt).toLocaleTimeString(undefined, { hour12: false })
    : null;

  return (
    <div className="border-b border-line" style={{ padding: "10px 16px" }}>
      <div className="flex items-center mb-2 gap-2">
        <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold flex-1">
          实时健康
        </div>
        {tone && (
          <span
            className="mono text-[10.5px] inline-flex items-center gap-1"
            style={{ color: tone.color }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: tone.color,
                boxShadow: `0 0 0 3px color-mix(in oklab, ${tone.color} 18%, transparent)`,
              }}
            />
            {tone.label}
          </span>
        )}
      </div>

      {!health ? (
        <div className="text-[11px] text-ink-3">加载 health 中…</div>
      ) : (
        <>
          <div className="text-[10.5px] text-ink-3 mb-2">
            过去 {Math.round((health.windowMs ?? 300_000) / 60_000)} 分钟窗口 ·
            {last ? ` 最近 ${last}` : " 无活动"}
          </div>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <HealthStat label="started" value={health.counts.started} />
            <HealthStat label="completed" value={health.counts.completed} />
            <HealthStat
              label="failed"
              value={health.counts.failed}
              tone={health.counts.failed > 0 ? "err" : undefined}
            />
            <HealthStat
              label="anomaly"
              value={health.counts.anomaly}
              tone={health.counts.anomaly > 0 ? "warn" : undefined}
            />
            <HealthStat label="tool" value={health.counts.tool} />
            <HealthStat label="decision" value={health.counts.decision} />
          </div>
          <div className="mono text-[10.5px] text-ink-3 mt-2">
            error rate · {(health.errorRate * 100).toFixed(1)}%
            {health.hasRunningStep && " · 有进行中的 step"}
          </div>
        </>
      )}
    </div>
  );
}

function HealthStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "err" | "warn";
}) {
  const color =
    tone === "err"
      ? "var(--c-err)"
      : tone === "warn"
        ? "var(--c-warn)"
        : value > 0
          ? "var(--c-ink-1)"
          : "var(--c-ink-4)";
  return (
    <div
      className="bg-panel border border-line rounded-sm flex items-center gap-2"
      style={{ padding: "3px 7px" }}
    >
      <span className="text-[10.5px] text-ink-4 flex-1">{label}</span>
      <span
        className="mono text-[12px] font-semibold tabular-nums"
        style={{ color }}
      >
        {value}
      </span>
    </div>
  );
}

// Compact 5-status summary in the workflow sub-header. Replaces the old
// "X 个 agent 活跃中 / 空闲" dual-state badge that came from the legacy
// /api/workflow/active poll.
function HeaderHealthSummary({
  summary,
}: {
  summary: { running: number; healthy: number; degraded: number; failed: number; idle: number };
}) {
  const total = summary.running + summary.healthy + summary.degraded + summary.failed + summary.idle;
  if (total === 0) {
    return (
      <Badge variant="info" dot>
        加载 agent health…
      </Badge>
    );
  }
  // Surface the worst non-zero state first.
  const items: Array<{ key: string; count: number; variant: "err" | "warn" | "ok" | "info" | "default"; label: string; pulse?: boolean }> = [];
  if (summary.failed > 0)
    items.push({ key: "failed", count: summary.failed, variant: "err", label: "failed", pulse: true });
  if (summary.degraded > 0)
    items.push({ key: "degraded", count: summary.degraded, variant: "warn", label: "degraded" });
  if (summary.running > 0)
    items.push({ key: "running", count: summary.running, variant: "ok", label: "running", pulse: true });
  if (summary.healthy > 0)
    items.push({ key: "healthy", count: summary.healthy, variant: "ok", label: "healthy" });
  if (items.length === 0) {
    items.push({
      key: "idle",
      count: summary.idle,
      variant: "default",
      label: `${summary.idle} idle`,
    });
  }
  return (
    <div className="flex items-center gap-1">
      {items.map((it) => (
        <Badge key={it.key} variant={it.variant} dot pulse={it.pulse}>
          {it.count} {it.label}
        </Badge>
      ))}
    </div>
  );
}

function AgentExplainPanel({ short }: { short: string }) {
  const fn = byShortFunction(short);
  const [resp, setResp] = React.useState<ExplainResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Reset whenever the inspector switches agents.
  React.useEffect(() => {
    setResp(null);
    setErr(null);
  }, [short]);

  const fetchExplain = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchJson<ExplainResponse>(
        `/api/agents/${encodeURIComponent(short)}/explain`,
      );
      setResp(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [short]);

  if (!fn) return null;

  return (
    <div className="border-b border-line" style={{ padding: "10px 16px" }}>
      <div className="flex items-center mb-2">
        <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold flex-1">
          AI 解读
        </div>
        {resp && (
          <Badge variant={resp.source === "llm" ? "ok" : "info"}>
            {resp.source === "llm" ? `via ${resp.modelUsed ?? "llm"}` : "fallback (无网关)"}
          </Badge>
        )}
      </div>

      {/* Always show the registry snapshot — it's instant and grounds the
          UI even before the LLM call returns. */}
      <div className="text-[12.5px] text-ink-1 leading-relaxed mb-2">{fn.summary}</div>
      <div className="grid gap-2 mb-2" style={{ gridTemplateColumns: "1fr" }}>
        <ExplainBlock title="典型操作" items={fn.operations} />
        <ExplainBlock title="调用工具" items={fn.tools} />
        {fn.failureModes && fn.failureModes.length > 0 && (
          <ExplainBlock title="常见失败模式" items={fn.failureModes} muted />
        )}
      </div>

      {!resp && !loading && (
        <Btn size="sm" onClick={fetchExplain} variant="default">
          <Ic.sparkle /> 让 AI 详细解读
        </Btn>
      )}
      {loading && (
        <div className="text-[11px] text-ink-3">AI 正在生成解读…</div>
      )}
      {err && (
        <div className="text-[11px]" style={{ color: "var(--c-warn)" }}>
          ⚠ {err}
        </div>
      )}
      {resp && (
        <div
          className="mono text-[11.5px] text-ink-2 bg-panel border border-line rounded-sm overflow-auto whitespace-pre-wrap"
          style={{ padding: 10, maxHeight: 320, lineHeight: 1.5 }}
        >
          {resp.text}
        </div>
      )}
    </div>
  );
}

// Cross-run activity log filtered to this agent. Renders inside the
// Inspector — `compact` mode keeps it usable in the narrow right rail.
// Auto-polls every 4s; toolbar lets the user pause and search.
function AgentLogsPanel({ short }: { short: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border-b border-line" style={{ padding: "10px 16px" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full bg-transparent border-0 cursor-pointer flex items-center"
        style={{ padding: 0 }}
      >
        <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold flex-1 text-left">
          运行日志 · 跨 run
        </div>
        <span className="mono text-[10px] text-ink-3">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div
          className="mt-2 border border-line rounded-md overflow-hidden bg-surface"
          style={{ height: 360 }}
        >
          <LogStream
            endpoint={`/api/agents/${encodeURIComponent(short)}/activity?limit=100`}
            order="desc"
            hideAgent
            compact
            pollIntervalMs={4000}
            emptyHint={`${short} 还没有写入 AgentActivity 行。日志契约：每个 agent 在做有意义的事时（开始/完成 step、调用工具、决策、异常）应写一条 AgentActivity，rumtime 才能在这里看到。`}
          />
        </div>
      )}
    </div>
  );
}

function ExplainBlock({
  title,
  items,
  muted,
}: {
  title: string;
  items: string[];
  muted?: boolean;
}) {
  return (
    <div>
      <div className="text-[10.5px] text-ink-4 font-semibold mb-1">{title}</div>
      <ul className="text-[12px] text-ink-2 leading-relaxed pl-4 m-0" style={{ listStyle: "disc", opacity: muted ? 0.85 : 1 }}>
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}
