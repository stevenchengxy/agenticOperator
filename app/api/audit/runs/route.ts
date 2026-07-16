// GET /api/audit/runs
//
// Durable run-level audit summaries aggregated from Postgres LogEvent. The
// JSONL files remain a compatibility sink, but are no longer the read source.
// Filters: agent, candidate_id, run_id, days (or "all"), page, pageSize.
// `limit` remains a legacy pageSize alias.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

export type RunAuditSummary = {
  run_id: string;
  agent: string;
  trace_id: string | null;
  started_at: string;
  ended_at: string;
  event_count: number;
  kinds: string[];
  anchors: Record<string, string>;
  has_error: boolean;
  event_name: string | null;
};

export type RunAuditResponse = {
  rows: RunAuditSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Kept for old UI copy; reads are database-backed so this is always zero. */
  scanned_files: number;
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filterAgent = url.searchParams.get("agent")?.trim() || null;
  const filterCandidate = url.searchParams.get("candidate_id")?.trim() || null;
  const filterRunId = url.searchParams.get("run_id")?.trim() || null;
  // Durable audit reads default to the complete history. A bounded rolling
  // window remains available via ?days=N for compatibility and exports.
  const daysRaw = url.searchParams.get("days") ?? "all";
  const days = daysRaw === "all" ? null : positiveInt(daysRaw, 3, 3650);
  const legacyLimit = positiveInt(url.searchParams.get("limit"), 200, 1000);
  const page = positiveInt(url.searchParams.get("page"), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(url.searchParams.get("pageSize"), legacyLimit, 1000);

  const where: Record<string, unknown> = { runId: { not: null } };
  if (filterRunId) where.runId = filterRunId;
  if (filterAgent) where.agent = filterAgent;
  if (filterCandidate) {
    where.anchorsJson = {
      contains: `"candidate_id":${JSON.stringify(filterCandidate)}`,
    };
  }
  if (days !== null) where.ts = { gte: new Date(Date.now() - days * 86_400_000) };

  try {
    // Prisma has no countDistinct helper. `distinct` is still executed in
    // Postgres and returns only the ids, while groupBy applies skip/take for
    // the actual page.
    const [distinctRuns, groups] = await Promise.all([
      prisma.logEvent.findMany({ where, distinct: ["runId"], select: { runId: true } }),
      prisma.logEvent.groupBy({
        by: ["runId"],
        where,
        _min: { ts: true },
        _max: { ts: true },
        _count: { _all: true },
        orderBy: [{ _max: { ts: "desc" } }, { runId: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const runIds = groups.map((g) => g.runId).filter((id): id is string => Boolean(id));
    const detailRows = runIds.length
      ? await prisma.logEvent.findMany({
          where: { ...where, runId: { in: runIds } },
          orderBy: [{ ts: "asc" }, { id: "asc" }],
        })
      : [];
    const detailsByRun = new Map<string, typeof detailRows>();
    for (const row of detailRows) {
      if (!row.runId) continue;
      const list = detailsByRun.get(row.runId) ?? [];
      list.push(row);
      detailsByRun.set(row.runId, list);
    }

    const groupByRun = new Map(groups.map((group) => [group.runId, group]));
    const rows = runIds.map((runId): RunAuditSummary => {
      const details = detailsByRun.get(runId) ?? [];
      const group = groupByRun.get(runId)!;
      const anchors: Record<string, string> = {};
      const kinds = new Set<string>();
      let eventName: string | null = null;
      let hasError = false;
      for (const row of details) {
        kinds.add(row.rawKind ?? row.category);
        const parsedAnchors = parseRecord(row.anchorsJson);
        for (const [key, value] of Object.entries(parsedAnchors)) {
          if (typeof value === "string" && value) anchors[key] = value;
        }
        eventName ??= row.eventName;
        if (
          row.level === "error" ||
          row.level === "critical" ||
          row.rawKind?.includes("error") ||
          row.rawKind?.includes("failed")
        ) hasError = true;
      }
      const first = details[0];
      return {
        run_id: runId,
        agent: first?.agent ?? first?.source ?? "system",
        trace_id: details.find((row) => row.traceId)?.traceId ?? null,
        started_at: group._min.ts?.toISOString() ?? first?.ts.toISOString() ?? "",
        ended_at: group._max.ts?.toISOString() ?? first?.ts.toISOString() ?? "",
        event_count: group._count._all,
        kinds: [...kinds],
        anchors,
        has_error: hasError,
        event_name: eventName,
      };
    });

    const total = distinctRuns.length;
    return NextResponse.json({
      rows,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      scanned_files: 0,
    } satisfies RunAuditResponse);
  } catch (error) {
    return NextResponse.json(
      { error: "INTERNAL", message: (error as Error).message },
      { status: 500 },
    );
  }
}

function parseRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function positiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
}
