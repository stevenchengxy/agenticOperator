// 运行统计 API — /analytics 页的数据源。
//   GET /api/analytics/stats?window=24h|7d|30d&bucket=hour|day|week
//
// 两个数据源,都在 Docker 本地 Postgres:
//   - inngest_run_archive  每条 agent run(归档器落库,含 Failed/Cancelled)
//   - log_event category='api'  每次外部 API 调用(RoboHire/Allmeta/partner-pg/
//     RMHR,server/log/api-call-mirror.ts 落库,带 agent 归属)
// 聚合逻辑在 lib/analytics/stats.ts(纯函数,有单测)。

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import {
  normalizeStatsParams,
  makeBuckets,
  aggregateRuns,
  aggregateApiCalls,
} from '@/lib/analytics/stats';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const now = new Date();
  const params = normalizeStatsParams(
    url.searchParams.get('window'),
    url.searchParams.get('bucket'),
    now,
  );
  const buckets = makeBuckets(params.since, now, params.bucket);

  try {
    const [runRows, apiRows] = await Promise.all([
      prisma.inngestRunArchive.findMany({
        where: { startedAt: { gte: params.since } },
        select: { functionSlug: true, functionName: true, status: true, startedAt: true },
      }),
      prisma.logEvent.findMany({
        // 只统计有归属(agent 或 run)的调用 — 即 agent 真正驱动的外部流量。
        // 监控页探针(run-neo4j-instances 等 route handler)也走 logApiCall,
        // 它们的行留在审计日志里可查,但 agent/runId 为空,不计入统计,否则
        // "外部调用"KPI 会随运维人员开监控面板的行为膨胀。
        where: {
          category: 'api',
          ts: { gte: params.since },
          OR: [{ agent: { not: null } }, { runId: { not: null } }],
        },
        select: { ts: true, source: true, agent: true, eventName: true, level: true },
      }),
    ]);

    const runs = aggregateRuns(runRows, buckets, params.bucket);
    const apiCalls = aggregateApiCalls(apiRows, buckets, params.bucket);

    const totalRuns = runRows.filter((r) => r.startedAt && r.startedAt >= params.since).length;
    const failedRuns = runs.totalsByStatus['Failed'] ?? 0;
    const totalApiCalls = apiRows.length;
    const robohireCalls = apiCalls.providers.find((p) => p.provider === 'robohire')?.total ?? 0;

    return NextResponse.json({
      window: params.window,
      bucket: params.bucket,
      buckets, // epoch ms of each bucket start (local-time aligned)
      runs,
      apiCalls,
      kpi: { totalRuns, failedRuns, totalApiCalls, robohireCalls },
      meta: { generatedAt: now.toISOString() },
    });
  } catch (e) {
    return NextResponse.json(
      {
        window: params.window,
        bucket: params.bucket,
        buckets,
        runs: { agents: [], totalsByStatus: {}, totalSeries: [] },
        apiCalls: { providers: [], operations: [], byAgent: [] },
        kpi: { totalRuns: 0, failedRuns: 0, totalApiCalls: 0, robohireCalls: 0 },
        error: (e as Error).message,
      },
      { status: 200 },
    );
  }
}
