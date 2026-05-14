import type { IcName } from '@/components/shared/Ic';
import workflowJson from './workflow-canonical.json';

// ─── Canonical workflow types (sourced from allmetaOntology) ──────────────────

export type WorkflowJsonNode = {
  id: string;
  name: string;
  description: string;
  actor: ('Agent' | 'Human')[];
  trigger: string[];
  actions: Array<{
    order: string;
    name: string;
    description: string;
    type: 'manual' | 'tool' | 'logic';
    condition: string;
  }>;
  triggered_event: string[];
};

/** All 22 nodes from the authoritative workflow spec. */
export const CANONICAL_WORKFLOW: WorkflowJsonNode[] = workflowJson as WorkflowJsonNode[];

// ─── Graph layout + node type ─────────────────────────────────────────────────
//
// 22 real workflow nodes + 1 synthetic `trig` node for the external trigger.
// NODES + EDGES are derived programmatically from CANONICAL_WORKFLOW combined
// with the visual layout table (NODE_LAYOUT) below.
//
// NODE_LAYOUT keys:
//   id     — camelCase, matches existing convention (used by EDGES + tests)
//   wsId   — workflow-canonical.json `id` field; 'trig' for the synthetic node
//
// Deployment status:
//   deployed    — real Inngest function in resume-parser-agent
//   stubbed     — AO-main stub-factory handles it
//   conceptual  — actor=Human in canonical JSON; no Inngest function exists
//
// ViewBox: 1920×720 — extra canvas gives breathing room for HITL branches.
//
// Layout overview (left-to-right main path, fallbacks below/offset):
//
//   Row A (y=100): trig → reqSync → reqAnalyzer → clarifier → jdGenerator
//                 → jdReviewer → taskAssigner → publisher → resumeCollector
//                 → resumeParser → matcher (x=1820; fits within 1920 viewBox)
//
//   Row B (y=460): portalSubmitter ← packageReviewer ← packageBuilder ←
//                 resumeRefiner ← evaluator ← aiInterviewer ← interviewInviter
//                 (uniformly ~180px spaced; interviewInviter x=1820 aligned with matcher)
//
//   HITL offsets (y=280 row, 4 nodes):
//     manualEntry    (x=400,  y=280) — directly below reqAnalyzer(400,100); short vertical edge
//     reClarifier    (x=580,  y=280) — CLARIFICATION_INCOMPLETE → CLARIFICATION_RETRY
//     manualPublish  (x=1300, y=280) — fallback: CHANNEL_PUBLISHED_FAILED
//     resumeFixer    (x=1700, y=280) — fallback: RESUME_PARSE_ERROR
//     packageFiller  (x=1100, y=620) — fallback: PACKAGE_MISSING_INFO
//
// ─────────────────────────────────────────────────────────────────────────────

export type NodeKind = 'trigger' | 'agent' | 'branch' | 'hitl' | 'guard' | 'done';

/** wsIds owned by resume-parser-agent (real deployed Inngest functions). */
const RPA_OWNED_WSIDS = new Set(['4', '9-1', '10']);

export type WorkflowNode = {
  id: string;
  wsId: string;
  kind: NodeKind;
  x: number;
  y: number;
  title: string;
  sub: string;
  icon: IcName;
  /**
   * Canonical agent short name as it appears in AgentActivity.agentName.
   * Only set when the display `title` differs from the agent's registered short.
   * Falls back to `title` when absent.
   */
  agentName?: string;
  /**
   * Deployment status:
   * - deployed   = real Inngest agent in resume-parser-agent
   * - stubbed    = AO-main stub-factory
   * - conceptual = Human actor, no Inngest function
   */
  deployment: 'deployed' | 'stubbed' | 'conceptual';
  /** Raw canonical JSON node, if this wsId exists in the workflow spec. */
  canonical?: WorkflowJsonNode;
};

