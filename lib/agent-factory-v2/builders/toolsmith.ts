import type { BuilderCtx, TargetAgentBrief, ToolSelection } from "../types";
import { recordLlmCall, type PersistLlmCall } from "../ledger";
import { inferRetries as _inferRetries } from "@/lib/agent-factory-gen/generate";
import { ToolRegistry, toolSignature } from "@/lib/tools/registry";

/** Resolve the registry: use ctx.registry if present, else an empty registry (tools=[]) */
function getRegistry(ctx: BuilderCtx): ToolRegistry {
  return ctx.registry ?? new ToolRegistry();
}

/** Parse the LLM response for a tool selection JSON: { tools: string[], retries: number } */
function parseToolSelection(text: string, ctx: BuilderCtx): ToolSelection | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { tools?: unknown; retries?: unknown };
    if (!Array.isArray(o.tools)) return null;
    const reg = getRegistry(ctx);
    // Validate: drop hallucinated tool names
    const valid = (o.tools as unknown[])
      .filter((t): t is string => typeof t === "string" && reg.has(t));
    if (valid.length === 0) return null;
    const retries = typeof o.retries === "number" && o.retries >= 0 ? Math.floor(o.retries) : _inferRetries(valid);
    return { tools: valid, retries };
  } catch {
    return null;
  }
}

/** Build the catalog string for the LLM: each tool's signature + description. */
function buildCatalog(ctx: BuilderCtx): string {
  const reg = getRegistry(ctx);
  return reg
    .list()
    .map((t) => `- ${toolSignature(t)}\n  用途: ${t.description}`)
    .join("\n");
}

export async function selectTools(
  ctx: BuilderCtx,
  brief: TargetAgentBrief,
  persist: PersistLlmCall,
): Promise<ToolSelection> {
  const catalog = buildCatalog(ctx);

  const system = [
    "你是 agent 工厂的 ToolSmith 模块。",
    "根据 agent 简报和工具目录,选择该 agent 需要使用的工具子集,并给出重试次数。",
    "返回 JSON: { \"tools\": [\"tool.name\", ...], \"retries\": <0|1|2> }",
    "规则:",
    "- 只选目录中存在的工具名(精确匹配)",
    "- retries=0 表示不重试(适合解析类工具),retries=2 表示需要高可靠性(适合 vendor-flaky 操作)",
    "- 无任何解释、无 markdown 代码块标记",
  ].join("\n");

  const user = [
    `Agent 简报:`,
    `  名称: ${brief.name}`,
    `  触发: ${brief.trigger.join(", ") || "—"}`,
    `  发出: ${brief.emit.join(", ") || "—"}`,
    `  数据对象: ${brief.objects.join(", ") || "—"}`,
    `  rationale: ${brief.rationale}`,
    ``,
    `工具目录:`,
    catalog,
  ].join("\n");

  const { text } = await recordLlmCall(ctx, {
    builder: "toolsmith",
    target: brief.name,
    purpose: "选择工具",
    system,
    user,
    persist,
    maxTokens: 400,
  });

  const parsed = parseToolSelection(text, ctx);
  if (!parsed) {
    throw new Error(`toolsmith 为 ${brief.name} 返回无法解析或全部幻觉的工具选择(无降级):${text.slice(0, 160)}`);
  }
  return parsed;
}
