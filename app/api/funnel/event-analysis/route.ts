// /api/funnel/event-analysis?event=<id>
//
//   GET   → 返回已缓存的事件 AI 分析（没有则 cached:false）
//   POST  → 生成（或 ?force=1 重新生成）：串联查库 → LLM 综合 → 落缓存
//
// observability 性质：普通 API route + Postgres 缓存（FunnelEventAnalysis），
// 不上 Inngest。LLM 走 gateway，不可达时诚实降级、绝不编分析。
// 生成逻辑在 lib/funnel/event-analysis.ts 的 runEventAnalysis（与批量预生成共用）。

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { rowToAnalysis, runEventAnalysis, type EventAnalysis } from "@/lib/funnel/event-analysis";

export const dynamic = "force-dynamic";

export type EventAnalysisResponse =
  | {
      ok: true;
      cached: boolean;
      analysis: EventAnalysis | null;
      model?: string;
      durationMs?: number | null;
      promptTokens?: number | null;
      completionTokens?: number | null;
      createdAt?: string;
    }
  | {
      ok: false;
      reason: "not_found" | "gateway_unavailable" | "parse_error" | "llm_error" | "error";
      error?: string;
    };

export async function GET(req: Request): Promise<Response> {
  const eventId = new URL(req.url).searchParams.get("event")?.trim() ?? "";
  if (!eventId) return NextResponse.json<EventAnalysisResponse>({ ok: false, reason: "not_found" }, { status: 400 });
  try {
    const row = await prisma.funnelEventAnalysis.findUnique({ where: { eventId } });
    if (!row) return NextResponse.json<EventAnalysisResponse>({ ok: true, cached: false, analysis: null });
    return NextResponse.json<EventAnalysisResponse>({
      ok: true,
      cached: true,
      analysis: rowToAnalysis(row),
      model: row.model,
      durationMs: row.durationMs,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (e) {
    return NextResponse.json<EventAnalysisResponse>({ ok: false, reason: "error", error: (e as Error).message.slice(0, 200) }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const eventId = searchParams.get("event")?.trim() ?? "";
  const force = searchParams.get("force") === "1";
  if (!eventId) return NextResponse.json<EventAnalysisResponse>({ ok: false, reason: "not_found" }, { status: 400 });

  const r = await runEventAnalysis(eventId, { force });
  if (r.status === "ok") {
    return NextResponse.json<EventAnalysisResponse>({
      ok: true,
      cached: r.cached,
      analysis: r.analysis,
      model: r.model,
      durationMs: r.durationMs,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
    });
  }
  const httpStatus = r.status === "error" ? 500 : 200;
  return NextResponse.json<EventAnalysisResponse>({ ok: false, reason: r.status, error: r.error }, { status: httpStatus });
}
