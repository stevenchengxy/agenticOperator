/**
 * skillsmith.ts — Plan 4 Chunk A
 *
 * `buildSkills` converts the planner's skill briefs into `SkillSpec[]`.
 * For each brief it asks the LLM for a promptFragment, tools list, and
 * decisionRule, validates tool names against the registry, and emits a
 * `skill.built` event. Falls back gracefully when the gateway is down.
 */

import type { BuilderCtx, SkillSpec } from "../types";
import { recordLlmCall, type PersistLlmCall } from "../ledger";
import { ToolRegistry, toolSignature } from "@/lib/tools/registry";

/** Resolve the registry: use ctx.registry if present, else an empty registry */
function getRegistry(ctx: BuilderCtx): ToolRegistry {
  return ctx.registry ?? new ToolRegistry();
}

/** Build the catalog string: each tool's signature for the LLM prompt. */
function buildCatalog(ctx: BuilderCtx): string {
  const reg = getRegistry(ctx);
  const tools = reg.list();
  if (tools.length === 0) return "（无工具）";
  return tools.map((t) => `- ${toolSignature(t)}\n  用途: ${t.description}`).join("\n");
}

interface SkillLlmResponse {
  promptFragment: string;
  tools: string[];
  decisionRule: string;
}

function parseSkillResponse(text: string): SkillLlmResponse | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { promptFragment?: unknown; tools?: unknown; decisionRule?: unknown };
    if (typeof o.promptFragment !== "string") return null;
    const tools = Array.isArray(o.tools)
      ? (o.tools as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const decisionRule = typeof o.decisionRule === "string" ? o.decisionRule : "";
    return { promptFragment: o.promptFragment, tools, decisionRule };
  } catch {
    return null;
  }
}

/**
 * Build SkillSpec[] from the planner's skill briefs.
 * Never throws — uses graceful fallback per skill when the gateway is down.
 */
export async function buildSkills(
  ctx: BuilderCtx,
  briefs: { name: string; purpose: string }[],
  persist: PersistLlmCall,
): Promise<SkillSpec[]> {
  if (briefs.length === 0) return [];

  const catalog = buildCatalog(ctx);
  const reg = getRegistry(ctx);

  const results: SkillSpec[] = [];

  for (const brief of briefs) {
    const system = [
      "你是 agent 工厂的 SkillSmith 模块。",
      "根据技能简报和工具目录,生成该技能的 prompt 片段、工具列表和决策规则。",
      "返回 JSON: { \"promptFragment\": \"...\", \"tools\": [\"tool.name\", ...], \"decisionRule\": \"...\" }",
      "规则:",
      "- promptFragment: 简洁的中文 prompt 片段,描述该技能的执行步骤(100字以内)",
      "- tools: 只选目录中存在的工具名(精确匹配)",
      "- decisionRule: 决策规则(何时应用该技能)",
      "- 无任何解释、无 markdown 代码块标记",
    ].join("\n");

    const user = [
      `技能名称: ${brief.name}`,
      `技能目的: ${brief.purpose}`,
      ``,
      `工具目录:`,
      catalog,
    ].join("\n");

    // Real LLM or throw — no fallback skill spec.
    const { text } = await recordLlmCall(ctx, {
      builder: "skillsmith",
      target: brief.name,
      purpose: "构建技能规格",
      system,
      user,
      persist,
      maxTokens: 600,
    });

    const parsed = parseSkillResponse(text);
    if (!parsed) {
      throw new Error(`skillsmith 为 ${brief.name} 返回无法解析的技能 JSON(无降级):${text.slice(0, 160)}`);
    }
    // Validate tools — drop hallucinated names not in registry
    const validTools = parsed.tools.filter((t) => reg.has(t));
    const spec: SkillSpec = {
      name: brief.name,
      purpose: brief.purpose,
      promptFragment: parsed.promptFragment || brief.purpose,
      tools: validTools,
      decisionRule: parsed.decisionRule,
    };
    ctx.emit({ t: "skill.built", name: spec.name, tools: spec.tools });
    results.push(spec);
  }

  return results;
}
