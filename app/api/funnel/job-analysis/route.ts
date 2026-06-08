// /api/funnel/job-analysis?job=<id>
//   GET  → 缓存的岗位漏斗 AI 诊断（无则 cached:false）
//   POST → 生成（?force=1 重生成）：串联查库 → LLM 诊断 → 落缓存
// observability + Postgres 缓存（FunnelJobAnalysis），gateway 诚实降级。

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { jobRowToAnalysis, runJobAnalysis, type JobAnalysis } from "@/lib/funnel/job-analysis";

export const dynamic = "force-dynamic";

export type JobAnalysisResponse =
  | { ok: true; cached: boolean; analysis: JobAnalysis | null; model?: string; candidateCount?: number; createdAt?: string }
  | { ok: false; reason: "not_found" | "gateway_unavailable" | "parse_error" | "llm_error" | "error"; error?: string };

export async function GET(req: Request): Promise<Response> {
  const jobId = new URL(req.url).searchParams.get("job")?.trim() ?? "";
  if (!jobId) return NextResponse.json<JobAnalysisResponse>({ ok: false, reason: "not_found" }, { status: 400 });
  try {
    const row = await prisma.funnelJobAnalysis.findUnique({ where: { jobId } });
    if (!row) return NextResponse.json<JobAnalysisResponse>({ ok: true, cached: false, analysis: null });
    return NextResponse.json<JobAnalysisResponse>({
      ok: true,
      cached: true,
      analysis: jobRowToAnalysis(row),
      model: row.model,
      candidateCount: row.candidateCount,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (e) {
    return NextResponse.json<JobAnalysisResponse>({ ok: false, reason: "error", error: (e as Error).message.slice(0, 200) }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("job")?.trim() ?? "";
  const force = searchParams.get("force") === "1";
  if (!jobId) return NextResponse.json<JobAnalysisResponse>({ ok: false, reason: "not_found" }, { status: 400 });

  const r = await runJobAnalysis(jobId, { force });
  if (r.status === "ok") {
    return NextResponse.json<JobAnalysisResponse>({ ok: true, cached: r.cached, analysis: r.analysis, model: r.model });
  }
  return NextResponse.json<JobAnalysisResponse>(
    { ok: false, reason: r.status, error: r.error },
    { status: r.status === "error" ? 500 : 200 },
  );
}
