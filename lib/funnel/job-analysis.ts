// 流程追踪 · 岗位漏斗 AI 诊断的「串联查库」+ prompt + 解析 + 缓存。
//
// 串联：RuleCheckAudit(该岗位全部预筛) → 每候选人最新决策(通过/拦截) +
// 拦截原因汇总。交给 LLM 诊断漏斗：流失集中在哪、把自由文本拦截原因聚类成
// 主题+计数、亮点、可执行建议。observability，不上 Inngest，gateway 诚实降级。

import { prisma } from "@/server/db";
import { chatComplete, isGatewayConfigured } from "@/server/llm/gateway";
import { jobMetaFromSnapshot } from "@/lib/funnel/names";

export type FailureCluster = { reason: string; count: number };

export type JobAnalysis = {
  diagnosis: string;
  failureClusters: FailureCluster[];
  highlights: string;
  recommendations: string[];
};

export type JobContext = {
  jobId: string;
  title: string;
  client: string | null;
  total: number;
  pass: number;
  fail: number;
  failureReasons: string[];
};

function jsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [];
  } catch {
    return [];
  }
}

/** 串联查库：把一个岗位的漏斗证据拼成诊断上下文。无审计返回 null。 */
export async function assembleJobContext(jobId: string): Promise<JobContext | null> {
  const audits = await prisma.ruleCheckAudit.findMany({
    where: { job_requisition_id: jobId },
    orderBy: { created_at: "desc" },
    take: 3000,
    select: {
      candidate_id: true,
      decision: true,
      failure_reasons: true,
      job_requisition_json: true,
      client_display_name: true,
      client_name: true,
    },
  });
  if (audits.length === 0) return null;

  const latest = new Map<string, (typeof audits)[number]>();
  for (const a of audits) if (!latest.has(a.candidate_id)) latest.set(a.candidate_id, a);

  let pass = 0;
  let fail = 0;
  const reasons: string[] = [];
  for (const a of latest.values()) {
    if (a.decision === "PASS") pass++;
    else if (a.decision === "FAIL") {
      fail++;
      reasons.push(...jsonArray(a.failure_reasons));
    }
  }

  const meta = jobMetaFromSnapshot(audits[0].job_requisition_json);
  return {
    jobId,
    title: meta.title ?? jobId,
    client: audits[0].client_display_name ?? audits[0].client_name ?? null,
    total: latest.size,
    pass,
    fail,
    failureReasons: reasons.slice(0, 120), // 控制体积
  };
}

export const JOB_ANALYSIS_SYSTEM_PROMPT = `你是招聘漏斗的诊断助手。你会收到一个岗位的预筛漏斗统计（进入人数、通过、拦截）以及全部拦截原因（自由文本）。

任务：对这个岗位的招聘漏斗做诊断。要求：
- 只依据提供的数据，绝不臆测。用中文，面向招聘运营。
- "diagnosis"：流失集中在哪一环、通过率是否健康、瓶颈判断。
- "failureClusters"：把拦截原因聚类成若干主题，每个给出主题名和命中次数（count 必须是数字，且各 count 之和不超过拦截总数）。
- "highlights"：值得注意的正面信号（如通过率高/某类候选人质量好）。
- "recommendations"：1-4 条可执行建议。

严格只输出一个 JSON 对象，不要任何解释或代码围栏：
{"diagnosis": "...", "failureClusters": [{"reason": "主题", "count": 3}], "highlights": "...", "recommendations": ["...", "..."]}`;

export function composeJobUser(ctx: JobContext): string {
  const compact = {
    岗位: ctx.title,
    客户: ctx.client,
    进入漏斗人数: ctx.total,
    预筛通过: ctx.pass,
    预筛拦截: ctx.fail,
    通过率: ctx.total > 0 ? `${Math.round((ctx.pass / Math.max(1, ctx.pass + ctx.fail)) * 100)}%` : null,
    全部拦截原因: ctx.failureReasons,
  };
  return JSON.stringify(compact, null, 2);
}

