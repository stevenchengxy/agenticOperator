import type { BuilderCtx, BuildPlan, DomainUnderstanding, TargetAgentBrief } from "../types";
import { recordLlmCall, type PersistLlmCall } from "../ledger";

function parsePlan(text: string): BuildPlan | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { agents?: unknown[]; skills?: unknown[] };
    if (!Array.isArray(o.agents) || o.agents.length === 0) return null;
    const agents: TargetAgentBrief[] = (o.agents as Array<Record<string, unknown>>).map((a) => ({
      name: String(a.name ?? ""),
      trigger: Array.isArray(a.trigger) ? (a.trigger as string[]) : [],
      emit: Array.isArray(a.emit) ? (a.emit as string[]) : [],
      objects: Array.isArray(a.objects) ? (a.objects as string[]) : [],
      ruleRefs: Array.isArray(a.ruleRefs) ? (a.ruleRefs as string[]) : [],
      rationale: String(a.rationale ?? ""),
    })).filter((a) => a.name);
    const skills = Array.isArray(o.skills)
      ? (o.skills as Array<Record<string, unknown>>).map((s) => ({ name: String(s.name ?? ""), purpose: String(s.purpose ?? "") }))
      : [];
    if (agents.length === 0) return null;
    return { agents, skills };
  } catch {
    return null;
  }
}

const namesOf = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.map((x) => String((x as { name?: unknown }).name ?? "")).filter(Boolean)
    : [];

export async function plan(
  ctx: BuilderCtx,
  understanding: DomainUnderstanding,
  persist: PersistLlmCall,
  /** When a prior plan failed static validation, the closure issues to fix —
   *  appended so the Planner RE-PLANS the decomposition instead of stopping. */
  replanFeedback?: string,
): Promise<BuildPlan> {
  // The Planner reasons the decomposition from raw domain material — the
  // per-facet analysis + the event/object vocabulary. NO precomputed agent list,
  // and NO fallback: an unparseable plan throws (the build fails, never fakes).
  const facetLines = understanding.facets
    .map((f) => `[${f.facet}] ${f.summary}${f.highlights.length ? `\n   要点: ${f.highlights.join("; ")}` : ""}`)
    .join("\n");
  const eventNames = namesOf(ctx.ontology.events);
  const objectNames = namesOf(ctx.ontology.objects);

  const system = [
    "你是 agent 工厂的 planner 模块。",
    "根据业务域的综合理解、各维度分析、以及可用的事件/对象词表,自主规划要生成哪些 agent 和哪些共享技能。",
    "决策原则:",
    "- 自主决定拆分粒度:可把多个相关职责合并成一个 agent,也可把一个复杂职责拆成多个;不要假设「一个动作=一个 agent」。",
    "- 每个 agent 的 trigger / emit 必须取自下方「可用事件」(精确事件名);要让事件首尾相接形成闭合链路——某 agent 的 emit 应当是另一 agent 的 trigger,除非它是链路的终止事件(如 *_SENT/*_FAILED/*_GENERATED)。",
    "- objects / ruleRefs 取自给定的对象信息。",
    "返回 JSON: { \"agents\": [ { \"name\", \"trigger\":[], \"emit\":[], \"objects\":[], \"ruleRefs\":[], \"rationale\" } ], \"skills\": [ { \"name\", \"purpose\" } ] }",
    "无任何解释、无 markdown 代码块标记。",
  ].join("\n");

  const user = [
    `业务域:${ctx.domain}`,
    `综合理解:\n${understanding.synthesis}`,
    `各维度分析:\n${facetLines}`,
    `可用事件(events,trigger/emit 只能从中选):\n${eventNames.join(", ") || "（无）"}`,
    `数据对象(objects):${objectNames.join(", ") || "（无）"}`,
    `规模:actions ${understanding.counts.actions} / events ${understanding.counts.events} / rules ${understanding.counts.rules} / objects ${understanding.counts.objects}`,
    replanFeedback
      ? `上一轮静态校验未通过。请调整 agent 的拆分与事件连接,使链路闭合,修复以下问题:\n${replanFeedback}`
      : "",
  ].filter(Boolean).join("\n\n");

  const { text } = await recordLlmCall(ctx, {
    builder: "planner",
    target: null,
    purpose: replanFeedback ? "重新规划 agent 清单" : "规划 agent 清单",
    system,
    user,
    persist,
    maxTokens: 1400,
  });

  const result = parsePlan(text);
  if (!result) {
    throw new Error(`planner 返回无法解析的 plan JSON(无降级):${text.slice(0, 200)}`);
  }
  ctx.emit({ t: "plan.ready", agents: result.agents.length, skills: result.skills.length });
  return result;
}
