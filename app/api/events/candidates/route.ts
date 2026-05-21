// GET /api/events/candidates?windowHours=24&limit=50
//
// Aggregates EventInstance rows into per-candidate summaries:
// { candidate_id, candidate_name, jr_ids, latest_stage, last_event_ts, event_count }
//
// Best-effort: candidate_id is extracted by string-contains match in
// payloadSummary, so collisions on short ids are possible.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { resolveEntityNames } from "@/lib/allmeta-client";
import { latestStage, type PipelineStage } from "@/lib/events/pipeline-stages";

const CANDIDATE_ID_RE = /"candidate_id"\s*:\s*"([^"]+)"/g;
const JR_ID_RE = /"job_requisition_id"\s*:\s*"([^"]+)"/g;
const UPLOAD_ID_RE = /"upload_id"\s*:\s*"([^"]+)"/g;

type CandidateSummary = {
  candidate_id: string;
  candidate_name: string | null;
  jr_ids: string[];
  upload_ids: string[];
  latest_stage: PipelineStage;
  last_event_ts: string;
  event_count: number;
  events_by_name: Record<string, number>;
};

export type CandidateTrackingResponse = {
  ok: true;
  candidates: CandidateSummary[];
  windowHours: number;
  fetched_at: string;
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const windowHours = Math.max(1, Math.min(168, Number(url.searchParams.get("windowHours") ?? 24)));
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50)));
  const since = new Date(Date.now() - windowHours * 3_600_000);

  try {
    const rows = await prisma.eventInstance.findMany({
      where: { ts: { gte: since } },
      orderBy: { ts: "desc" },
      take: 2000, // upper bound on raw rows before grouping
      select: { id: true, name: true, ts: true, payloadSummary: true },
    });

    // Group by candidate_id (extracted from payloadSummary best-effort)
    const grouped = new Map<string, {
      events: Array<{ name: string; ts: Date }>;
      jrs: Set<string>;
      uploads: Set<string>;
    }>();

    for (const row of rows) {
      if (!row.payloadSummary) continue;
      const candidateIds = extractAll(CANDIDATE_ID_RE, row.payloadSummary);
      if (candidateIds.length === 0) continue;
      const jrIds = extractAll(JR_ID_RE, row.payloadSummary);
      const uploadIds = extractAll(UPLOAD_ID_RE, row.payloadSummary);
      for (const cid of candidateIds) {
        let bucket = grouped.get(cid);
        if (!bucket) {
          bucket = { events: [], jrs: new Set(), uploads: new Set() };
          grouped.set(cid, bucket);
        }
        bucket.events.push({ name: row.name, ts: row.ts });
        for (const j of jrIds) bucket.jrs.add(j);
        for (const u of uploadIds) bucket.uploads.add(u);
      }
    }

    // Build summaries
    const summaries: CandidateSummary[] = [];
    for (const [candidate_id, bucket] of grouped.entries()) {
      const eventNames = bucket.events.map((e) => e.name);
      const counts: Record<string, number> = {};
      for (const n of eventNames) counts[n] = (counts[n] ?? 0) + 1;
      const lastTs = bucket.events.reduce((m, e) => (e.ts > m ? e.ts : m), new Date(0));
      summaries.push({
        candidate_id,
        candidate_name: null, // filled below
        jr_ids: Array.from(bucket.jrs),
        upload_ids: Array.from(bucket.uploads),
        latest_stage: latestStage(eventNames),
        last_event_ts: lastTs.toISOString(),
        event_count: bucket.events.length,
        events_by_name: counts,
      });
    }

    // Sort by last activity desc, slice
    summaries.sort((a, b) => (a.last_event_ts < b.last_event_ts ? 1 : -1));
    const top = summaries.slice(0, limit);

    // Enrich with displayName from Neo4j (best-effort)
    const names = await resolveEntityNames("Candidate", top.map((s) => s.candidate_id)).catch(
      () => new Map<string, string>(),
    );
    for (const s of top) {
      s.candidate_name = names.get(s.candidate_id) ?? null;
    }

    const body: CandidateTrackingResponse = {
      ok: true,
      candidates: top,
      windowHours,
      fetched_at: new Date().toISOString(),
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

function extractAll(re: RegExp, s: string): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return Array.from(new Set(out));
}