export function parseJobAnalysis(text: string): JobAnalysis {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLM 未返回 JSON 对象");
  const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const clusters = Array.isArray(obj.failureClusters)
    ? obj.failureClusters
        .map((c) => {
          const o = (c ?? {}) as Record<string, unknown>;
          return { reason: str(o.reason), count: typeof o.count === "number" ? o.count : Number(o.count) || 0 };
        })
        .filter((c) => c.reason)
    : [];
  return {
    diagnosis: str(obj.diagnosis),
    failureClusters: clusters,
    highlights: str(obj.highlights),
    recommendations: Array.isArray(obj.recommendations)
      ? obj.recommendations.filter((x): x is string => typeof x === "string")
      : [],
  };
}

export function jobRowToAnalysis(row: {
  diagnosis: string;
  failureClusters: string;
  highlights: string;
  recommendations: string;
}): JobAnalysis {
  let failureClusters: FailureCluster[] = [];
  let recommendations: string[] = [];
  try {
    const v = JSON.parse(row.failureClusters);
    if (Array.isArray(v)) failureClusters = v;
  } catch {
    /* ignore */
  }
  try {
    const v = JSON.parse(row.recommendations);
    if (Array.isArray(v)) recommendations = v.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignore */
  }
  return { diagnosis: row.diagnosis, failureClusters, highlights: row.highlights, recommendations };
}

export type RunJobAnalysisResult =
  | { status: "ok"; cached: boolean; analysis: JobAnalysis; model: string; durationMs?: number | null }
  | { status: "not_found" | "gateway_unavailable" | "parse_error" | "llm_error" | "error"; error?: string };

export async function runJobAnalysis(jobId: string, opts: { force?: boolean } = {}): Promise<RunJobAnalysisResult> {
  try {
    if (!opts.force) {
      const cached = await prisma.funnelJobAnalysis.findUnique({ where: { jobId } });
      if (cached) {
        return { status: "ok", cached: true, analysis: jobRowToAnalysis(cached), model: cached.model, durationMs: cached.durationMs };
      }
    }
    const ctx = await assembleJobContext(jobId);
    if (!ctx) return { status: "not_found" };
    if (!isGatewayConfigured()) return { status: "gateway_unavailable" };

    let llm: Awaited<ReturnType<typeof chatComplete>>;
    try {
      llm = await chatComplete({
        system: JOB_ANALYSIS_SYSTEM_PROMPT,
        user: composeJobUser(ctx),
        temperature: 0.2,
        maxTokens: 1600,
        toolName: "Funnel.jobAnalysis",
      });
    } catch (e) {
      return { status: "llm_error", error: (e as Error).message.slice(0, 200) };
    }

    let analysis: JobAnalysis;
    try {
      analysis = parseJobAnalysis(llm.text);
    } catch (e) {
      return { status: "parse_error", error: (e as Error).message.slice(0, 200) };
    }

    const data = {
      model: llm.modelUsed,
      diagnosis: analysis.diagnosis,
      failureClusters: JSON.stringify(analysis.failureClusters),
      highlights: analysis.highlights,
      recommendations: JSON.stringify(analysis.recommendations),
      rawJson: JSON.stringify(analysis),
      candidateCount: ctx.total,
      promptTokens: llm.usage?.promptTokens ?? null,
      completionTokens: llm.usage?.completionTokens ?? null,
      durationMs: llm.durationMs ?? null,
    };
    await prisma.funnelJobAnalysis.upsert({
      where: { jobId },
      create: { jobId, ...data },
      update: { ...data, createdAt: new Date() },
    });

    return { status: "ok", cached: false, analysis, model: llm.modelUsed, durationMs: llm.durationMs };
  } catch (e) {
    return { status: "error", error: (e as Error).message.slice(0, 200) };
  }
}
