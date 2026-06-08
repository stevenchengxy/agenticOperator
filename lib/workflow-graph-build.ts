// Per-domain workflow graph builder.
//
// The recruitment (招聘) workflow graph is hand-positioned in
// `workflow-graph-meta.ts` (the authoritative 8-column layout shared with the
// Monitor subsystem). Every OTHER business domain (费控 / 能源调度 / …) has no
// hand-tuned layout — so we derive its DAG straight from the domain ontology and
// lay it out automatically, emitting nodes/edges in the IDENTICAL shape the
// Workflow canvas already renders (`WorkflowNode` / `WorkflowEdge`).
//
// Graph derivation mirrors the recruitment edge-building rule (and the events
// page's publisher/subscriber logic): an edge A→B exists when action A emits an
// event (A.triggered_event) that action B consumes (B.trigger). A synthetic
// `trig` node feeds every action whose trigger events have no producer (external
// entry points).
//
// Layout is a Sugiyama-lite layered assignment:
//   1. break cycles (human-review re-entry / back-edges) via DFS so layering has
//      a DAG to work on — back-edges are still drawn, just not used for ranking;
//   2. longest-path layering → column (x) per node;
//   3. barycenter ordering within each column → row (y), centered on the spine.

import type { IcName } from "@/components/shared/Ic";
import type {
  DomainOntology,
  OntologyAction,
} from "@/lib/ontology-generator/ontology-source";
import type {
  NodeKind,
  WorkflowNode,
  WorkflowEdge,
  WorkflowJsonNode,
} from "@/lib/workflow-graph-meta";
import { curatedZhLabel } from "@/lib/workflow-graph-zh-labels";

export type BuiltWorkflowGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  width: number;
  height: number;
};

// Coordinate system matches the recruitment layout so the renderer's fit/zoom
// math (which keys off a fixed GRAPH_WIDTH:GRAPH_HEIGHT window) behaves
// identically across domains.
const TRIG_ID = "trig";
const COL_X0 = 100;
const COL_GAP = 300;
const ROW_GAP = 150;
const SPINE_Y = 400;
const NODE_W = 260;
const NODE_H = 80;
const PAD = 100;

function pushMap<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

// Mirrors workflow-graph-meta.isExceptionalEvent: dashed = an error/abort path.
function isExceptionalEvent(eventName: string): boolean {
  return (
    eventName.endsWith("_FAILED") ||
    eventName.endsWith("_INCOMPLETE") ||
    eventName.endsWith("_REJECTED") ||
    eventName.endsWith("_ERROR") ||
    eventName.endsWith("_BLOCKED") ||
    eventName.endsWith("_CONFLICT") ||
    eventName.endsWith("_ALERT") ||
    eventName.endsWith("_DENIED") ||
    eventName.endsWith("_ABORTED")
  );
}

function isHumanOnly(actor: string[]): boolean {
  return actor.includes("Human") && !actor.includes("Agent");
}

function kindForAction(action: OntologyAction): NodeKind {
  return isHumanOnly(action.actor) ? "hitl" : "agent";
}

/** Keyword heuristic → icon. Covers EN + common CN ontology vocabulary. */
function iconForAction(action: OntologyAction): IcName {
  if (isHumanOnly(action.actor)) return "user";
  const s = `${action.name} ${action.description ?? ""} ${(action.tool_use ?? []).join(" ")}`.toLowerCase();
  if (/check|rule|guard|validat|verif|audit|审核|校验|合规|风控|稽核/.test(s)) return "shield";
  if (/notif|alert|mail|invite|send|dispatch|下发|通知|告警|派发|邮件/.test(s)) return "mail";
  if (/publish|integrat|channel|webhook|接口|发布|对接|推送/.test(s)) return "plug";
  if (/sync|collect|fetch|load|ingest|store|入库|采集|同步|抓取|拉取/.test(s)) return "db";
  if (/report|summar|package|document|报表|汇总|报告|台账/.test(s)) return "book";
  if (/forecast|predict|analy|generat|optimi|reason|decide|decision|预测|分析|生成|优化|决策|研判/.test(s)) return "sparkle";
  return "cpu";
}

/**
 * Humanize an ontology action `name` for English display:
 * camelCase / snake_case → spaced Title Case. Leaves already-spaced or CJK
 * names untouched. e.g. "forecastOutput" → "Forecast Output".
 */
export function humanizeName(name: string): string {
  if (!name) return name;
  if (/[一-鿿]/.test(name) || name.includes(" ")) return name;
  const spaced = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : name;
}

/**
 * Derive a concise Chinese node label from an action's (Chinese) description.
 * Generated ontologies have no Chinese name field, but some encode a label
 * after a "·" marker in the first sentence (e.g. "主链路第②段·出力预测。" → "出力预测").
 * Returns undefined when no clean short CJK label is present (e.g. descriptions
 * that are full sentences) — the caller then falls back to the humanized name.
 */
