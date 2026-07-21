// GET /api/funnel/job-intake
//
// 岗位"入口漏斗"：和候选人漏斗正交 —— 看岗位需求本身从录入到发布的转化。
// 按 JobRequisition.status 聚合：需求录入 → 澄清 → JD就绪 → 发布 → 关闭。
// 数据为空（这批 seed 数据没走过 JD 生成管道）时诚实返回 0。

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

const STATUS_ORDER = ["pending_clarification", "clarified", "jd_ready", "published", "closed"] as const;

export type JobIntakeResponse = {
  total: number;
  stages: { status: string; count: number }[];
  meta: { generatedAt: string; error?: string };
};

export async function GET(): Promise<Response> {
  try {
    const grouped = await prisma.jobRequisition.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const g of grouped) counts.set(g.status, g._count._all);

    const stages = STATUS_ORDER.map((s) => ({ status: s, count: counts.get(s) ?? 0 }));
    const total = stages.reduce((a, b) => a + b.count, 0);

    return NextResponse.json<JobIntakeResponse>({ total, stages, meta: { generatedAt: new Date().toISOString() } });
  } catch (e) {
    return NextResponse.json<JobIntakeResponse>(
      { total: 0, stages: STATUS_ORDER.map((s) => ({ status: s, count: 0 })), meta: { generatedAt: new Date().toISOString(), error: (e as Error).message.slice(0, 200) } },
      { status: 500 },
    );
  }
}