export type WorkflowEdge = {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  /** Inngest event name flowing along this edge. Populated for all non-dashed edges
   *  and most dashed edges. Empty string = no specific event (e.g., guard → submit). */
  eventName?: string;
};

// 1920×720 viewBox — expanded for 22-agent layout with HITL branches.
export const GRAPH_VIEWBOX = '0 0 1920 720' as const;
export const GRAPH_WIDTH = 1920 as const;
export const GRAPH_HEIGHT = 720 as const;

// ── NODE_LAYOUT ───────────────────────────────────────────────────────────────
// Visual positions + icon per node. wsId links each entry to CANONICAL_WORKFLOW.
// Order here determines NODES array order.

type NodeLayout = {
  id: string;
  wsId: string;
  x: number;
  y: number;
  kind: NodeKind;
  icon: IcName;
};

const NODE_LAYOUT: NodeLayout[] = [
  // ── Trigger (synthetic) ──────────────────────────────────────────────────
  { id: 'trig',             wsId: 'trig',  x: 60,   y: 100, kind: 'trigger', icon: 'bolt'     },

  // ── Row A: main path ─────────────────────────────────────────────────────
  { id: 'reqSync',          wsId: '1-1',   x: 220,  y: 100, kind: 'agent',   icon: 'db'       },
  { id: 'reqAnalyzer',      wsId: '2',     x: 400,  y: 100, kind: 'agent',   icon: 'sparkle'  },
  { id: 'clarifier',        wsId: '3',     x: 580,  y: 100, kind: 'agent',   icon: 'sparkle'  },
  { id: 'jdGenerator',      wsId: '4',     x: 760,  y: 100, kind: 'agent',   icon: 'sparkle'  },
  { id: 'jdReviewer',       wsId: '5',     x: 940,  y: 100, kind: 'hitl',    icon: 'shield'   },
  { id: 'taskAssigner',     wsId: '6',     x: 1120, y: 100, kind: 'agent',   icon: 'cpu'      },
  { id: 'publisher',        wsId: '7-1',   x: 1300, y: 100, kind: 'agent',   icon: 'plug'     },
  { id: 'resumeCollector',  wsId: '8',     x: 1500, y: 100, kind: 'hitl',    icon: 'db'       },  // actor=Human
  { id: 'resumeParser',     wsId: '9-1',   x: 1700, y: 100, kind: 'agent',   icon: 'cpu'      },
  { id: 'matcher',          wsId: '10',    x: 1820, y: 100, kind: 'agent',   icon: 'sparkle'  },  // x: 1860→1820 to avoid right-edge overflow

  // ── HITL offsets (between A and B) ───────────────────────────────────────
  // y=280 row: manualEntry(400), reClarifier(580), manualPublish(1300), resumeFixer(1700) — 4 nodes, 200-1120px spacing
  { id: 'manualEntry',      wsId: '1-2',   x: 400,  y: 280, kind: 'hitl',    icon: 'user'     },  // moved from (580,580): directly below reqAnalyzer(400,100)
  { id: 'reClarifier',      wsId: '3-2',   x: 580,  y: 280, kind: 'hitl',    icon: 'user'     },  // per canonical JSON
  { id: 'manualPublish',    wsId: '7-2',   x: 1300, y: 280, kind: 'hitl',    icon: 'user'     },
  { id: 'resumeFixer',      wsId: '9-2',   x: 1700, y: 280, kind: 'hitl',    icon: 'user'     },

  // ── Row B: post-matching path ─────────────────────────────────────────────
  // Uniformly spaced ~180px apart; interviewInviter aligned with matcher(1820)
  { id: 'interviewInviter', wsId: '11-1',  x: 1820, y: 460, kind: 'agent',   icon: 'mail'     },  // moved from (1860,300): top of Row B, aligned with matcher
  { id: 'aiInterviewer',    wsId: '11-2',  x: 1640, y: 460, kind: 'hitl',    icon: 'sparkle'  },  // actor=Human (candidate self-serve)
  { id: 'evaluator',        wsId: '12',    x: 1460, y: 460, kind: 'agent',   icon: 'cpu'      },
  { id: 'resumeRefiner',    wsId: '13',    x: 1280, y: 460, kind: 'agent',   icon: 'sparkle'  },
  { id: 'packageBuilder',   wsId: '14-1',  x: 1100, y: 460, kind: 'agent',   icon: 'book'     },
  { id: 'packageReviewer',  wsId: '15',    x: 920,  y: 460, kind: 'hitl',    icon: 'shield'   },
  { id: 'portalSubmitter',  wsId: '16',    x: 740,  y: 460, kind: 'agent',   icon: 'mail'     },

  // ── HITL fallbacks (below B) ──────────────────────────────────────────────
  { id: 'packageFiller',    wsId: '14-2',  x: 1100, y: 620, kind: 'hitl',    icon: 'user'     },
];

