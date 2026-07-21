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
import { CANONICAL_WORKFLOW, type WorkflowNode } from "@/lib/workflow-graph-meta";
import { useWorkflowGraph } from "@/lib/api/workflow-graph";
import { friendlyDomainName } from "@/lib/domain-ids";
import { useInngestLiveOverlay, WSID_TO_INNGEST_SLUG, type LiveAgentState } from "@/lib/api/inngest-live-overlay";
import { LiveAgentPanel } from "./LiveAgentPanel";
import Link from "next/link";

// Zoom bounds — module-level so the fit helper and the wheel/zoom handlers
// share one source of truth.
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;

// Stable empty live-overlay map for non-recruitment domains (see liveByWsId).
const EMPTY_LIVE_OVERLAY: ReadonlyMap<string, LiveAgentState> = new Map();

// Fit the canvas to the actual node bounding box (+ padding) instead of the raw
// window box. The raw box left a ~100px gap on the left AND clipped the
// rightmost node, so the graph opened off-center with a node cut off. Fitting
// the real bbox centers the graph and shows every node on first paint. The
// `winW`/`winH` window dims (aspect + scale baseline) are per-domain: recruitment
// uses 2350×800, other domains pass their own generated graph's bbox dims.
function fitViewForNodes(
  nodes: WorkflowNode[],
  winW: number,
  winH: number,
  t: (k: string) => string,
  lang: string,
): { x: number; y: number; scale: number } {
  const PAD = 90;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const w = computeNodeWidth(nodeTitleLabel(n, t, lang));
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + w > maxX) maxX = n.x + w;
    if (n.y + NODE_HEIGHT > maxY) maxY = n.y + NODE_HEIGHT;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, scale: 1 };
  const bx = minX - PAD;
  const by = minY - PAD;
  const bw = maxX - minX + PAD * 2;
  const bh = maxY - minY + PAD * 2;
  // The visible window is winW/scale × winH/scale; pick the scale that makes it
  // just contain the bbox, then center the window on the bbox.
  const scale = Math.max(
    MIN_SCALE,
    Math.min(MAX_SCALE, Math.min(winW / bw, winH / bh)),
  );
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  return { x: cx - winW / scale / 2, y: cy - winH / scale / 2, scale };
}

