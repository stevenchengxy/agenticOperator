import type { BuilderCtx, TargetAgentBrief, SkillSpec } from "../types";
import type { PromptSource } from "@/lib/agent-factory-gen/types";
import { recordLlmCall, type PersistLlmCall } from "../ledger";
import {
  templatePrompt,
  deriveSteps,
  type RichAction,
} from "@/lib/agent-factory-gen/generate";
import { ToolRegistry, toolSignature } from "@/lib/tools/registry";
import type { OntologyAction } from "@/lib/ontology-generator/ontology-source";
import type { GenerationContext } from "@/lib/agent-factory-gen/context";

/** Look up the ontology action matching brief.name. */
function findAction(ctx: BuilderCtx, name: string): OntologyAction | undefined {
  return ctx.ontology.actions.find((a) => a.name === name);
}

/** Resolve the registry: use ctx.registry if present, else an empty registry */
function getRegistry(ctx: BuilderCtx): ToolRegistry {
  return ctx.registry ?? new ToolRegistry();
}

/** Build a minimal GenerationContext compatible object from BuilderCtx.
 *  templatePrompt/deriveSteps only need .registry, .domainId, .ontology, .specs. */
function toGenerationCtx(ctx: BuilderCtx): GenerationContext {
  return {
    domainId: ctx.domain,
    ontology: ctx.ontology,
    registry: getRegistry(ctx),
    specs: [],
    producers: new Map(),
    consumers: new Map(),
    entryEvents: new Set(),
    terminalEvents: new Set(),
    log: [],
    emit: () => {},
    pace: () => Promise.resolve(),
  };
}

/** Build tool detail lines for the LLM prompt grounding. */
function toolDetailLines(tools: string[], genCtx: GenerationContext): string {
  return tools
    .map((name) => {
      const td = genCtx.registry.get(name);
      if (!td) return `- ${name}`;
      return `- ${toolSignature(td)}\n  用途: ${td.description}`;
    })
    .join("\n");
}

export interface PromptWriterResult {
  system: string;
  user: string;
  source: PromptSource;
}

export async function writePrompt(
  ctx: BuilderCtx,
  brief: TargetAgentBrief,
  tools: string[],
  persist: PersistLlmCall,
  skills?: SkillSpec[],
): Promise<PromptWriterResult> {
  const action = findAction(ctx, brief.name);
  const genCtx = toGenerationCtx(ctx);

  // Build a RichAction-compatible object from brief + ontology action
  const richAction: RichAction = action
    ? (action as RichAction)
    : {
        id: brief.name,
        name: brief.name,
        actor: ["Agent"],
        trigger: brief.trigger,
        triggered_event: brief.emit,
        target_objects: brief.objects,
        tool_use: tools,
        description: brief.rationale,
        system_prompt: "",
        user_prompt: "",
      };

  const steps = deriveSteps(richAction, tools);
  // Structural runtime input scaffold only (NOT a reasoning fallback): the SYSTEM
  // prompt is LLM-authored below; this supplies the cosmetic runtime user-message
  // template (the executor builds its own user message at run time).
  const runtimeTmpl = templatePrompt(richAction, genCtx, tools, steps);

  // Build the LLM prompt for authoring
  const toolLines = toolDetailLines(tools, genCtx);
  const emitList = brief.emit.join(", ") || "（无）";

  const system = [
    "你是资深的多智能体系统 prompt 工程师。",
    "根据 agent 简报和工具信息,写一份清晰、可执行的中文 system prompt。",
    "要求覆盖: ① 角色与边界; ② 触发事件; ③ 工具调用步骤(引用工具签名); ④ 决策条件(何时发出每个事件); ⑤ JSON 输出格式 {\"decision\":<事件名>,\"reason\":...}。",
    "注意: 业务判定为 FAIL/未通过是合法结论(write-only 落库,不要 throw); 只有基础设施故障才向上抛错。",
    "只返回 system prompt 正文,不加 markdown 代码块标记。",
  ].join("\n");

  const user = [
    `Agent 名称: ${brief.name}`,
    `职责: ${brief.rationale}`,
    `触发事件: ${brief.trigger.join(", ") || "—"}`,
    `可发出事件(只能选其一作为结论): ${emitList}`,
    `数据对象: ${brief.objects.join(", ") || "—"}`,
    ``,
    `可用工具(按签名调用):`,
    toolLines || "（无,纯判定 agent）",
    ``,
    `执行步骤:`,
    steps.map((s, i) => {
      const call = s.tool ? `调用 ${s.tool}` : "(判定逻辑)";
      return `${i + 1}. ${s.name} → ${call}`;
    }).join("\n"),
  ].join("\n");

  const { text } = await recordLlmCall(ctx, {
    builder: "promptwriter",
    target: brief.name,
    purpose: "撰写 system prompt",
    system,
    user,
    persist,
    maxTokens: 1200,
  });

  if (text.trim().length < 40) {
    throw new Error(`promptwriter 为 ${brief.name} 返回过短/无效的 system prompt(无降级):${text.slice(0, 120)}`);
  }

  /** Append relevant skill fragments to a system prompt body. */
  function appendSkillSection(body: string, relevantSkills: SkillSpec[]): string {
    if (!relevantSkills || relevantSkills.length === 0) return body;
    const section = "\n\n【可复用能力(skill)】\n" +
      relevantSkills.map((s) => `- ${s.name}: ${s.promptFragment}`).join("\n");
    return body + section;
  }

  const systemWithSkills = appendSkillSection(text, skills ?? []);
  return { system: systemWithSkills, user: runtimeTmpl.user, source: "llm" };
}
