import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { NODES, EDGES } from '@/lib/workflow-graph-meta';
import { parseFilter } from '@/lib/monitor/filters';
import {
  pickNodeStatus,
  sumTokensFromActivities,
  buildEdgeAggregates,
  safeParse,
} from '@/lib/monitor/aggregations';
import type {
  MonitorOverviewResponse,
  MonitorNodeAgg,
  MonitorFailureRow,
  MonitorHitlRow,
  MonitorRunRow,
  MonitorKpi,
} from '@/lib/monitor/types';

// ── /api/monitor/overview ────────────────────────────────────────
//
// The single endpoint that drives the /monitor main page. Returns ~30KB
// of aggregate JSON describing the entire workflow's current state, all
// 18 node aggregates, all 18 edge volumes, top-20 failures, top-20 HITL
// pending, top-12 recent runs.
//
// Polling: client polls every 4s. Endpoint internally caches at 1s TTL
// to coalesce burst polls under load (see CACHE constant).
//
// Tokens come from AgentActivity rows where type='tool' (the path
// server/llm/instrumented.ts withLlmTelemetry uses). AgentEpisode is
// not consulted on main — it's currently unwritten. When agents move
// in-process and start writing AgentEpisode, prefer it for accuracy.

const CACHE_TTL_MS = 1_000;
let cachedAt = 0;
let cachedKey = '';
let cachedBody: MonitorOverviewResponse | null = null;

