import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { nodeById, NODES } from '@/lib/workflow-graph-meta';
import { sumTokensFromActivities, buildHourlyBuckets, safeParse } from '@/lib/monitor/aggregations';
import type { MonitorAgentDetail, CandidateDistributionEntry } from '@/lib/monitor/types';
import { AGENT_MAP, type AgentMeta } from '@/lib/agent-mapping';
import { listEvents } from '@/lib/inngest-source';
import { eventLeafName, eventMatchesDomain } from '@/lib/events/domain-scope';

// ── /api/monitor/agents/[name] ────────────────────────────────────────
//
// `name` is the workflow node id (e.g. "jd", "parse", "match").
// The route resolves the node via nodeById(name) and uses
// node.agentName ?? node.title for DB lookups so the "parse" node
// (title "ResumeParser + DupeCheck", agentName "ResumeParser") maps
// correctly to AgentActivity rows.

function extractEventNameFromMeta(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  if (typeof meta.nextEventName === 'string') return meta.nextEventName;
  if (typeof meta.eventName === 'string') return meta.eventName;
  return null;
}

function extractEventNameFromNarrative(narrative: string): string | null {
  const m = narrative.match(/(?:Emitting|Received|emitting|received)\s+([A-Z_]+)/);
  return m ? m[1] : null;
}

function eventTs(e: { received_at?: string; ts?: number }): string {
  if (e.received_at) return e.received_at;
  if (typeof e.ts === 'number') return new Date(e.ts).toISOString();
  return new Date().toISOString();
}

