// GET  /api/infra/status — unified Inngest / Neo4j / deployment health.
// POST /api/infra/status { action: "check" } — run the same probe and persist
// firing system notifications for current infra issues. This gives ops a
// manual "check now" button while the monitor sweeper does it periodically.

import { NextResponse } from "next/server";
import { getInfraStatus, infraFindingsFromSnapshot, INFRA_ALERT_PREFIX } from "@/server/ops/infra-status";
import { recordNotification } from "@/server/notifications/ingest";
import { resolveAlerts } from "@/server/notifications/resolve";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const snapshot = await getInfraStatus();
  return NextResponse.json(snapshot);
}

export async function POST(req: Request): Promise<Response> {
  let action: unknown = "check";
  try {
    ({ action } = (await req.json()) as { action?: unknown });
  } catch {
    // Empty/invalid body still means "check now"; this endpoint is safe.
  }
  if (action !== "check") {
    return NextResponse.json({ ok: false, error: "UNKNOWN_ACTION" }, { status: 400 });
  }

  const snapshot = await getInfraStatus();
  const findings = infraFindingsFromSnapshot(snapshot);
  for (const f of findings) await recordNotification(f);
  const active = new Set(findings.map((f) => f.dedupeHint).filter((k): k is string => Boolean(k)));
  const firing = await prisma.notification.findMany({
    where: { status: "firing", dedupeKey: { startsWith: INFRA_ALERT_PREFIX } },
    select: { dedupeKey: true },
  });
  const resolved = await resolveAlerts(
    firing
      .map((r) => r.dedupeKey)
      .filter((k): k is string => typeof k === "string")
      .filter((k) => !active.has(k)),
  );

  return NextResponse.json({
    ok: true,
    recorded: findings.length,
    resolved,
    snapshot,
  });
}
