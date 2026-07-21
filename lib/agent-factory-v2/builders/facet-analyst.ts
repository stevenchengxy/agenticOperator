import type { BuilderCtx, FacetInsight, FacetKind } from "../types";
import { recordLlmCall, type PersistLlmCall } from "../ledger";

function facetItems(ctx: BuilderCtx, facet: FacetKind): { names: string[]; count: number } {
  const o = ctx.ontology as unknown as Record<string, Array<Record<string, unknown>>>;
  const list = Array.isArray(o[facet]) ? o[facet] : [];
  const names = list.map((x) => String(x.name ?? x.id ?? "")).filter(Boolean).slice(0, 20);
  return { names, count: list.length };
}

export async function analyzeFacet(ctx: BuilderCtx, facet: FacetKind, persist: PersistLlmCall): Promise<FacetInsight> {
  ctx.emit({ t: "facet.start", facet });
  const { names, count } = facetItems(ctx, facet);
  // Real LLM analysis or throw (no fallback). recordLlmCall guarantees non-empty text.
  const { text } = await recordLlmCall(ctx, {
    builder: "facet-analyst", target: facet, purpose: `分析本体 ${facet}`,
    system: "你是本体分析 agent,用 2-4 句话总结这一类元素对该业务域意味着什么,并列出最关键的 3-6 个要点。只返回:第一行总结,其后每行一个要点(- 开头)。",
    user: `业务域:${ctx.domain}\n类别:${facet}(共 ${count} 项)\n样本:${names.join(", ") || "（无）"}`,
    persist,
  });
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const summary = lines[0] || `「${ctx.domain}」域 ${facet} 共 ${count} 项`;
  const highlights = lines.slice(1).map((l) => l.replace(/^[-*]\s*/, "")).filter(Boolean).slice(0, 6);
  const insight: FacetInsight = { facet, summary, highlights: highlights.length ? highlights : names.slice(0, 6), degraded: false };
  ctx.emit({ t: "facet.analyzed", facet, highlights: insight.highlights, degraded: false });
  return insight;
}