// ── Build NODES from layout + canonical JSON ──────────────────────────────────

const CANONICAL_BY_WSID: Map<string, WorkflowJsonNode> = new Map(
  CANONICAL_WORKFLOW.map(n => [n.id, n])
);

/**
 * Display title override per wsId.
 * The canonical JSON's `name` field uses its own naming convention (camelCase).
 * We keep the existing AGENT_MAP `short` names as display titles to maintain
 * compatibility with all existing tests, monitoring, and agent-descriptions lookups.
 */
const TITLE_BY_WSID: Record<string, string> = {
  'trig':  '外部触发',
  '1-1':   'ReqSync',
  '1-2':   'ManualEntry',
  '2':     'ReqAnalyzer',
  '3':     'Clarifier',
  '3-2':   'ReClarifier',
  '4':     'JDGenerator',
  '5':     'JDReviewer',
  '6':     'TaskAssigner',
  '7-1':   'Publisher',
  '7-2':   'ManualPublish',
  '8':     'ResumeCollector',
  '9-1':   'ResumeParser',
  '9-2':   'ResumeFixer',
  '10':    'Matcher',
  '11-1':  'InterviewInviter',
  '11-2':  'AIInterviewer',
  '12':    'Evaluator',
  '13':    'ResumeRefiner',
  '14-1':  'PackageBuilder',
  '14-2':  'PackageFiller',
  '15':    'PackageReviewer',
  '16':    'PortalSubmitter',
};

function deriveDeployment(wsId: string, canonical: WorkflowJsonNode | undefined): WorkflowNode['deployment'] {
  if (wsId === 'trig') return 'conceptual';
  if (RPA_OWNED_WSIDS.has(wsId)) return 'deployed';
  if (canonical?.actor[0] === 'Human') return 'conceptual';
  return 'stubbed';
}

export const NODES: WorkflowNode[] = NODE_LAYOUT.map(layout => {
  const canonical = CANONICAL_BY_WSID.get(layout.wsId);
  const title = TITLE_BY_WSID[layout.wsId] ?? layout.id;
  return {
    id: layout.id,
    wsId: layout.wsId,
    kind: layout.kind,
    x: layout.x,
    y: layout.y,
    icon: layout.icon,
    title,
    sub: canonical?.description.slice(0, 100) ?? (layout.wsId === 'trig' ? 'SCHEDULED_SYNC / Webhook' : ''),
    deployment: deriveDeployment(layout.wsId, canonical),
    canonical,
  };
});

// ── Build EDGES from canonical trigger/triggered_event arrays ─────────────────

const EDGE_LABEL_MAP: Record<string, string> = {
  'CLARIFICATION_INCOMPLETE':    '缺失',
  'CLARIFICATION_READY':         'OK',
  'JD_REJECTED':                 '驳回',
  'JD_APPROVED':                 '通过',
  'CHANNEL_PUBLISHED_FAILED':    '发布失败',
  'RESUME_PARSE_ERROR':          '解析失败',
  'MATCH_PASSED_NEED_INTERVIEW': '需面试',
  'MATCH_PASSED_NO_INTERVIEW':   '免面',
  'MATCH_FAILED':                '不匹配',
  'PACKAGE_MISSING_INFO':        '缺信息',
};

