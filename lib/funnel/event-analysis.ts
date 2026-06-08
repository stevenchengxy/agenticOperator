// 流程追踪 · 单事件 AI 分析的「串联查库」+ prompt 组装 + 解析。
//
// 这一层就是用户说的"AI agent 搜索数据库并串联查询"：给定一个事件 id，
// 顺着 payload 里的 candidate_id / job_requisition_id / audit_id 把跨表证据
// 串起来 —— 事件本体、候选人在整条招聘链上的全部事件、以及背后规则检查
// 审计的完整 LLM 推理（llm_raw_text / failure_reasons / 通过的规则）。
// 然后交给 LLM 产出结构化分析。observability 性质：不上 Inngest。

import { prisma } from "@/server/db";
import { chatComplete, isGatewayConfigured } from "@/server/llm/gateway";
import { eventToStage, STAGE_META, type PipelineStage } from "@/lib/events/pipeline-stages";

const CAND_RE = /"candidate_id"\s*:\s*"([^"]+)"/;
const JR_RE = /"job_requisition_id"\s*:\s*"([^"]+)"/;
const AUDIT_RE = /"audit_id"\s*:\s*"([^"]+)"/;
const DEC_RE = /"decision"\s*:\s*"([^"]+)"/;

export type ChainStep = {
  name: string;
  ts: string;
  stage: PipelineStage;
  stageLabel: string;
  decision: string | null;
  isCurrent: boolean;
};

export type AuditEvidence = {
  decision: string;
  llmDecision: string;
  llmModel: string;
  failureReasons: string[];
  rulesEvaluated: number;
  ruleProvenance: unknown;
  llmRawTextExcerpt: string | null;
  client: string | null;
};

export type EventContext = {
  eventId: string;
  candidateId: string;
  event: {
    name: string;
    ts: string;
    stage: PipelineStage;
    stageLabel: string;
    decision: string | null;
    jobId: string | null;
    source: string;
  };
  chain: ChainStep[];
  audit: AuditEvidence | null;
};

