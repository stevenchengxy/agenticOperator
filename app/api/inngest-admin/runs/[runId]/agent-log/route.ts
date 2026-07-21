// GET /api/inngest-admin/runs/[runId]/agent-log
//
// Durable per-run structured log. Real-agent JSONL entries are mirrored into
// LogEvent at write time with rawKind/anchors/full payload, so this endpoint no
// longer scans a host-local `logs/` directory or loses history after 3 days.
//
// Numbered pagination: ?page=1&pageSize=500 (`limit` is a legacy alias).

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ error: "missing runId" }, { status: 400 });
  }

  const url = new URL(req.url);
  const legacyLimit = positiveInt(url.searchParams.get("limit"), 500, 1000);
  const page = positiveInt(url.searchParams.get("page"), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(url.searchParams.get("pageSize"), legacyLimit, 1000);

  try {
    const where = { runId };
    const [rows, total] = await Promise.all([
      prisma.logEvent.findMany({
        where,
        orderBy: [{ ts: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.logEvent.count({ where }),
    ]);

    const events = rows.map((row) => ({
      ts: row.ts.toISOString(),
      agent: row.agent ?? row.source,
      run_id: row.runId ?? runId,
      trace_id: row.traceId,
      anchors: parseJson(row.anchorsJson),
      kind: row.rawKind ?? row.category,
      payload: parseJson(row.payloadJson),
    }));

    return NextResponse.json({
      runId,
      agent: events[0]?.agent ?? null,
      count: events.length,
      events,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (error) {
    return NextResponse.json(
      { error: "INTERNAL", message: (error as Error).message },
      { status: 500 },
    );
  }
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function positiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
}
