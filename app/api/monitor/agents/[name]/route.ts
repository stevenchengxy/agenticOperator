import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { nodeById } from '@/lib/workflow-graph-meta';
import { sumTokensFromActivities } from '@/lib/monitor/aggregations';
import type { MonitorAgentDetail } from '@/lib/monitor/types';

// ── /api/monitor/agents/[name] ────────────────────────────────────────
//
// `name` is the workflow node id (e.g. "jd", "parse", "match").
// The route resolves the node via nodeById(name) and uses
// node.agentName ?? node.title for DB lookups so the "parse" node
// (title "ResumeParser + DupeCheck", agentName "ResumeParser") maps
// correctly to AgentActivity rows.

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await ctx.params;
  const node = nodeById(name);
  if (!node) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const agentName = node.agentName ?? node.title;

  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [activities, episodes, config] = await Promise.all([
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
    };
    return NextResponse.json(detail);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[/api/monitor/agents/[name]] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function buildHourlyBuckets<T>(
  since: Date,
  compute: (bucketStart: Date, bucketEnd: Date) => T,
): Array<{ bucket: string; value: T }> {
  const buckets: Array<{ bucket: string; value: T }> = [];
  const HOUR = 60 * 60 * 1000;
  // Align start to the hour boundary for clean buckets
  let start = new Date(Math.floor(since.getTime() / HOUR) * HOUR);
  const end = new Date();
  while (start < end && buckets.length < 24) {
    const next = new Date(start.getTime() + HOUR);
    buckets.push({ bucket: start.toISOString(), value: compute(start, next) });
    start = next;
  }
  // Pad to exactly 24 buckets if window had fewer (e.g. at start of day)
  while (buckets.length < 24) {
    const padStart = new Date(Math.floor(since.getTime() / HOUR) * HOUR - (24 - buckets.length) * HOUR);
    buckets.unshift({ bucket: padStart.toISOString(), value: compute(new Date(0), new Date(0)) });
  }
  return buckets;
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return undefined; }
}