export type EventAnalysis = {
  summary: string;
  chainRole: string;
  reasoning: string;
  risks: string[];
  nextStep: string;
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

/** 串联查库：把一个事件的跨表证据拼成分析上下文。找不到事件返回 null。 */
export async function assembleEventContext(eventId: string): Promise<EventContext | null> {
  const ev = await prisma.eventInstance.findUnique({ where: { id: eventId } });
  if (!ev) return null;

  const payloadRaw = ev.payloadSummary ?? "";
  const candidateId = CAND_RE.exec(payloadRaw)?.[1] ?? "";
  const jobId = JR_RE.exec(payloadRaw)?.[1] ?? null;
  const auditId = AUDIT_RE.exec(payloadRaw)?.[1] ?? null;
  const stage = eventToStage(ev.name);

  // ① 候选人在整条招聘链上的全部事件（定位"这一步在链路的哪里"）。
  let chain: ChainStep[] = [];
  if (candidateId) {
    const rows = await prisma.eventInstance.findMany({
      where: { payloadSummary: { contains: candidateId } },
      orderBy: { ts: "asc" },
      take: 200,
      select: { id: true, name: true, ts: true, payloadSummary: true },
    });
    chain = rows.map((r) => {
      const st = eventToStage(r.name);
      return {
        name: r.name,
        ts: r.ts.toISOString(),
        stage: st,
        stageLabel: STAGE_META[st].zh,
        decision: DEC_RE.exec(r.payloadSummary ?? "")?.[1] ?? null,
        isCurrent: r.id === ev.id,
      };
    });
  }

  // ② 背后规则检查审计的完整 LLM 推理证据。
  let audit: AuditEvidence | null = null;
  if (auditId) {
    const a = await prisma.ruleCheckAudit.findUnique({
      where: { audit_id: auditId },
      select: {
        decision: true,
        llm_decision: true,
        llm_model: true,
        failure_reasons: true,
        rules_evaluated: true,
        rule_provenance: true,
        llm_raw_text: true,
        client_display_name: true,
      },
    });
    if (a) {
      audit = {
        decision: a.decision,
        llmDecision: a.llm_decision,
        llmModel: a.llm_model,
        failureReasons: jsonArray(a.failure_reasons),
        rulesEvaluated: a.rules_evaluated,
        ruleProvenance: a.rule_provenance ? safeParse(a.rule_provenance) : null,
        llmRawTextExcerpt: a.llm_raw_text ? a.llm_raw_text.slice(0, 2000) : null,
        client: a.client_display_name ?? null,
      };
    }
  }

  return {
    eventId: ev.id,
    candidateId,
    event: {
      name: ev.name,
      ts: ev.ts.toISOString(),
      stage,
      stageLabel: STAGE_META[stage].zh,
      decision: DEC_RE.exec(payloadRaw)?.[1] ?? null,
      jobId,
      source: ev.source,
    },
    chain,
    audit,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export const ANALYSIS_SYSTEM_PROMPT = `你是招聘流程的"事件分析助手"。你会收到一个招聘事件、它在候选人整条招聘链路中的位置、以及背后规则检查的 LLM 推理证据。

任务：对这个事件做业务化的分析总结。要求：
- 只依据提供的数据，绝不臆测或编造数据里没有的事实。
- 用中文，面向招聘运营（业务语言，不堆术语）。
- 结合"链路位置"说明这一步前后发生了什么、是不是关键闸口。
- "reasoning" 要基于规则检查审计里 LLM 的真实判断证据（通过/拦截、失败原因、评估的规则）复述其推理逻辑；没有审计证据就说明"无底层 LLM 证据"。

严格只输出一个 JSON 对象，不要加任何解释或代码围栏：
{"summary": "1-2句：这个事件是什么、结果如何", "chainRole": "这一步在整条招聘链路的定位（前序/后续、是否关键闸口）", "reasoning": "背后 LLM 的推理判断摘要（基于审计证据）", "risks": ["风险或注意点", "..."], "nextStep": "建议的下一步"}`;

export function composeAnalysisUser(ctx: EventContext): string {
  // 控制体积：链路只给名称+阶段+决策+时间，审计原文截断。
  const compact = {
    当前事件: {
      事件: ctx.event.name,
      业务阶段: ctx.event.stageLabel,
      结果: ctx.event.decision,
      时间: ctx.event.ts,
      候选人: ctx.candidateId,
      岗位: ctx.event.jobId,
    },
    候选人整条链路: ctx.chain.map((s) => ({
      阶段: s.stageLabel,
      事件: s.name,
      结果: s.decision,
      时间: s.ts,
      这就是当前事件: s.isCurrent || undefined,
    })),
    规则检查审计证据: ctx.audit
      ? {
          最终决策: ctx.audit.decision,
          LLM决策: ctx.audit.llmDecision,
          模型: ctx.audit.llmModel,
          评估规则数: ctx.audit.rulesEvaluated,
          失败原因: ctx.audit.failureReasons,
          LLM原文摘录: ctx.audit.llmRawTextExcerpt,
        }
      : "无底层规则检查审计证据",
  };
  return JSON.stringify(compact, null, 2);
}

export function parseAnalysis(text: string): EventAnalysis {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLM 未返回 JSON 对象");
  const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    summary: str(obj.summary),
    chainRole: str(obj.chainRole),
    reasoning: str(obj.reasoning),
    risks: Array.isArray(obj.risks) ? obj.risks.filter((x): x is string => typeof x === "string") : [],
    nextStep: str(obj.nextStep),
  };
}

export function rowToAnalysis(row: {
  summary: string;
  chainRole: string;
  reasoning: string;
  risksJson: string;
  nextStep: string;
}): EventAnalysis {
  let risks: string[] = [];
  try {
    const v = JSON.parse(row.risksJson);
    if (Array.isArray(v)) risks = v.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignore */
  }
  return { summary: row.summary, chainRole: row.chainRole, reasoning: row.reasoning, risks, nextStep: row.nextStep };
}

export type RunEventAnalysisResult =
  | {
      status: "ok";
      cached: boolean;
      analysis: EventAnalysis;
      model: string;
      durationMs?: number | null;
      promptTokens?: number | null;
      completionTokens?: number | null;
    }
  | { status: "not_found" | "gateway_unavailable" | "parse_error" | "llm_error" | "error"; error?: string };

/** 单事件分析的完整流程：缓存命中 → 串联查库 → LLM → 解析 → 落缓存。
 *  单事件路由与批量预生成共用同一份逻辑。 */
export async function runEventAnalysis(
  eventId: string,
  opts: { force?: boolean } = {},
): Promise<RunEventAnalysisResult> {
  try {
    if (!opts.force) {
      const cached = await prisma.funnelEventAnalysis.findUnique({ where: { eventId } });
      if (cached) {
        return { status: "ok", cached: true, analysis: rowToAnalysis(cached), model: cached.model, durationMs: cached.durationMs };
      }
    }

    const ctx = await assembleEventContext(eventId);
    if (!ctx) return { status: "not_found" };
    if (!isGatewayConfigured()) return { status: "gateway_unavailable" };

    let llm: Awaited<ReturnType<typeof chatComplete>>;
    try {
      llm = await chatComplete({
        system: ANALYSIS_SYSTEM_PROMPT,
        user: composeAnalysisUser(ctx),
        temperature: 0.2,
        maxTokens: 1400,
        toolName: "Funnel.eventAnalysis",
      });
    } catch (e) {
      return { status: "llm_error", error: (e as Error).message.slice(0, 200) };
    }

    let analysis: EventAnalysis;
    try {
      analysis = parseAnalysis(llm.text);
    } catch (e) {
      return { status: "parse_error", error: (e as Error).message.slice(0, 200) };
    }

    const data = {
      candidateId: ctx.candidateId,
      eventName: ctx.event.name,
      model: llm.modelUsed,
      summary: analysis.summary,
      chainRole: analysis.chainRole,
      reasoning: analysis.reasoning,
      risksJson: JSON.stringify(analysis.risks),
      nextStep: analysis.nextStep,
      rawJson: JSON.stringify(analysis),
      promptTokens: llm.usage?.promptTokens ?? null,
      completionTokens: llm.usage?.completionTokens ?? null,
      durationMs: llm.durationMs ?? null,
    };
    await prisma.funnelEventAnalysis.upsert({
      where: { eventId },
      create: { eventId, ...data },
      update: { ...data, createdAt: new Date() },
    });

    return {
      status: "ok",
      cached: false,
      analysis,
      model: llm.modelUsed,
      durationMs: llm.durationMs,
      promptTokens: llm.usage?.promptTokens,
      completionTokens: llm.usage?.completionTokens,
    };
  } catch (e) {
    return { status: "error", error: (e as Error).message.slice(0, 200) };
  }
}