export function WorkflowContent() {
  const { t, lang } = useApp();
  // "trig" matches NODE_LAYOUT[0].id. Previous default "jd" never matched any
  // node, which left the canvas with no highlighted card on first render.
  const [selectedId, setSelectedId] = React.useState("trig");

  // Canvas view mode:
  //   "overview" (全局) — the whole graph rendered at full clarity; selecting a
  //                       node just rings it (and lights its edges), nothing dims.
  //   "focus"    (聚焦) — spotlight the selected node + its immediate up/downstream
  //                       neighbors; everything else dims back.
  // Defaults to overview so the graph reads clearly on open.
  const [viewMode, setViewMode] = React.useState<"overview" | "focus">("overview");
  const focusMode = viewMode === "focus";

  // ── Per-domain graph ──────────────────────────────────────────────
  // Recruitment (招聘) renders the authoritative hand-tuned graph; every other
  // business domain renders its ontology auto-laid-out by /api/workflow/graph.
  // Switching the top-right domain swaps the whole canvas.
  const graph = useWorkflowGraph();
  const baseNodes = graph.nodes;
  const edges = graph.edges;

  // Per-domain pan/zoom WINDOW dims (aspect + scale baseline). Recruitment is
  // 2350×800; other domains carry their generated bbox. A ref mirrors it so the
  // once-registered wheel handler reads the current value, not a stale closure.
  const [graphDims, setGraphDims] = React.useState<{ w: number; h: number }>({
    w: graph.width,
    h: graph.height,
  });
  const graphDimsRef = React.useRef(graphDims);
  React.useEffect(() => {
    graphDimsRef.current = graphDims;
  }, [graphDims]);

  // While a non-recruitment domain is loading / errored / empty there is nothing
  // to pan; block canvas interaction so the status overlay isn't pannable.
  const canvasBlocked =
    !graph.isRecruitment && (graph.loading || !!graph.error || baseNodes.length === 0);

  // ── Draggable node positions ──────────────────────────────────────
  // Static NODES carries the initial layout; positions overrides x/y when
  // the user drags a node. Edges read from positionedNodes so connection
  // lines follow whatever the user has moved.
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [positions, setPositions] = React.useState<Map<string, { x: number; y: number }>>(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of baseNodes) m.set(n.id, { x: n.x, y: n.y });
    return m;
  });
  const dragRef = React.useRef<{
    id: string;
    startNode: { x: number; y: number };
    startPointerSvg: { x: number; y: number };
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);

  // ── Canvas pan + zoom ────────────────────────────────────────────────
  // viewBox is derived from `view`: scale shrinks the visible window
  // (zoom in), and (x, y) shifts its top-left corner (pan).
  const [view, setView] = React.useState<{ x: number; y: number; scale: number }>(
    () => fitViewForNodes(baseNodes, graph.width, graph.height, t, lang),
  );
  const viewRef = React.useRef(view);
  React.useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // Re-seed layout whenever the graph changes (domain switch / async load).
  // positions + view are otherwise initialized once, so without this a fetched
  // per-domain graph would render at stale coordinates and resist dragging.
  React.useEffect(() => {
    if (baseNodes.length === 0) return;
    const m = new Map<string, { x: number; y: number }>();
    for (const n of baseNodes) m.set(n.id, { x: n.x, y: n.y });
    setPositions(m);
    setGraphDims({ w: graph.width, h: graph.height });
    setView(fitViewForNodes(baseNodes, graph.width, graph.height, t, lang));
    setSelectedId((prev) => (baseNodes.some((n) => n.id === prev) ? prev : "trig"));
    // Intentionally NOT keyed on `t`: a language switch should relabel cards
    // (via the nodeWidths memo) without resetting the user's pan/zoom/drags.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseNodes, graph.width, graph.height]);
  const panRef = React.useRef<{
    startClientX: number;
    startClientY: number;
    startView: { x: number; y: number };
    ctmA: number;
    ctmD: number;
    moved: boolean;
  } | null>(null);
  const [panning, setPanning] = React.useState(false);

  const nodes = React.useMemo(
    () =>
      baseNodes.map((n) => {
        const p = positions.get(n.id);
        return p ? { ...n, x: p.x, y: p.y } : n;
      }),
    [baseNodes, positions],
  );

  const clientToSvg = React.useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const out = pt.matrixTransform(ctm.inverse());
      return { x: out.x, y: out.y };
    },
    [],
  );

  const handleNodePointerDown = React.useCallback(
    (e: React.PointerEvent<SVGGElement>, nodeId: string) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const svgPt = clientToSvg(e.clientX, e.clientY);
      const current = positions.get(nodeId);
      if (!svgPt || !current) return;
      // Pin the pointer to the node so subsequent move/up events are routed
      // to the same element and can't accidentally trigger the SVG's
      // pointerdown (which would start a canvas pan).
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        // setPointerCapture can throw if the target was unmounted; safe to ignore.
      }
      dragRef.current = {
        id: nodeId,
        startNode: { x: current.x, y: current.y },
        startPointerSvg: svgPt,
        startClientX: e.clientX,
        startClientY: e.clientY,
        moved: false,
      };
      setDraggingId(nodeId);
    },
    [clientToSvg, positions],
  );

  React.useEffect(() => {
    if (!draggingId) return;
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      // Threshold check uses SCREEN coords so the click-vs-drag gate doesn't
      // become sub-pixel sensitive at low zoom levels (3 graph units could
      // be < 1 screen pixel when the canvas is zoomed out).
      const dxScreen = e.clientX - d.startClientX;
      const dyScreen = e.clientY - d.startClientY;
      if (!d.moved) {
        if (Math.hypot(dxScreen, dyScreen) <= 5) return;
        d.moved = true;
      }
      const svgPt = clientToSvg(e.clientX, e.clientY);
      if (!svgPt) return;
      const dx = svgPt.x - d.startPointerSvg.x;
      const dy = svgPt.y - d.startPointerSvg.y;
      const nx = d.startNode.x + dx;
      const ny = d.startNode.y + dy;
      setPositions((prev) => {
        const next = new Map(prev);
        next.set(d.id, { x: nx, y: ny });
        return next;
      });
    }
    function onUp() {
      const d = dragRef.current;
      // Treat as a click when the pointer barely moved.
      if (d && !d.moved) setSelectedId(d.id);
      dragRef.current = null;
      setDraggingId(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [draggingId, clientToSvg]);

  const resetLayout = React.useCallback(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of baseNodes) m.set(n.id, { x: n.x, y: n.y });
    setPositions(m);
    setGraphDims({ w: graph.width, h: graph.height });
    setView(fitViewForNodes(baseNodes, graph.width, graph.height, t, lang));
  }, [baseNodes, graph.width, graph.height, t, lang]);

  // SVG-level pointerdown — fires only when the pointer is on empty canvas
  // (nodes call stopPropagation so they don't initiate a pan).
  const handleSvgPointerDown = React.useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (canvasBlocked) return; // status overlay is showing; nothing to pan
      if (e.button !== 0) return;
      if (dragRef.current) return; // a node drag is in progress
      const svg = svgRef.current;
      if (!svg) return;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      e.preventDefault();
      panRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startView: { x: viewRef.current.x, y: viewRef.current.y },
        // CTM.a/.d encode screen-pixels-per-graph-unit. Captured at pan start
        // so the conversion stays consistent as view updates each frame.
        ctmA: ctm.a,
        ctmD: ctm.d,
        moved: false,
      };
      setPanning(true);
    },
    [canvasBlocked],
  );

  React.useEffect(() => {
    if (!panning) return;
    function onMove(e: PointerEvent) {
      const p = panRef.current;
      if (!p) return;
      const dxScreen = e.clientX - p.startClientX;
      const dyScreen = e.clientY - p.startClientY;
      // Same drag threshold as the node-drag handler — clicks must not pan.
      if (!p.moved) {
        if (Math.hypot(dxScreen, dyScreen) <= 5) return;
        p.moved = true;
      }
      // Screen → graph delta: divide by CTM scale captured at pan start.
      const dxGraph = dxScreen / p.ctmA;
      const dyGraph = dyScreen / p.ctmD;
      setView((v) => ({ ...v, x: p.startView.x - dxGraph, y: p.startView.y - dyGraph }));
    }
    function onUp() {
      panRef.current = null;
      setPanning(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [panning]);

  // Wheel zoom — native listener with `passive: false` so we can preventDefault
  // and avoid the browser scrolling the outer page during zoom.
  React.useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const v = viewRef.current;
      const factor = e.deltaY > 0 ? 1 / 1.15 : 1.15;
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
      if (nextScale === v.scale) return;
      const rect = svg!.getBoundingClientRect();
      const { w: gW, h: gH } = graphDimsRef.current;
      // Graph point under cursor BEFORE the zoom (using current viewBox).
      const vw = gW / v.scale;
      const vh = gH / v.scale;
      const s = Math.min(rect.width / vw, rect.height / vh); // preserveAspectRatio="meet"
      const padX = (rect.width - vw * s) / 2;
      const padY = (rect.height - vh * s) / 2;
      const graphX = v.x + (e.clientX - rect.left - padX) / s;
      const graphY = v.y + (e.clientY - rect.top - padY) / s;
      // Compute new viewBox so the same graph point stays under the cursor.
      const vwNew = gW / nextScale;
      const vhNew = gH / nextScale;
      const sNew = Math.min(rect.width / vwNew, rect.height / vhNew);
      const padXNew = (rect.width - vwNew * sNew) / 2;
      const padYNew = (rect.height - vhNew * sNew) / 2;
      const nextX = graphX - (e.clientX - rect.left - padXNew) / sNew;
      const nextY = graphY - (e.clientY - rect.top - padYNew) / sNew;
      setView({ x: nextX, y: nextY, scale: nextScale });
    }
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = React.useCallback((factor: number) => {
    setView((v) => {
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
      if (nextScale === v.scale) return v;
      // Anchor zoom-around-center: keep the canvas center fixed.
      const { w: gW, h: gH } = graphDimsRef.current;
      const cx = v.x + gW / v.scale / 2;
      const cy = v.y + gH / v.scale / 2;
      const nextX = cx - gW / nextScale / 2;
      const nextY = cy - gH / nextScale / 2;
      return { x: nextX, y: nextY, scale: nextScale };
    });
  }, []);

  const fitView = React.useCallback(() => {
    setView(fitViewForNodes(nodes, graphDims.w, graphDims.h, t, lang));
  }, [nodes, graphDims, t, lang]);

  const viewBox = `${view.x} ${view.y} ${graphDims.w / view.scale} ${graphDims.h / view.scale}`;

  // Agent palette: recruitment shows its curated roster; other domains derive
  // the list from the live graph's agent/HITL nodes so the palette matches the
  // ontology on the canvas instead of recruitment names.
  const agentPaletteItems = React.useMemo<{ icon: IcName; label: string }[]>(() => {
    if (graph.isRecruitment) {
      const roster: { icon: IcName; short: string }[] = [
        { icon: "db", short: "ReqSync" },
        { icon: "sparkle", short: "ReqAnalyzer" },
        { icon: "sparkle", short: "JDGenerator" },
        { icon: "plug", short: "Publisher" },
        { icon: "db", short: "ResumeCollector" },
        { icon: "cpu", short: "ResumeParser" },
        { icon: "cpu", short: "Matcher" },
        { icon: "sparkle", short: "AIInterviewer" },
        { icon: "cpu", short: "Evaluator" },
        { icon: "book", short: "PackageBuilder" },
        { icon: "mail", short: "PortalSubmitter" },
      ];
      return roster.map((r) => ({ icon: r.icon, label: localizedAgentLabel(r.short, t) }));
    }
    return baseNodes
      .filter((n) => n.kind !== "trigger")
      .slice(0, 14)
      .map((n) => ({ icon: n.icon, label: nodeTitleLabel(n, t, lang) }));
  }, [graph.isRecruitment, baseNodes, t, lang]);

  // Dynamic per-node width — fits the rendered label so long names like
  // "Interview Inviter Agent" don't overflow the card.
  const nodeWidths = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) m.set(n.id, computeNodeWidth(nodeTitleLabel(n, t, lang)));
    return m;
  }, [nodes, t, lang]);

  // Neighbor index — for highlighting the selected node + its immediate
  // upstream/downstream cards when the user clicks one.
  const { predecessors, successors } = React.useMemo(() => {
    const preds = new Map<string, Set<string>>();
    const succs = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!preds.has(e.to)) preds.set(e.to, new Set());
      preds.get(e.to)!.add(e.from);
      if (!succs.has(e.from)) succs.set(e.from, new Set());
      succs.get(e.from)!.add(e.to);
    }
    return { predecessors: preds, successors: succs };
  }, [edges]);

  const neighborIds = React.useMemo(() => {
    const set = new Set<string>();
    predecessors.get(selectedId)?.forEach((id) => set.add(id));
    successors.get(selectedId)?.forEach((id) => set.add(id));
    return set;
  }, [selectedId, predecessors, successors]);

  const sel = nodes.find((n) => n.id === selectedId) || nodes[0];

  // Resolve a canonical agent short → the matching NodeDef on the canvas.
  // Used by NeighborhoodPanel to jump selection without scrolling.
  const jumpToAgent = React.useCallback(
    (short: string) => {
      const target = nodes.find((n) => nodeAgentShort(n) === short);
      if (target) setSelectedId(target.id);
    },
    // `nodes` identity changes on drag AND on domain switch — depend on it so the
    // jump always searches the current graph.
    [nodes],
  );

  // Real-time health from /api/agents/health (5-min window).
  // Replaces the legacy /api/workflow/active poll AND the hardcoded
  // status field on each NodeDef.
  const health = useAgentsHealth(4_000);

  // ★ v0_1_010: Inngest live overlay — for the 3 real PRA agents only.
  // wsId "4" (JDGenerator) / "9-1" (ResumeParser) / "10" (Matcher) become "live".
  // All other nodes are static blueprints (stub agents, not deployed).
  const liveOverlay = useInngestLiveOverlay();
  // The live overlay is keyed by recruitment wsIds (and reflects the recruitment
  // Inngest registry). Generated per-domain nodes reuse plain ontology ids that
  // can numerically collide with recruitment wsIds (e.g. "2"/"3"), so consulting
  // the overlay for other domains would falsely light them up. Gate it off.
  const liveByWsId = graph.isRecruitment ? liveOverlay.byWsId : EMPTY_LIVE_OVERLAY;

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
      <div className="flex items-center gap-3 border-b border-line bg-surface" style={{ padding: "14px 22px" }}>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold tracking-tight">
            {graph.isRecruitment
              ? t("wf_title")
              : `${friendlyDomainName(graph.domain)} · ${t("wfx_workflowWord")}`}
          </div>
          <div className="text-ink-3 text-[12px] mt-px">
            {graph.isRecruitment ? t("wf_sub") : t("wfx_domainWorkflowSub")}
          </div>
        </div>
        {/* Status cluster — health + version + registration counts read as one block */}
        <div className="flex items-center gap-2.5 shrink-0">
          <HeaderHealthSummary summary={summary} />
          {graph.isRecruitment ? (
            <Badge variant="info">{WORKFLOW_META.version} · {WORKFLOW_META.status}</Badge>
          ) : (
            <Badge variant="default">
              {graph.source === "allmeta" ? t("wfx_graphSrcOntology") : t("wfx_graphSrcSnapshot")}
            </Badge>
          )}
          <Link
            href="/monitor"
            className="text-[12px] text-accent hover:underline flex items-center gap-1"
            title={t("wfx_liveMonitorTip")}
          >
            <Ic.pulse /> {t("wfx_liveMonitor")}
          </Link>
          <div className="text-[11px] text-ink-3 mono">
            {graph.isRecruitment ? (
              <>
                <span className="text-ok font-semibold">{liveByWsId.size}</span> {t("wfx_registered")} ·{" "}
                <span className="text-ink-4">{nodes.filter(n => n.kind === "agent" && !liveByWsId.get(n.wsId)).length}</span> {t("wfx_blueprint")}
              </>
            ) : (
              // Other domains have no live recruitment registry; report the
              // ontology-derived node count instead of a misleading "registered".
              <>
                <span className="text-ink-4">{nodes.filter((n) => n.kind !== "trigger").length}</span> {t("wfx_blueprint")}
              </>
            )}
          </div>
        </div>
        <div className="w-px h-5 bg-line shrink-0" />
        <AgenticToggle />
        <div className="w-px h-5 bg-line shrink-0" />
        {/* Action cluster — secondary actions grouped tight, 发布 is the lone primary */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Btn size="sm"><Ic.clock /> {t("wfx_versionHistory")}</Btn>
          <Btn size="sm"><Ic.play /> {t("wfx_dryRun")}</Btn>
          <Btn variant="primary" size="sm">{t("wfx_publish")}</Btn>
        </div>
      </div>

      {/* work area */}
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "200px 1fr 300px" }}>
        {/* palette */}
        <aside className="border-r border-line bg-surface overflow-auto">
          <PaletteSection title={t("wfx_paletteTriggers")} items={[
            { icon: "bolt", label: t("wfx_trigRmsSync") },
            { icon: "plug", label: t("wfx_trigWebhook") },
            { icon: "calendar", label: t("wfx_trigRescan") },
            { icon: "mail", label: t("wfx_trigHsmManual") },
          ]} />
          <PaletteSection title={t("wfx_paletteAgents")} items={agentPaletteItems} />
          <PaletteSection title={t("wfx_paletteLogic")} items={[
            { icon: "branch", label: t("wfx_logicBranch") },
            { icon: "clock", label: t("wfx_logicWaitRetry") },
            { icon: "user", label: t("wfx_logicHsmApproval") },
            { icon: "shield", label: t("wfx_logicGuardrail") },
            { icon: "db", label: t("wfx_logicDistLock") },
          ]} />
          <PaletteSection title={t("wfx_paletteOutput")} items={[
            { icon: "plug", label: t("wfx_outChannelApi") },
            { icon: "mail", label: t("wfx_outPortalSubmit") },
            { icon: "db", label: t("wfx_outWriteKb") },
            { icon: "check", label: t("wfx_outDone") },
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
            ref={svgRef}
            viewBox={viewBox}
            preserveAspectRatio="xMidYMid meet"
            className="absolute inset-0 w-full h-full"
            style={{
              touchAction: "none",
              userSelect: "none",
              cursor: panning ? "grabbing" : "grab",
            }}
            onPointerDown={handleSvgPointerDown}
          >
            <defs>
              <marker id="arrowhead-b" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="var(--c-ink-3)" />
              </marker>
              <marker id="arrowhead-b-dim" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="var(--c-ink-4)" />
              </marker>
              <marker id="arrowhead-b-accent" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="var(--c-accent)" />
              </marker>
              <marker id="arrowhead-b-warn" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="var(--c-warn)" />
              </marker>
              <marker id="arrowhead-b-ok" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="var(--c-ok)" />
              </marker>
            </defs>

            {/* Stage column bands — recruitment-specific hand-tuned columns; the
                stage labels/positions only make sense for the 招聘 layout. */}
            {graph.isRecruitment && <StageBands width={graphDims.w} height={graphDims.h} />}

            {edges.map((e, i) => {
              const a = nodes.find((n) => n.id === e.from);
              const b = nodes.find((n) => n.id === e.to);
              if (!a || !b) return null;
              const sourceW = nodeWidths.get(a.id) ?? NODE_BASE_WIDTH;
              const ax = a.x + sourceW;
              const ay = a.y + NODE_HEIGHT / 2;
              const bx = b.x;
              const by = b.y + NODE_HEIGHT / 2;
              const mid = (ax + bx) / 2;
              const d = `M ${ax} ${ay} C ${mid} ${ay}, ${mid} ${by}, ${bx} ${by}`;

              // Every edge animates with marching dashes — the canvas reads as
              // a living pipeline. Active edges (leading into a live agent that
              // currently has running steps) flow faster + green; fallback
              // (e.dashed) edges flow slower and dimmer.
              const destLive = liveByWsId.get(b.wsId);
              const isActive = !!destLive && destLive.running > 0 && !destLive.paused;
              const isFallback = !!e.dashed;
              // Edge is in the selected node's "neighborhood" if either endpoint
              // is the selected node — it is always emphasized (in both modes).
              const isInNeighborhood = e.from === selectedId || e.to === selectedId;
              // Only focus mode fades the edges outside that neighborhood; overview
              // shows the full wiring at readable strength.
              const isFaded = focusMode && !isInNeighborhood;
              const strokeColor = isInNeighborhood
                ? "var(--c-accent)"
                : isActive
                  ? "var(--c-ok)"
                  : isFallback
                    ? "var(--c-warn)"
                    : "var(--c-ink-3)";
              const baseOpacity = isActive ? 0.95 : isFallback ? 0.7 : 0.78;
              const strokeOpacity = isInNeighborhood
                ? 0.98
                : isFaded
                  ? baseOpacity * 0.32
                  : baseOpacity;
              const strokeWidth = isInNeighborhood ? 2 : isActive ? 1.8 : isFallback ? 1.4 : 1.4;
              const dashPattern = isActive ? "8 4" : isFallback ? "3 5" : "6 5";
              // animation length = 2× cycle length → seamless wrap
              const dashTo = isActive ? -24 : isFallback ? -16 : -22;
              const animDur = isInNeighborhood
                ? "0.6s"
                : isActive
                  ? "0.6s"
                  : isFallback
                    ? "2.4s"
                    : "1.5s";

              return (
                <g key={i}>
                  <path
                    d={d}
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                    strokeDasharray={dashPattern}
                    strokeOpacity={strokeOpacity}
                    fill="none"
                    markerEnd={
                      isInNeighborhood
                        ? "url(#arrowhead-b-accent)"
                        : isFallback
                          ? "url(#arrowhead-b-warn)"
                          : isActive
                            ? "url(#arrowhead-b-ok)"
                            : "url(#arrowhead-b)"
                    }
                  >
                    <animate
                      attributeName="stroke-dashoffset"
                      from="0"
                      to={String(dashTo)}
                      dur={animDur}
                      repeatCount="indefinite"
                    />
                  </path>
                  {e.label && (
                    <g
                      transform={`translate(${mid} ${(ay + by) / 2 - 2})`}
                      opacity={isInNeighborhood ? 1 : isFaded ? 0.4 : 0.85}
                    >
                      <rect
                        x="-18" y="-8" width="36" height="14" rx="7"
                        fill="var(--c-bg)" opacity="0.95"
                      />
                      <text
                        x="0" y="3" textAnchor="middle" fontSize="9"
                        fontFamily="var(--f-sans)"
                        fill={
                          isInNeighborhood
                            ? "var(--c-accent)"
                            : isFallback
                              ? "var(--c-warn)"
                              : "var(--c-ink-3)"
                        }
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
              const liveAgent = liveByWsId.get(n.wsId) ?? null;
              // "Blueprint stub" (not-yet-deployed) is only a meaningful state for
              // recruitment, which has a live registry to compare against. For
              // generated domains every node is a blueprint, so don't fade them.
              const isBlueprintStub =
                graph.isRecruitment && n.kind === "agent" && !liveAgent;
              const isSelected = n.id === selectedId;
              const isNeighbor = neighborIds.has(n.id);
              // In overview every non-selected node stays at full strength; only
              // focus mode dims the cards outside the selected neighborhood.
              const highlight: NodeHighlight = isSelected
                ? "selected"
                : focusMode
                  ? isNeighbor
                    ? "neighbor"
                    : "dim"
                  : "normal";
              return (
                <WFNode
                  key={n.id}
                  node={n}
                  width={nodeWidths.get(n.id) ?? NODE_BASE_WIDTH}
                  liveHealth={liveHealth}
                  liveAgent={liveAgent}
                  isBlueprintStub={isBlueprintStub}
                  highlight={highlight}
                  dragging={draggingId === n.id}
                  onPointerDown={(e) => handleNodePointerDown(e, n.id)}
                />
              );
            })}
          </svg>

          {/* Per-domain graph status overlay — loading / load error / empty
              ontology. Recruitment never hits these (static graph). */}
          {!graph.isRecruitment && (graph.loading || graph.error || baseNodes.length === 0) && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-2 bg-surface/90 border border-line rounded-lg px-5 py-4 shadow-sh-1 pointer-events-auto">
                {graph.loading ? (
                  <>
                    <span className="animate-spin inline-block text-ink-3"><Ic.gear /></span>
                    <div className="text-[12.5px] text-ink-2">{t("wfx_graphLoading")}</div>
                  </>
                ) : graph.error ? (
                  <>
                    <span className="text-warn"><Ic.alert /></span>
                    <div className="text-[12.5px] text-ink-2">{t("wfx_graphError")}</div>
                    <div className="text-[11px] text-ink-4 mono max-w-[280px] truncate">{graph.error}</div>
                  </>
                ) : (
                  <>
                    <span className="text-ink-3"><Ic.workflow /></span>
                    <div className="text-[12.5px] text-ink-2">{t("wfx_graphEmpty")}</div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* view-mode toggle — 全局 (whole graph) vs 聚焦 (selected neighborhood) */}
          <div className="absolute top-3 right-3 flex gap-0.5 bg-surface border border-line rounded-md p-[3px] shadow-sh-1">
            <button
              type="button"
              onClick={() => setViewMode("overview")}
              title={t("wfx_viewGlobalTip")}
              className={`rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors cursor-pointer border-0 ${
                !focusMode ? "bg-accent-bg text-accent" : "bg-transparent text-ink-3 hover:text-ink-1"
              }`}
            >
              {t("wfx_viewGlobal")}
            </button>
            <button
              type="button"
              onClick={() => setViewMode("focus")}
              title={t("wfx_viewFocusTip")}
              className={`rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors cursor-pointer border-0 ${
                focusMode ? "bg-accent-bg text-accent" : "bg-transparent text-ink-3 hover:text-ink-1"
              }`}
            >
              {t("wfx_viewFocus")}
            </button>
          </div>

          {/* canvas chrome */}
          <div className="absolute top-3 left-3 flex gap-1.5 bg-surface border border-line rounded-md p-[3px] shadow-sh-1">
            <Btn size="sm" variant="ghost" style={{ height: 22, width: 22, padding: 0 }} title="undo">↶</Btn>
            <Btn size="sm" variant="ghost" style={{ height: 22, width: 22, padding: 0 }} title="redo">↷</Btn>
            <span className="w-px bg-line my-1" />
            <Btn
              size="sm"
              variant="ghost"
              style={{ height: 22, padding: "0 8px", fontSize: 11 }}
              title={t("wfx_resetLayoutTip")}
              onClick={resetLayout}
            >
              {t("wfx_resetLayout")}
            </Btn>
          </div>
          <div className="absolute bottom-3 left-3 flex gap-1.5 items-center bg-surface border border-line rounded-md mono text-[11px] text-ink-3 shadow-sh-1" style={{ padding: "3px 8px" }}>
            <Btn
              size="sm"
              variant="ghost"
              style={{ height: 22, width: 22, padding: 0 }}
              onClick={() => zoomBy(1 / 1.2)}
              title={t("wfx_zoomOut")}
            >
              −
            </Btn>
            <span className="tabular-nums" style={{ minWidth: 34, textAlign: "center" }}>
              {Math.round(view.scale * 100)}%
            </span>
            <Btn
              size="sm"
              variant="ghost"
              style={{ height: 22, width: 22, padding: 0 }}
              onClick={() => zoomBy(1.2)}
              title={t("wfx_zoomIn")}
            >
              +
            </Btn>
            <span className="w-px h-3 bg-line mx-1" />
            <button
              type="button"
              onClick={fitView}
              className="bg-transparent border-0 cursor-pointer text-ink-3 hover:text-ink-1"
              style={{ fontFamily: "inherit", fontSize: "inherit", padding: 0 }}
              title={t("wfx_resetView")}
            >
              fit
            </button>
          </div>
          <div className="absolute bottom-3 right-3 bg-surface border border-line rounded-md text-[11px] text-ink-3 shadow-sh-1 flex gap-2.5 items-center" style={{ padding: "6px 10px" }}>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-accent-bg border border-accent-line" /> {t("wfx_legendTrigger")}</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[color:color-mix(in_oklab,var(--c-accent)_15%,var(--c-surface))] border border-[color:color-mix(in_oklab,var(--c-accent)_45%,var(--c-line-strong))]" /> {t("wfx_legendAgent")}</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[color:var(--c-warn-bg)] border border-[color:color-mix(in_oklab,var(--c-warn)_40%,transparent)]" /> {t("wfx_legendHuman")}</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[color:var(--c-ok-bg)] border border-[color:color-mix(in_oklab,var(--c-ok)_30%,transparent)]" /> {t("wfx_legendGuard")}</span>
          </div>
        </div>

        {/* inspector */}
        <aside className="border-l border-line bg-surface flex flex-col min-h-0">
          {sel && (
            <Inspector
              node={sel}
              liveHealth={
                sel.kind === "agent"
                  ? health.byShort.get(nodeAgentShort(sel) ?? "") ?? null
                  : null
              }
              liveAgent={liveByWsId.get(sel.wsId) ?? null}
              isBlueprintStub={sel.kind === "agent" && !liveByWsId.get(sel.wsId)}
              onJumpToAgent={jumpToAgent}
            />
          )}
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

// Card sizing — base width is 140 (keeps short names visually consistent
// with the original design). Longer names auto-expand up to 200px; beyond
// that the label still ellipsizes inside the card. The Resume column was
// shifted right (workflow-graph-meta.ts ruleCheck x=1130) so widened cards
// don't collide with the next column.
const NODE_BASE_WIDTH = 140;
const NODE_MAX_WIDTH = 200;
const NODE_HEIGHT = 44;
// Approx px-per-char for the 11.5px medium-weight sans label. Slightly
// generous so two-word English names get a couple px of breathing room.
const APPROX_CHAR_PX = 6.5;
const NODE_LABEL_PADDING = 50; // icon (16) + left padding (11) + right padding (16) + buffer (7)

function computeNodeWidth(labelText: string): number {
  const w = Math.ceil(labelText.length * APPROX_CHAR_PX) + NODE_LABEL_PADDING;
  return Math.max(NODE_BASE_WIDTH, Math.min(NODE_MAX_WIDTH, w));
}

// Bilingual display name for a known agent/step short. The display_<short>
// i18n keys (zh + en) are the source of truth; fall back to the English Inngest
// name when no key exists.
function localizedAgentLabel(short: string, t: (k: string) => string): string {
  const key = `display_${short.toLowerCase()}`;
  const v = t(key);
  return v !== key ? v : agentDisplayName(short);
}

// Bilingual node description (display_<short>_desc) for recruitment nodes; falls
// back to the supplied raw text (ontology description / node.sub) otherwise.
function localizedNodeDesc(
  node: WorkflowNode,
  t: (k: string) => string,
  fallback: string,
): string {
  const key = `display_${node.title.toLowerCase()}_desc`;
  const v = t(key);
  return v !== key ? v : fallback;
}

// Human label for a node, localized to the active language.
//   - trigger node       → t("wfx_externalTrigger")
//   - recruitment node   → its title IS a known short ("Matcher", "JDReviewer"),
//                          so the bilingual display_<short> key applies.
//   - generated node     → the ontology action name (no i18n key) is kept as-is;
//                          it's domain data, not translatable UI chrome.
function nodeTitleLabel(
  node: WorkflowNode,
  t: (k: string) => string,
  lang: string,
): string {
  if (node.kind === "trigger") return t("wfx_externalTrigger");
  // Recruitment nodes carry a known short as their title → bilingual display_<short>.
  const key = `display_${node.title.toLowerCase()}`;
  const localized = t(key);
  if (localized !== key) return localized;
  // Generated-domain nodes: the builder humanizes the English `title` and, where
  // derivable, supplies a Chinese `titleZh`. Pick by language.
  if (lang === "zh" && node.titleZh) return node.titleZh;
  return node.title;
}

const HEALTH_TONE: Record<AgentHealthStatus, { color: string; label: string; pulse: boolean }> = {
  idle: { color: "var(--c-ink-4)", label: "idle", pulse: false },
  running: { color: "var(--c-ok)", label: "running", pulse: true },
  healthy: { color: "var(--c-ok)", label: "healthy", pulse: false },
  degraded: { color: "var(--c-warn)", label: "degraded", pulse: false },
  failed: { color: "var(--c-err)", label: "failed", pulse: true },
};

type NodeHighlight = "selected" | "neighbor" | "normal" | "dim";

function WFNode({
  node,
  width,
  liveHealth,
  liveAgent,
  isBlueprintStub,
  highlight,
  dragging,
  onPointerDown,
}: {
  node: WorkflowNode;
  width: number;
  liveHealth: AgentHealth | null;
  liveAgent: LiveAgentState | null;
  isBlueprintStub: boolean;
  highlight: NodeHighlight;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent<SVGGElement>) => void;
}) {
  const { t, lang } = useApp();
  const w = width;
  const h = NODE_HEIGHT;
  const selected = highlight === "selected";
  const isNeighbor = highlight === "neighbor";
  const isDim = highlight === "dim";
  // Blueprint stubs (recruitment, not-yet-deployed) read slightly softer so the
  // deployed agents stand out — but still clearly legible. Focus mode is the only
  // thing that meaningfully fades a card (the rest of the graph behind the
  // selected neighborhood).
  const stubOpacity = isBlueprintStub ? 0.7 : 1;
  const highlightOpacity = isDim ? 0.4 : 1;
  const renderOpacity = stubOpacity * highlightOpacity;
  const isLive = !!liveAgent && !liveAgent.paused;
  // Each kind gets a tinted fill, a saturated kind-colored border, an `accent`
  // (icon + chip color) and a `chip` (the rounded swatch behind the icon). The
  // chip is the main "更醒目" cue: every node type is identifiable at a glance,
  // even the agent cards that used to be plain white.
  const style = (() => {
    switch (node.kind) {
      case "trigger": return { fill: "var(--c-accent-bg)", stroke: "color-mix(in oklab, var(--c-accent) 55%, var(--c-line-strong))", accent: "var(--c-accent)", chip: "color-mix(in oklab, var(--c-accent) 22%, var(--c-surface))" };
      case "hitl": return { fill: "var(--c-warn-bg)", stroke: "color-mix(in oklab, var(--c-warn) 50%, var(--c-line-strong))", accent: "oklch(0.5 0.14 75)", chip: "color-mix(in oklab, var(--c-warn) 26%, var(--c-surface))" };
      case "guard": return { fill: "var(--c-ok-bg)", stroke: "color-mix(in oklab, var(--c-ok) 48%, var(--c-line-strong))", accent: "var(--c-ok)", chip: "color-mix(in oklab, var(--c-ok) 26%, var(--c-surface))" };
      case "branch": return { fill: "var(--c-panel)", stroke: "var(--c-line-strong)", accent: "var(--c-ink-2)", chip: "color-mix(in oklab, var(--c-ink-3) 16%, var(--c-surface))" };
      case "done": return { fill: "var(--c-raised)", stroke: "var(--c-line-strong)", accent: "var(--c-ink-3)", chip: "color-mix(in oklab, var(--c-ink-4) 16%, var(--c-surface))" };
      default: return { fill: isLive ? "color-mix(in oklab, var(--c-ok) 7%, var(--c-surface))" : "color-mix(in oklab, var(--c-accent) 5%, var(--c-surface))", stroke: isLive ? "color-mix(in oklab, var(--c-ok) 45%, var(--c-line-strong))" : "color-mix(in oklab, var(--c-accent) 32%, var(--c-line-strong))", accent: "var(--c-accent)", chip: "color-mix(in oklab, var(--c-accent) 15%, var(--c-surface))" };
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
      style={{
        cursor: dragging ? "grabbing" : "grab",
        opacity: renderOpacity,
        transition: dragging ? undefined : "opacity 180ms ease",
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      className="wf-node"
    >
      {/* Neighborhood halo — soft accent ring, drawn behind the selection ring.
          pointerEvents none so the halo (which extends beyond the rect) doesn't
          swallow clicks intended for the card or steal them from the SVG pan. */}
      {isNeighbor && (
        <rect
          x="-3" y="-3" width={w + 6} height={h + 6} rx="9"
          fill="none" stroke="var(--c-accent)" strokeWidth="1.5"
          strokeDasharray="4 3" opacity="0.7"
          pointerEvents="none"
        />
      )}
      {/* Selection: solid accent border ring — the strongest highlight. */}
      {selected && (
        <rect
          x="-3" y="-3" width={w + 6} height={h + 6} rx="9"
          fill="none" stroke="var(--c-accent)" strokeWidth="2.25" opacity="0.95"
          pointerEvents="none"
        />
      )}

      {/* Base card — the SOLE hit target for the node. Decorative children
          below all have pointerEvents="none" so clicks reliably reach this
          rect and bubble to the g's onPointerDown (which then calls
          stopPropagation to keep the SVG-level pan from firing). */}
      <rect
        x="0" y="0" width={w} height={h} rx="6"
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth="1.25"
        filter={isLive ? "drop-shadow(0 1px 3px color-mix(in oklab, var(--c-ok) 25%, transparent))" : undefined}
      />

      {/* Kind-colored icon chip — the at-a-glance type cue. */}
      <rect
        x="7" y={(h - 24) / 2} width="24" height="24" rx="7"
        fill={style.chip}
        stroke={style.accent}
        strokeOpacity="0.4"
        strokeWidth="1"
        pointerEvents="none"
      />

      {/* Icon — foreignObject was leaking pointer events; force them off so the
          rect underneath is what captures clicks. */}
      <foreignObject
        x="11"
        y={(h - 16) / 2}
        width="16"
        height="16"
        pointerEvents="none"
        style={{ pointerEvents: "none" }}
      >
        <div
          className="w-[16px] h-[16px] grid place-items-center"
          style={{ color: style.accent, pointerEvents: "none" }}
        >
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
        pointerEvents="none"
      >
        {nodeTitleLabel(node, t, lang)}
      </text>

      {/* Status dot (top-right) — pulse uses a soft breathing ripple */}
      {statusDot && (
        <g transform={`translate(${w - 11} 10)`} pointerEvents="none">
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
        <text
          x={w - 7} y={h - 5} textAnchor="end" fontSize="8.5" fill="var(--c-ink-4)"
          style={{ fontFamily: "var(--f-sans)" }}
          pointerEvents="none"
        >
          {t("wfx_blueprint")}
        </text>
      )}

      {/* Run count strip — corner, only for LIVE with traffic */}
      {liveAgent && liveAgent.total > 0 && !isBlueprintStub && (
        <text
          x={w - 7} y={h - 5} textAnchor="end" fontSize="9" fontWeight="500"
          fill="var(--c-ink-2)" style={{ fontFamily: "var(--f-mono)" }}
          pointerEvents="none"
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

const STAGE_BANDS: Array<{ x: number; w: number; labelKey: string; tint: string }> = [
  { x: 0,    w: 200,  labelKey: "wfx_stageTrigger",   tint: "color-mix(in oklab, var(--c-accent) 4%, transparent)" },
  { x: 200,  w: 280,  labelKey: "wfx_stageRequirement",   tint: "color-mix(in oklab, var(--c-ink-3) 3%, transparent)" },
  { x: 480,  w: 320,  labelKey: "wfx_stageJd",     tint: "color-mix(in oklab, oklch(0.7 0.12 80) 5%, transparent)" },
  { x: 800,  w: 320,  labelKey: "wfx_stageResume",   tint: "color-mix(in oklab, var(--c-info) 4%, transparent)" },
  { x: 1120, w: 280,  labelKey: "wfx_stageMatch",   tint: "color-mix(in oklab, var(--c-ok) 5%, transparent)" },
  { x: 1400, w: 320,  labelKey: "wfx_stageInterview", tint: "color-mix(in oklab, var(--c-warn) 4%, transparent)" },
  { x: 1720, w: 320,  labelKey: "wfx_stagePackage", tint: "color-mix(in oklab, var(--c-ink-3) 3%, transparent)" },
  { x: 2040, w: 160,  labelKey: "wfx_stageSubmit",   tint: "color-mix(in oklab, var(--c-accent) 4%, transparent)" },
];

function StageBands({ width: _width, height }: { width: number; height: number }) {
  const { t } = useApp();
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
            {t(b.labelKey)}
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
  const { t, lang } = useApp();
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
              <span className="text-[13px] font-semibold">{nodeTitleLabel(node, t, lang)}</span>
              {liveAgent && !liveAgent.paused && (
                <span className="text-[9px] mono font-bold px-1.5 py-0.5 rounded bg-ok-bg text-ok">● LIVE</span>
              )}
              {liveAgent?.paused && (
                <span className="text-[9px] mono font-bold px-1.5 py-0.5 rounded bg-warn-bg text-warn">⏸ PAUSED</span>
              )}
              {isBlueprintStub && (
                <span className="text-[9px] mono font-medium px-1.5 py-0.5 rounded border border-line text-ink-4">{t("wfx_blueprintNotDeployed")}</span>
              )}
            </div>
            <div className="text-ink-3 text-[11px]">{localizedNodeDesc(node, t, node.sub)}</div>
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
            ⚠ {t("wfx_bpWarn1")} <strong>{t("wfx_bpWarnBlueprint")}</strong> {t("wfx_bpWarn2")} <strong>{t("wfx_bpWarnNotDeployed")}</strong>{t("wfx_bpWarnPeriod")}
            <br />
            {t("wfx_bpWarnDefines")}
            <br />
            <br />
            {t("wfx_bpWarnDeployedLabel")}Create JD Agent · Resume Parser Agent · Match Resume Agent · Rule Check Agent。
            <Link href="/workflow-agents" className="text-accent hover:underline ml-1">
              → {t("wfx_bpWarnFullList")}
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
  const { t } = useApp();
  // Generated per-domain nodes carry their own canonical (built from the
  // ontology action); recruitment nodes look theirs up in CANONICAL_WORKFLOW.
  const canonical = node.canonical ?? CANONICAL_WORKFLOW.find((n) => n.id === node.wsId);

  // Trigger node — no canonical entry; render a friendly summary so the panel
  // doesn't look blank.
  if (!canonical) {
    return (
      <div className="border-b border-line" style={{ padding: "12px 16px" }}>
        <SectionLabel>{t("wfx_secNote")}</SectionLabel>
        <div className="text-ink-2" style={{ fontSize: 12, lineHeight: 1.6 }}>
          {node.sub || t("wfx_externalTriggerEntry")}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Description */}
      <div className="border-b border-line" style={{ padding: "12px 16px" }}>
        <SectionLabel>{t("wfx_secDescription")}</SectionLabel>
        <div className="text-ink-2" style={{ fontSize: 12, lineHeight: 1.6 }}>
          {localizedNodeDesc(node, t, canonical.description)}
        </div>
      </div>

      {/* Actor */}
      {canonical.actor && canonical.actor.length > 0 && (
        <div className="border-b border-line" style={{ padding: "12px 16px" }}>
          <SectionLabel>{t("wfx_secActor")}</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {canonical.actor.map((a) => (
              <span
                key={a}
                className="inline-flex items-center rounded border border-line bg-surface text-ink-2"
                style={{ padding: "2px 8px", fontSize: 11.5 }}
              >
                {a === "Agent" ? t("wfx_actorAgent") : a === "Human" ? t("wfx_actorHuman") : a}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Trigger events (what fires this step) */}
      {canonical.trigger && canonical.trigger.length > 0 && (
        <div className="border-b border-line" style={{ padding: "12px 16px" }}>
          <SectionLabel>{t("wfx_secTriggerEvents")} ({canonical.trigger.length})</SectionLabel>
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
          <SectionLabel>{t("wfx_secStepActions")} ({canonical.actions.length})</SectionLabel>
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
                      <span className="text-ink-4">{t("wfx_conditionLabel")}</span> {act.condition}
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
          <SectionLabel>{t("wfx_secEmittedEvents")} ({canonical.triggered_event.length})</SectionLabel>
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
  const { t } = useApp();
  const tone = health ? HEALTH_TONE[health.status] : null;
  const last = health?.lastActivityAt
    ? new Date(health.lastActivityAt).toLocaleTimeString(undefined, { hour12: false })
    : null;

  return (
    <div className="border-b border-line" style={{ padding: "10px 16px" }}>
      <div className="flex items-center mb-2 gap-2">
        <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold flex-1">
          {t("wfx_liveHealth")}
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
        <div className="text-[11px] text-ink-3">{t("wfx_loadingHealth")}</div>
      ) : (
        <>
          <div className="text-[10.5px] text-ink-3 mb-2">
            {t("wfx_pastWindowPrefix")} {Math.round((health.windowMs ?? 300_000) / 60_000)} {t("wfx_minuteWindow")} ·
            {last ? ` ${t("wfx_recentLabel")} ${last}` : ` ${t("wfx_noActivity")}`}
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
            {health.hasRunningStep && ` · ${t("wfx_hasRunningStep")}`}
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
  const { t } = useApp();
  const total = summary.running + summary.healthy + summary.degraded + summary.failed + summary.idle;
  if (total === 0) {
    return (
      <Badge variant="info" dot>
        {t("wfx_loadingAgentHealth")}
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
  const { t } = useApp();
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
          {t("wfx_aiExplain")}
        </div>
        {resp && (
          <Badge variant={resp.source === "llm" ? "ok" : "info"}>
            {resp.source === "llm" ? `via ${resp.modelUsed ?? "llm"}` : t("wfx_fallbackNoGateway")}
          </Badge>
        )}
      </div>

      {/* Always show the registry snapshot — it's instant and grounds the
          UI even before the LLM call returns. */}
      <div className="text-[12.5px] text-ink-1 leading-relaxed mb-2">{fn.summary}</div>
      <div className="grid gap-2 mb-2" style={{ gridTemplateColumns: "1fr" }}>
        <ExplainBlock title={t("wfx_typicalOps")} items={fn.operations} />
        <ExplainBlock title={t("wfx_calledTools")} items={fn.tools} />
        {fn.failureModes && fn.failureModes.length > 0 && (
          <ExplainBlock title={t("wfx_commonFailures")} items={fn.failureModes} muted />
        )}
      </div>

      {!resp && !loading && (
        <Btn size="sm" onClick={fetchExplain} variant="default">
          <Ic.sparkle /> {t("wfx_letAiExplain")}
        </Btn>
      )}
      {loading && (
        <div className="text-[11px] text-ink-3">{t("wfx_aiGenerating")}</div>
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
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border-b border-line" style={{ padding: "10px 16px" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full bg-transparent border-0 cursor-pointer flex items-center"
        style={{ padding: 0 }}
      >
        <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold flex-1 text-left">
          {t("wfx_runLogsAcrossRun")}
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
            emptyHint={`${short} ${t("wfx_logEmptyHint")}`}
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