export function deriveZhLabel(description?: string): string | undefined {
  if (!description) return undefined;
  const firstSeg = description.split(/[。;；\n]/)[0] ?? "";
  if (!firstSeg.includes("·")) return undefined;
  const after = firstSeg
    .split("·")
    .pop()!
    .replace(/[(（][^)）]*[)）]?/g, "") // drop parentheticals like (OP-01)
    .trim();
  const hasCjk = /[一-鿿]/.test(after);
  const hasLongLatin = /[A-Za-z]{4,}/.test(after);
  if (after.length >= 1 && after.length <= 14 && hasCjk && !hasLongLatin) return after;
  return undefined;
}

function actionCanonical(action: OntologyAction): WorkflowJsonNode {
  const actor = action.actor.filter(
    (a): a is "Agent" | "Human" => a === "Agent" || a === "Human",
  );
  return {
    id: action.id,
    name: action.name,
    description: action.description ?? "",
    actor: actor.length ? actor : ["Agent"],
    trigger: action.trigger,
    actions: [],
    triggered_event: action.triggered_event,
  };
}

/** DFS back-edge detection so longest-path layering operates on a DAG. */
function findBackEdges(
  nodeIds: string[],
  succ: Map<string, string[]>,
): Set<string> {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const back = new Set<string>();
  // Iterative DFS (explicit stack) — avoids blowing the call stack on wide
  // ontologies and is fully deterministic.
  for (const root of nodeIds) {
    if ((color.get(root) ?? WHITE) !== WHITE) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: root, i: 0 }];
    color.set(root, GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const children = succ.get(top.id) ?? [];
      if (top.i < children.length) {
        const v = children[top.i++]!;
        const c = color.get(v) ?? WHITE;
        if (c === GRAY) {
          back.add(JSON.stringify([top.id, v]));
        } else if (c === WHITE) {
          color.set(v, GRAY);
          stack.push({ id: v, i: 0 });
        }
      } else {
        color.set(top.id, BLACK);
        stack.pop();
      }
    }
  }
  return back;
}

/**
 * Build a laid-out workflow graph from a domain ontology.
 * Pure + deterministic — same ontology in, same coordinates out.
 */