// Test-only reset hook. Call from beforeEach in route.test.ts to ensure
// cached state doesn't leak across tests. Underscore-prefixed by
// convention so it's clearly not part of the public route API.
export function _resetCacheForTest(): void {
  cachedAt = 0;
  cachedKey = '';
  cachedBody = null;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filter = parseFilter(url);
  const cacheKey = `${filter.sinceMs}|${filter.client ?? ''}|${filter.triggerEvent ?? ''}|${filter.status ?? ''}`;

  if (cachedBody && cacheKey === cachedKey && Date.now() - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cachedBody);
  }

  try {
    const since = new Date(filter.since);

    // 1) Run-level aggregates
    const recentRunRowsWhere: Record<string, unknown> = {};
    if (filter.status)       recentRunRowsWhere.status = filter.status;
    if (filter.triggerEvent) recentRunRowsWhere.triggerEvent = filter.triggerEvent;
    // filter.client lives inside triggerData JSON; SQLite + Prisma can't
    // path-query JSON cleanly, so client-level filtering is deferred.
    // TODO: implement post-fetch filter or raw query for filter.client.
    // The cache key already includes client so per-filter caching is correct.

    const [activeRunsCount, recentRunRows] = await Promise.all([
      prisma.workflowRun.count({ where: { status: 'running' } }),
      prisma.workflowRun.findMany({
        where: Object.keys(recentRunRowsWhere).length > 0 ? recentRunRowsWhere : undefined,
        orderBy: { lastActivityAt: 'desc' },
        take: 20,
        select: { id: true, status: true, triggerEvent: true, triggerData: true, startedAt: true, lastActivityAt: true },
      }),
    ]);

    // 2) Activity-level rows (the meat — per-agent rollups derive from this)
    const activities = await prisma.agentActivity.findMany({
      where: { createdAt: { gte: since } },
      select: { agentName: true, type: true, metadata: true, createdAt: true, runId: true, narrative: true },
    });

    // 3) HITL pending
    const hitlPendingRows = await prisma.humanTask.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 200,                                         // enough to bucket per-node
      select: { id: true, runId: true, nodeId: true, title: true, createdAt: true, deadline: true },
    });

    // 4) Event instances (drives edge counts + queue lag)
    const eventInstances = await prisma.eventInstance.findMany({
      where: { ts: { gte: since } },
      select: { name: true, ts: true, status: true },
    });

    // ── KPI rollup ─────────────────────────────────────────────
    const failuresAll = activities.filter(a => a.type === 'agent_error' || a.type === 'anomaly');
    const tokensTotal = sumTokensFromActivities(activities.filter(a => a.type === 'tool'));

    const kpi: MonitorKpi = {
      activeRuns: activeRunsCount,
      pendingHitl: hitlPendingRows.length,
      failuresInWindow: failuresAll.length,
      tokensInWindow: tokensTotal.total,
      queueDepth: eventInstances.filter(e => e.status === 'accepted').length,
      queueLagP50Ms: null,   // not yet measured; route returns null until lag tracking lands
      queueLagP95Ms: null,
    };

    // ── Per-node aggregates ────────────────────────────────────
    // We key node aggregates by NODES[i].id, which equals the workflow
    // canvas short name (e.g. "jd"). AGENT_MAP.short uses the canonical
    // agent label (e.g. "JDGenerator"). Map by hand: NODES[i].title
    // happens to include the agent short OR a non-agent label like
    // "信息完整?". For NON-agent nodes (branches/HITL/done/trigger), the
    // aggregate is empty but the row still exists so the UI can render
    // 18 nodes regardless.

    const titleToActivity = new Map<string, typeof activities>();
    for (const a of activities) {
      const list = titleToActivity.get(a.agentName) ?? [];
      list.push(a);
      titleToActivity.set(a.agentName, list);
    }

    const tenSecAgo = new Date(Date.now() - 10_000);

    const nodes: MonitorNodeAgg[] = NODES.map(n => {
      // Match by agentName when present (e.g. parse node has title
      // "ResumeParser + DupeCheck" but canonical agentName "ResumeParser").
      // Falls back to title for nodes where the two are identical.
      // Branch / hitl / done nodes never match an agent name -> empty rows.
      const rows = titleToActivity.get(n.agentName ?? n.title) ?? [];
      const completedInWindow = rows.filter(r => r.type === 'agent_complete').length;
      const failedInWindow = rows.filter(r => r.type === 'agent_error' || r.type === 'anomaly').length;
      const tokens = sumTokensFromActivities(rows.filter(r => r.type === 'tool'));
      const running = rows.filter(r => r.type === 'agent_start').length - completedInWindow - failedInWindow;
      const queueDepth = 0; // populated when we track per-agent backlog (Phase 7 queue page)
      const hitlPending = hitlPendingRows.filter(h => h.nodeId === n.id || h.nodeId === n.title).length;
      const total = completedInWindow + failedInWindow;
      const successRate1h = total > 0 ? completedInWindow / total : 1;
      const pulse = rows.some(r => r.createdAt >= tenSecAgo);
      return {
        name: n.id,
        running: Math.max(0, running),
        completedInWindow,
        failedInWindow,
        hitlPending,
        successRate1h,
        queueDepth,
        tokensInWindow: tokens,
        avgDurationMs: 0,    // populated in a later pass; spec accepts placeholder
        status: pickNodeStatus({ running: Math.max(0, running), completedInWindow, failedInWindow, queueDepth }),
        pulse,
      };
    });

    // ── Edges (event volumes) ──────────────────────────────────
    // EDGES doesn't carry an eventName today — they used to be drawn just
    // as a layout aid. To compute volume we attach an eventName-per-edge
    // mapping inline here (small table). When EDGES grows an eventName
    // field, drop this lookup.
    const EDGE_EVENT: Record<string, string | null> = {
      'trig->sync':       'SCHEDULED_SYNC',
      'sync->analyze':    'REQUIREMENT_SYNCED',
      'analyze->clarify': 'ANALYSIS_COMPLETED',
      'clarify->jd':      'CLARIFICATION_READY',
      'clarify->ask':     'CLARIFICATION_INCOMPLETE',
      'ask->analyze':     'REQUIREMENT_LOGGED',
      'jd->jdappr':       'JD_GENERATED',
      'jdappr->publish':  'JD_APPROVED',
      'publish->collect': 'CHANNEL_PUBLISHED',
      'collect->parse':   'RESUME_DOWNLOADED',
      'parse->match':     'RESUME_PROCESSED',
      'match->reject':    'MATCH_FAILED',
      'match->itv':       'MATCH_PASSED_NEED_INTERVIEW',
      'itv->eval':        'AI_INTERVIEW_COMPLETED',
      'eval->pkg':        'EVALUATION_PASSED',
      'pkg->review':      'PACKAGE_GENERATED',
      'review->guard':    'PACKAGE_APPROVED',
      'guard->submit':    'APPLICATION_SUBMITTED',
    };
    const edgesWithEvent = EDGES.map(e => ({
      ...e,
      eventName: EDGE_EVENT[`${e.from}->${e.to}`] ?? '',
    }));
    const edges = buildEdgeAggregates(edgesWithEvent, eventInstances);

    // ── Failure feed ───────────────────────────────────────────
    const failures: MonitorFailureRow[] = failuresAll
      .slice(0, 20)
      .map(a => ({
        runId: a.runId ?? '',
        agent: a.agentName,
        eventName: null,
        narrative: a.narrative,
        severity: a.type === 'agent_error' ? 'error' : 'anomaly',
        at: a.createdAt.toISOString(),
        metadata: a.metadata ? safeParse(a.metadata) : undefined,
      }));

    // ── HITL feed ──────────────────────────────────────────────
    const hitl: MonitorHitlRow[] = hitlPendingRows.slice(0, 20).map(h => ({
      taskId: h.id,
      runId: h.runId,
      nodeId: h.nodeId,
      title: h.title,
      createdAt: h.createdAt.toISOString(),
      deadline: h.deadline?.toISOString() ?? null,
    }));

    // ── Recent runs ────────────────────────────────────────────
    const recentRuns: MonitorRunRow[] = recentRunRows.map(r => ({
      id: r.id,
      triggerEvent: r.triggerEvent,
      status: r.status as MonitorRunRow['status'],
      startedAt: r.startedAt.toISOString(),
      lastActivityAt: r.lastActivityAt.toISOString(),
      clientLabel: extractClientLabel(r.triggerData),
    }));

    const body: MonitorOverviewResponse = {
      filter,
      kpi,
      nodes,
      edges,
      failures,
      hitl,
      recentRuns,
    };

    cachedAt = Date.now();
    cachedKey = cacheKey;
    cachedBody = body;
    return NextResponse.json(body);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[/api/monitor/overview] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

function extractClientLabel(triggerData: string | null): string | null {
  if (!triggerData) return null;
  try {
    const parsed = JSON.parse(triggerData);
    return typeof parsed.client === 'string' ? parsed.client : null;
  } catch {
    return null;
  }
}

