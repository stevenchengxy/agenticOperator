// GET /api/events/[name]/live
//
// Per-event live data endpoint. Returns:
//   - EventDefinition metadata (publishers, subscribers, schema versions) if registered
//   - Last 20 EventInstance rows for this event
//   - 24h hourly volume sparkline bucketed from EventInstance
//
// Used by EventsContent's per-event detail view to show real EventInstance data
// alongside the registry metadata.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { buildHourlyBuckets } from "@/lib/monitor/aggregations";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ name: string }> };

export type EventLiveResponse = {
  eventName: string;
  registered: boolean;
  schema: {
    versions: string[];
    publishers: string[];
    subscribers: string[];
  } | null;
  recentInstances: Array<{
    id: string;
    source: string;
    status: string;
    ts: string;
    rejectionReason: string | null;
  }>;
  volume24h: Array<{ bucket: string; count: number }>;
};

type InstanceRow = {
  id: string;
  source: string;
  status: string;
  ts: Date;
  rejectionReason: string | null;
};

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { name } = await ctx.params;

  // Parallel fetch: EventDefinition + recent EventInstances
  const [definition, recentRows] = await Promise.all([
    prisma.eventDefinition
      .findFirst({
        where: { name, retiredAt: null },
        select: {
          activeVersionsJson: true,
          publishersJson: true,
          subscribersJson: true,
        },
      })
      .catch(() => null),

    prisma.eventInstance
      .findMany({
        where: { name },
        orderBy: { ts: "desc" },
        take: 20,
        select: {
          id: true,
          source: true,
          status: true,
          ts: true,
          rejectionReason: true,
        },
      })
      .catch((): InstanceRow[] => []),
  ]);

  // Build 24h volume sparkline — all EventInstance rows in last 24h for this event.
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const allIn24h = await prisma.eventInstance
    .findMany({
      where: { name, ts: { gte: since24h } },
      select: { ts: true },
    })
    .catch((): Array<{ ts: Date }> => []);

  const volume24h = buildHourlyBuckets(since24h, (bucketStart, bucketEnd) => {
    return allIn24h.filter(
      (r) => r.ts >= bucketStart && r.ts < bucketEnd,
    ).length;
  }).map((b) => ({ bucket: b.bucket, count: b.value }));

  // Parse definition JSON fields
  let schema: EventLiveResponse["schema"] = null;
  if (definition) {
    schema = {
      versions: parseJsonArray(definition.activeVersionsJson),
      publishers: parseJsonArray(definition.publishersJson),
      subscribers: parseJsonArray(definition.subscribersJson),
    };
  }

  const body: EventLiveResponse = {
    eventName: name,
    registered: !!definition,
    schema,
    recentInstances: (recentRows as InstanceRow[]).map((r) => ({
      id: r.id,
      source: r.source,
      status: r.status,
      ts: r.ts.toISOString(),
      rejectionReason: r.rejectionReason ?? null,
    })),
    volume24h,
  };

  return NextResponse.json(body);
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