async function archivedEventActivityForAgent(
  meta: AgentMeta | undefined,
): Promise<MonitorAgentDetail['recentEventActivity']> {
  if (!meta) return [];
  const triggerNames = new Set(meta.triggersEvents ?? []);
  const emitNames = new Set(meta.emitsEvents ?? []);
  const eventNames = new Set([...triggerNames, ...emitNames]);
  if (eventNames.size === 0) return [];

  const events = await listEvents(300);
  return events
    .filter((e) => eventNames.has(e.name) || eventNames.has(eventLeafName(e.name)))
    .filter((e) => eventMatchesDomain(e, meta.domain))
    .slice(0, 50)
    .map((e) => {
      const leafName = eventLeafName(e.name);
      const emitted = (emitNames.has(e.name) || emitNames.has(leafName)) && !(triggerNames.has(e.name) || triggerNames.has(leafName));
      return {
        ts: eventTs(e),
        type: emitted ? 'event_emitted' : 'event_received',
        eventName: leafName || e.name,
        narrative: emitted ? `Emitted ${leafName || e.name}` : `Received ${leafName || e.name}`,
        runId: null,
      };
    });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await ctx.params;
  const node = nodeById(name);
  if (!node) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const agentName = node.agentName ?? node.title;
  const agentMeta = AGENT_MAP.find(
    (a) => a.short === agentName || a.inngestName === agentName || a.wsId === node.wsId,
  );

  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [activities, episodes, config, distributionGroups, eventActivities, archivedEventActivities] = await Promise.all([
      prisma.agentActivity.findMany({
        where: { agentName, createdAt: { gte: since24h } },
        orderBy: { createdAt: 'asc' },
        select: { type: true, metadata: true, createdAt: true, narrative: true, runId: true },
      }),
      // AgentEpisode is currently unwritten on this branch, but query
      // anyway — works the day agents start writing episodes.
      prisma.agentEpisode.findMany({
        where: { agentName },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }).catch(() => []),
      prisma.agentConfig.findUnique({ where: { id: node.title } }).catch(() => null),
      // Candidate distribution: count AgentActivity rows per agentName in last 24h
      prisma.agentActivity.groupBy({
        by: ['agentName'],
        where: { createdAt: { gte: since24h } },
        _count: { agentName: true },
      }).catch(() => [] as Array<{ agentName: string; _count: { agentName: number } }>),
      // Recent emit/receive events for this agent
      prisma.agentActivity.findMany({
        where: {
          agentName,
          type: { in: ['event_received', 'event_emitted'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { type: true, metadata: true, createdAt: true, narrative: true, runId: true },
      }).catch(() => []),
      archivedEventActivityForAgent(agentMeta).catch(() => []),
    ]);

    // ── 24h hourly token buckets ──────────────────────────────
    const tokenSpend = buildHourlyBuckets(since24h, (bucketStart, bucketEnd) => {
      const rows = activities.filter(a =>
        a.type === 'tool' &&
        a.createdAt >= bucketStart &&
        a.createdAt < bucketEnd,
      );
      return sumTokensFromActivities(rows);
    });

    // ── 24h hourly error rate ─────────────────────────────────
    const errorRate = buildHourlyBuckets(since24h, (bucketStart, bucketEnd) => {
      const rows = activities.filter(a => a.createdAt >= bucketStart && a.createdAt < bucketEnd);
      return {
        total: rows.filter(r => r.type === 'agent_complete' || r.type === 'agent_error').length,
        failed: rows.filter(r => r.type === 'agent_error').length,
      };
    });

    // ── recent errors ─────────────────────────────────────────
    const recentErrors = activities
      .filter(a => a.type === 'agent_error' || a.type === 'anomaly')
      .slice(-20)
      .reverse()
      .map(a => ({
        runId: a.runId ?? '',
        narrative: a.narrative,
        ts: a.createdAt.toISOString(),
        metadata: a.metadata ? safeParse(a.metadata) : undefined,
      }));

    // ── recent episodes (mapped to API shape) ────────────────
    const recentEpisodes: MonitorAgentDetail['recentEpisodes'] = (episodes as any[]).map((e) => {
      const rawUsage = safeParse(e.tokenUsage ?? 'null');
      const tokenUsage = {
        prompt:     typeof rawUsage?.prompt     === 'number' ? rawUsage.prompt     : 0,
        completion: typeof rawUsage?.completion === 'number' ? rawUsage.completion : 0,
        total:      typeof rawUsage?.total      === 'number' ? rawUsage.total      : 0,
      };
      return {
        id: String(e.id),
        runId: String(e.runId ?? ''),
        clientId: e.clientId != null ? String(e.clientId) : null,
        durationMs: Number(e.durationMs ?? 0),
        tokenUsage,
        modelUsed: e.modelUsed != null ? String(e.modelUsed) : null,
        judgeScore: e.judgeScore != null ? Number(e.judgeScore) : null,
        createdAt: (e.createdAt as Date).toISOString(),
      };
    });

    // ── Candidate distribution across all workflow nodes ──────────
    // Build a map from agentName → 24h activity count from groupBy result
    const distMap = new Map<string, number>(
      (distributionGroups as Array<{ agentName: string; _count: { agentName: number } }>)
        .map(g => [g.agentName, g._count.agentName]),
    );

    const candidateDistribution: CandidateDistributionEntry[] = NODES.map(n => {
      const canonName = n.agentName ?? n.title;
      const passedCount24h = distMap.get(canonName) ?? 0;
      return {
        nodeId: n.id,
        // activeCount: approximate via recent activity rows (running type) — 0 when no live data
        activeCount: 0,
        passedCount24h,
      };
    });

    // ── Recent emit/receive event activity ───────────────────
    const activityBackedEventActivity: MonitorAgentDetail['recentEventActivity'] = (
      eventActivities as Array<{ type: string; metadata: string | null; createdAt: Date; narrative: string; runId: string | null }>
    ).map(a => {
      const meta = a.metadata ? safeParse(a.metadata) : undefined;
      return {
        ts: a.createdAt.toISOString(),
        type: a.type as 'event_received' | 'event_emitted',
        eventName: extractEventNameFromMeta(meta) ?? extractEventNameFromNarrative(a.narrative),
        narrative: a.narrative,
        runId: a.runId,
      };
    });
    const recentEventActivity =
      activityBackedEventActivity.length > 0
        ? activityBackedEventActivity
        : archivedEventActivities;

    const detail: MonitorAgentDetail = {
      name: node.id,
      title: node.title,
      config: config
        ? {
            enabled: !!(config as any).enabled,
            temperature: (config as any).temperature ?? null,
            maxRetries: (config as any).maxRetries ?? null,
            tier: (config as any).tier ?? null,
            maxOutputTokens: (config as any).maxOutputTokens ?? null,
            promptAppend: (config as any).promptAppend ?? null,
          }
        : null,
      recentEpisodes,
      tokenSpend: tokenSpend.map(b => ({
        bucket: b.bucket,
        prompt: b.value.prompt,
        completion: b.value.completion,
        total: b.value.total,
      })),
      errorRate: errorRate.map(b => ({
        bucket: b.bucket,
        total: b.value.total,
        failed: b.value.failed,
      })),
      recentErrors,
      candidateDistribution,
      recentEventActivity,
    };
    return NextResponse.json(detail);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[/api/monitor/agents/[name]] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
