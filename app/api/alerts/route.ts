import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import type { AlertsResponse, Alert, ApiMeta } from "@/lib/api/types";

// Persistent alert projection. Timed-out WorkflowRun rows, unresolved DLQEntry
// rows and the EM health singleton all live in Postgres; no legacy sidecar is
// required for reads, which keeps this endpoint portable across deployments.

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const categoryFilter = url.searchParams.get("category")?.split(",").filter(Boolean);
  const affectedFilter = url.searchParams.get("affected");
  const includeResolved = url.searchParams.get("includeResolved") === "1";
  const legacyLimit = positiveInt(url.searchParams.get("limit"), 50, 500);
  const page = positiveInt(url.searchParams.get("page"), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(url.searchParams.get("pageSize"), legacyLimit, 500);
  const prefixSize = Math.min(5000, page * pageSize);

  const include = (category: string) => !categoryFilter || categoryFilter.includes(category);
  const partial: ApiMeta["partial"] = [];
  let slaRows: Awaited<ReturnType<typeof readSlaRows>> = { rows: [], total: 0 };
  let dlqRows: Awaited<ReturnType<typeof readDlqRows>> = { rows: [], total: 0 };
  let infra: Alert[] = [];

  await Promise.all([
    include("sla")
      ? readSlaRows(prefixSize, affectedFilter).then((value) => { slaRows = value; }).catch(() => { partial.push("ws"); })
      : Promise.resolve(),
    include("dlq")
      ? readDlqRows(prefixSize, affectedFilter, includeResolved).then((value) => { dlqRows = value; }).catch(() => { partial.push("em"); })
      : Promise.resolve(),
    include("infra")
      ? readInfraRows(affectedFilter).then((value) => { infra = value; }).catch(() => { partial.push("em"); })
      : Promise.resolve(),
  ]);

  const all = [...slaRows.rows, ...dlqRows.rows, ...infra].sort(
    (a, b) =>
      new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime() ||
      b.id.localeCompare(a.id),
  );
  const total = slaRows.total + dlqRows.total + infra.length;
  const alerts = all.slice((page - 1) * pageSize, page * pageSize);
  const body: AlertsResponse = {
    alerts,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    meta: {
      partial: partial.length ? [...new Set(partial)] : undefined,
      generatedAt: new Date().toISOString(),
    },
  };
  return NextResponse.json(body);
}

async function readSlaRows(take: number, affected: string | null): Promise<{ rows: Alert[]; total: number }> {
  const where = {
    status: "timed_out",
    ...(affected ? { triggerEvent: affected } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.workflowRun.findMany({
      where,
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      take,
    }),
    prisma.workflowRun.count({ where }),
  ]);
  return {
    total,
    rows: rows.map((row) => ({
      id: `sla-${row.id}`,
      category: "sla",
      severity: "high",
      title: `Run ${row.id} timed out`,
      affected: row.triggerEvent,
      triggeredAt: row.lastActivityAt.toISOString(),
      acked: false,
      ackedBy: null,
    })),
  };
}

async function readDlqRows(
  take: number,
  affected: string | null,
  includeResolved: boolean,
): Promise<{ rows: Alert[]; total: number }> {
  const where = {
    ...(!includeResolved ? { resolvedAt: null } : {}),
    ...(affected ? { eventName: affected } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.dLQEntry.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
    }),
    prisma.dLQEntry.count({ where }),
  ]);
  return {
    total,
    rows: rows.map((row) => ({
      id: `dlq-${row.id}`,
      category: "dlq",
      severity: "medium",
      title: `${row.eventName} → DLQ`,
      affected: row.eventName,
      triggeredAt: row.createdAt.toISOString(),
      acked: false,
      ackedBy: null,
      resolved: row.resolvedAt !== null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    })),
  };
}

async function readInfraRows(affected: string | null): Promise<Alert[]> {
  const status = await prisma.emSystemStatus.findUnique({ where: { id: "singleton" } });
  if (!status) return [];
  const alerts: Alert[] = [];
  if (status.state === "degraded" || status.state === "down") {
    alerts.push({
      id: `em-${status.state}`,
      category: "infra",
      severity: status.state === "down" ? "critical" : "high",
      title: status.state === "down" ? "Event Manager 不可用" : "Event Manager 降级运行",
      affected: "event-manager",
      triggeredAt:
        status.degradedSince?.toISOString() ??
        status.lastErrorAt?.toISOString() ??
        new Date().toISOString(),
      acked: false,
      ackedBy: null,
    });
  }
  if (status.neo4jLastError) {
    alerts.push({
      id: "em-neo4j-sync",
      category: "infra",
      severity: "medium",
      title: `Neo4j 同步失败：${truncate(status.neo4jLastError, 80)}`,
      affected: "neo4j-sync",
      triggeredAt: status.lastErrorAt?.toISOString() ?? new Date().toISOString(),
      acked: false,
      ackedBy: null,
    });
  }
  return affected ? alerts.filter((alert) => alert.affected === affected) : alerts;
}

function positiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value))) : fallback;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