export function buildWorkflowGraph(onto: DomainOntology): BuiltWorkflowGraph {
  const actions = onto.actions ?? [];

  // De-dupe actions by id (snapshots occasionally repeat a node) and keep a
  // stable order for determinism.
  const seen = new Set<string>();
  const acts: OntologyAction[] = [];
  for (const a of actions) {
    if (!a || typeof a.id !== "string" || seen.has(a.id)) continue;
    seen.add(a.id);
    acts.push(a);
  }

  // The synthetic trigger node needs an id that doesn't collide with any real
  // action id (an ontology *could* contain an action literally named "trig").
  // Fall back to a reserved sentinel only on collision so the common case keeps
  // the stable "trig" id the canvas selects by default.
  let trigId = TRIG_ID;
  while (seen.has(trigId)) trigId = `__${trigId}__`;

  // ── producer / consumer maps ────────────────────────────────────────────
  const consumersByEvent = new Map<string, string[]>(); // event → action ids consuming it
  const producersByEvent = new Map<string, string[]>(); // event → action ids emitting it
  for (const a of acts) {
    for (const ev of a.trigger ?? []) pushMap(consumersByEvent, ev, a.id);
    for (const ev of a.triggered_event ?? []) pushMap(producersByEvent, ev, a.id);
  }

  // ── edges ───────────────────────────────────────────────────────────────
  type RawEdge = { from: string; to: string; eventName: string };
  const rawEdges: RawEdge[] = [];
  const edgeSeen = new Set<string>();
  const addEdge = (from: string, to: string, eventName: string) => {
    const key = JSON.stringify([from, to, eventName]);
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    rawEdges.push({ from, to, eventName });
  };

  for (const a of acts) {
    for (const ev of a.triggered_event ?? []) {
      for (const consumerId of consumersByEvent.get(ev) ?? []) {
        if (consumerId === a.id) continue; // skip self-loops (visually degenerate)
        addEdge(a.id, consumerId, ev);
      }
    }
  }

  // Synthetic trigger → every action whose trigger events have no producer
  // (external entry points), and every action with no triggers at all (roots).
  for (const a of acts) {
    const triggers = a.trigger ?? [];
    const external = triggers.filter((ev) => !producersByEvent.has(ev));
    if (triggers.length === 0) {
      addEdge(trigId, a.id, "");
    } else {
      for (const ev of external) addEdge(trigId, a.id, ev);
    }
  }

  const nodeIds = [trigId, ...acts.map((a) => a.id)];

  // ── layering (longest-path on a cycle-broken DAG) ───────────────────────
  const succ = new Map<string, string[]>();
  for (const e of rawEdges) pushMap(succ, e.from, e.to);
  const back = findBackEdges(nodeIds, succ);
  const fwd = rawEdges.filter((e) => !back.has(JSON.stringify([e.from, e.to])));

  const layer = new Map<string, number>();
  for (const id of nodeIds) layer.set(id, 0);
  // Relax over forward edges; converges in ≤ |V| passes on a DAG.
  for (let pass = 0; pass < nodeIds.length; pass++) {
    let changed = false;
    for (const e of fwd) {
      const next = layer.get(e.from)! + 1;
      if (layer.get(e.to)! < next) {
        layer.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Keep `trig` alone in column 0: isolated actions (no incoming forward edge)
  // would otherwise collide with it.
  for (const a of acts) {
    if ((layer.get(a.id) ?? 0) === 0) layer.set(a.id, 1);
  }

  // ── coordinate assignment (barycenter ordering within each column) ──────
  const fwdPred = new Map<string, string[]>();
  for (const e of fwd) pushMap(fwdPred, e.to, e.from);

  const byLayer = new Map<number, string[]>();
  let maxLayer = 0;
  for (const id of nodeIds) {
    const L = layer.get(id)!;
    pushMap(byLayer, L, id);
    if (L > maxLayer) maxLayer = L;
  }

  const pos = new Map<string, { x: number; y: number }>();
  for (let L = 0; L <= maxLayer; L++) {
    const ids = byLayer.get(L) ?? [];
    const ordered = ids
      .map((id) => {
        const ys = (fwdPred.get(id) ?? [])
          .map((p) => pos.get(p)?.y)
          .filter((y): y is number => typeof y === "number");
        const bary = ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : SPINE_Y;
        return { id, bary };
      })
      .sort((a, b) => a.bary - b.bary || a.id.localeCompare(b.id));

    const n = ordered.length;
    const y0 = SPINE_Y - ((n - 1) * ROW_GAP) / 2;
    ordered.forEach((o, i) => {
      pos.set(o.id, { x: COL_X0 + L * COL_GAP, y: y0 + i * ROW_GAP });
    });
  }

  // A tall column centers on SPINE_Y and can push rows above the canvas (y < 0).
  // Shift the whole graph so the topmost node sits at a positive baseline — keeps
  // every coordinate positive and makes the from-origin bbox dims below correct.
  let minY = Infinity;
  for (const p of pos.values()) if (p.y < minY) minY = p.y;
  if (Number.isFinite(minY) && minY < PAD) {
    const dy = PAD - minY;
    for (const [id, p] of pos) pos.set(id, { x: p.x, y: p.y + dy });
  }

  // ── nodes ───────────────────────────────────────────────────────────────
  const entryEvents = Array.from(
    new Set(
      rawEdges
        .filter((e) => e.from === trigId && e.eventName)
        .map((e) => e.eventName),
    ),
  );
  const trigPos = pos.get(trigId) ?? { x: COL_X0, y: SPINE_Y };
  const nodes: WorkflowNode[] = [
    {
      id: trigId,
      wsId: trigId,
      kind: "trigger",
      x: trigPos.x,
      y: trigPos.y,
      title: "外部触发",
      sub: entryEvents.slice(0, 3).join(" / ") || "外部事件入口",
      icon: "bolt",
      deployment: "conceptual",
    },
  ];
  for (const a of acts) {
    const p = pos.get(a.id) ?? { x: COL_X0 + COL_GAP, y: SPINE_Y };
    nodes.push({
      id: a.id,
      wsId: a.id,
      kind: kindForAction(a),
      x: p.x,
      y: p.y,
      title: humanizeName(a.name),
      // Prefer the curated per-domain Chinese label; fall back to a label parsed
      // from the description's "·" marker. Undefined → canvas shows humanized EN.
      titleZh: curatedZhLabel(onto.domainId, a.name) ?? deriveZhLabel(a.description),
      sub: (a.description ?? "").slice(0, 100),
      icon: iconForAction(a),
      deployment: isHumanOnly(a.actor) ? "conceptual" : "stubbed",
      canonical: actionCanonical(a),
    });
  }

  // ── edges (renderer shape) ──────────────────────────────────────────────
  const edges: WorkflowEdge[] = rawEdges.map((e) => ({
    from: e.from,
    to: e.to,
    eventName: e.eventName,
    dashed: e.eventName ? isExceptionalEvent(e.eventName) : false,
  }));

  // ── bbox → canvas window dims ───────────────────────────────────────────
  // The Workflow canvas uses width/height as the pan/zoom WINDOW (aspect +
  // scale baseline). Returning the graph's own bbox (rather than reusing
  // recruitment's 2350×800) lets fit-view fill the viewport for any shape.
  let maxX = 0;
  let maxY = 0;
  for (const p of pos.values()) {
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const width = maxX + NODE_W + PAD;
  const height = maxY + NODE_H + PAD;

  return { nodes, edges, width, height };
}