function isExceptionalEvent(eventName: string): boolean {
  return (
    eventName.endsWith('_FAILED') ||
    eventName.endsWith('_INCOMPLETE') ||
    eventName.endsWith('_REJECTED') ||
    eventName.endsWith('_ERROR') ||
    eventName.endsWith('_BLOCKED') ||
    eventName.endsWith('_CONFLICT') ||
    eventName.endsWith('_ALERT')
  );
}

function buildEdges(): WorkflowEdge[] {
  const edges: WorkflowEdge[] = [];

  // Build a map: eventName → list of node ids that consume it
  const CONSUMER_BY_EVENT: Map<string, string[]> = new Map();
  for (const layout of NODE_LAYOUT) {
    if (layout.wsId === 'trig') continue;
    const canonical = CANONICAL_BY_WSID.get(layout.wsId);
    if (!canonical) continue;
    for (const ev of canonical.trigger) {
      if (!CONSUMER_BY_EVENT.has(ev)) CONSUMER_BY_EVENT.set(ev, []);
      CONSUMER_BY_EVENT.get(ev)!.push(layout.id);
    }
  }

  // Synthetic trigger node → nodes subscribed to SCHEDULED_SYNC
  const externalTriggerEvents = ['SCHEDULED_SYNC'];
  for (const ev of externalTriggerEvents) {
    for (const consumerId of CONSUMER_BY_EVENT.get(ev) ?? []) {
      edges.push({
        from: 'trig',
        to: consumerId,
        eventName: ev,
        dashed: false,
      });
    }
  }

  // For each emitting node, find consumers of its emitted events
  for (const layout of NODE_LAYOUT) {
    if (layout.wsId === 'trig') continue;
    const canonical = CANONICAL_BY_WSID.get(layout.wsId);
    if (!canonical) continue;

    for (const emittedEvent of canonical.triggered_event) {
      const consumers = CONSUMER_BY_EVENT.get(emittedEvent) ?? [];
      for (const consumerId of consumers) {
        const dashed = isExceptionalEvent(emittedEvent);
        edges.push({
          from: layout.id,
          to: consumerId,
          eventName: emittedEvent,
          dashed,
          label: EDGE_LABEL_MAP[emittedEvent],
        });
      }
    }
  }

  return edges;
}

export const EDGES: WorkflowEdge[] = buildEdges();

// ── Helpers ───────────────────────────────────────────────────────────────────

const NODE_BY_ID = new Map(NODES.map(n => [n.id, n]));
export function nodeById(id: string): WorkflowNode | undefined {
  return NODE_BY_ID.get(id);
}

// ── Terminal events ───────────────────────────────────────────────────────────
// Events that are emitted by at least one node but consumed by no node in the
// graph. These represent terminal states in the workflow (e.g. MATCH_FAILED,
// APPLICATION_SUBMITTED). Exposed for informational / future visual use.

function computeTerminalEvents(): Set<string> {
  const allEmits = new Set<string>();
  const consumed = new Set<string>();
  for (const layout of NODE_LAYOUT) {
    if (layout.wsId === 'trig') continue;
    const c = CANONICAL_BY_WSID.get(layout.wsId);
    if (!c) continue;
    for (const ev of c.triggered_event) allEmits.add(ev);
    for (const ev of c.trigger) consumed.add(ev);
  }
  const terminal = new Set<string>();
  for (const ev of allEmits) {
    if (!consumed.has(ev)) terminal.add(ev);
  }
  return terminal;
}

/** Events emitted by workflow nodes that have no consumer in the graph.
 *  These are terminal states — e.g. MATCH_FAILED, APPLICATION_SUBMITTED.
 *  Currently informational; can drive visual terminal-state indicators in future. */
export const TERMINAL_EVENTS: Set<string> = computeTerminalEvents();
