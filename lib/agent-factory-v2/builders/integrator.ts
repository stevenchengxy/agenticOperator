import type { BuilderCtx, DomainUnderstanding, FacetInsight } from "../types";
import { recordLlmCall, type PersistLlmCall } from "../ledger";

export async function integrate(
  ctx: BuilderCtx,
  insights: FacetInsight[],
  persist: PersistLlmCall,
): Promise<DomainUnderstanding> {
  const o = ctx.ontology as unknown as Record<string, Array<unknown>>;
  const counts = {
    actions: Array.isArray(o.actions) ? o.actions.length : 0,
    events: Array.isArray(o.events) ? o.events.length : 0,
    rules: Array.isArray(o.rules) ? o.rules.length : 0,
    objects: Array.isArray(o.objects) ? o.objects.length : 0,
  };

  // Build a grounding string from the 4 facet summaries + highlights
  const facetLines = insights.map((ins) => {
    const highlightStr = ins.highlights.length
      ? ins.highlights.map((h) => `  - ${h}`).join("\n")
      : "  （无要点）";
    return `【${ins.facet}】${ins.summary}\n${highlightStr}`;
  }).join("\n\n");

  const groundingUser = [
    `业务域:${ctx.domain}`,
    `总计:actions=${counts.actions} events=${counts.events} rules=${counts.rules} objects=${counts.objects}`,
    "",
    "各切面分析:",
    facetLines,
  ].join("\n");

  const { text } = await recordLlmCall(ctx, {
    builder: "integrator",
    target: null,
    purpose: "整合本体理解",
    system: [
      "你是本体整合 agent。",
      "根据四个切面(actions/events/rules/objects)的分析,用 3-6 句话写出跨切面、综合性的业务域理解:",
      "1) 这个域的核心业务流程是什么?",
      "2) 各切面之间的关键联动是什么?",
      "3) 对 AI agent 生成有什么特别的含义?",
      "只返回综合理解正文,不加编号或标题。",
    ].join("\n"),
    user: groundingUser,
    persist,
  });

  const synthesis = text.trim();

  return {
    domain: ctx.domain,
    source: ctx.ontology.source,
    facets: insights,
    synthesis,
    counts,
  };
}
