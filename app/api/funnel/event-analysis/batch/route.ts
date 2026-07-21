// POST /api/funnel/event-analysis/batch?job=<id>&decision=FAIL&limit=20
//
// 后台预生成高价值事件（默认拦截 FAIL）的 AI 分析，使开抽屉即得。
// 复用 runEventAnalysis（已缓存的自动跳过），限量封顶以约束 LLM 花费。

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { runEventAnalysis } from "@/lib/funnel/event-analysis";

export const dynamic = "force-dynamic";

export type BatchAnalysisResponse = {
  requested: number;
  generated: number;
  cached: number;
  failed: number;
  meta: { generatedAt: string; reason?: string; error?: string };
};

// decision=FAIL → 拦截事件；ALL → 不限。
const NAME_BY_DECISION: Record<string, string[]> = {
  FAIL: ["MATCH_RULE_CHECK_FAILED"],
  PASS: ["MATCH_RULE_CHECK_PASSED"],
};

export async function POST(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("job")?.trim() || null;
  const decision = (searchParams.get("decision") || "FAIL").toUpperCase();
  const rawLimit = parseInt(searchParams.get("limit") || "20", 10);
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 20));

  try {
    const names = NAME_BY_DECISION[decision];
    const where: Record<string, unknown> = {};
    if (names) where.name = { in: names };
    if (jobId) where.payloadSummary = { contains: jobId };

    const rows = await prisma.eventInstance.findMany({
      where,
      orderBy: { ts: "desc" },
      take: limit,
      select: { id: true },
    });

    let generated = 0;
    let cached = 0;
    let failed = 0;
    // 顺序跑，避免并发轰炸 LLM 网关。
    for (const r of rows) {
      const res = await runEventAnalysis(r.id, { force: false });
      if (res.status === "ok") res.cached ? cached++ : generated++;
      else failed++;
      // 网关不可达就没必要继续了。
      if (res.status === "gateway_unavailable") {
        return NextResponse.json<BatchAnalysisResponse>({
          requested: rows.length,
          generated,
          cached,
          failed,
          meta: { generatedAt: new Date().toISOString(), reason: "gateway_unavailable" },
        });
      }
    }

    return NextResponse.json<BatchAnalysisResponse>({
      requested: rows.length,
      generated,
      cached,
      failed,
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json<BatchAnalysisResponse>(
      { requested: 0, generated: 0, cached: 0, failed: 0, meta: { generatedAt: new Date().toISOString(), error: (e as Error).message.slice(0, 200) } },
      { status: 500 },
    );
  }
}
