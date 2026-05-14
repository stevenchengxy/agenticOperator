// app/api/behavior/route.ts
//
// GET /api/behavior — read-only endpoint for the /behavior UI page.
// Returns open alerts, recent manager decisions, and 24h KPIs.
// No writes: all mutations come from Monitor Agent / Manager Agent.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import type { BehaviorAlertRow, BehaviorApiResponse } from '@/lib/behavior/types';

// Serialize a BehaviorAlert Prisma row into a plain JSON-safe object.
function serialize(row: {
  id: string;
  alertKey: string;
  severity: string;
  ruleId: string;
  details: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  managerActionTaken: string | null;
  managerActionAt: Date | null;
}): BehaviorAlertRow {
  return {
    id: row.id,
    alertKey: row.alertKey,
    severity: row.severity,
    ruleId: row.ruleId,
    details: row.details,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    managerActionTaken: row.managerActionTaken,
    managerActionAt: row.managerActionAt?.toISOString() ?? null,
  };
}

export async function GET(_req: Request): Promise<Response> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [openAlerts, recentAlerts, recentActions] = await Promise.all([
    // Currently open (unresolved) alerts — top 20 newest first
    prisma.behaviorAlert.findMany({
      where: { resolvedAt: null },
      orderBy: { firstSeenAt: 'desc' },
      take: 20,
    }),
    // All alerts in last 24h (for KPI counters)
    prisma.behaviorAlert.findMany({
      where: { firstSeenAt: { gte: since24h } },
      orderBy: { firstSeenAt: 'desc' },
      take: 100,
    }),
    // Alerts with manager actions taken in last 24h
    prisma.behaviorAlert.findMany({
      where: {
        managerActionAt: { not: null, gte: since24h },
      },
      orderBy: { managerActionAt: 'desc' },
      take: 20,
    }),
  ]);

  const kpi = {
    open: openAlerts.length,
    in24h: recentAlerts.length,
    escalated: recentAlerts.filter((a) => a.managerActionTaken === 'escalate').length,
    autoResolved: recentAlerts.filter((a) => a.resolvedAt != null && !a.managerActionTaken).length,
  };

  const body: BehaviorApiResponse = {
    kpi,
    openAlerts: openAlerts.map(serialize),
    recentActions: recentActions.map(serialize),
  };

  return NextResponse.json(body);
}
