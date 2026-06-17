/**
 * generate.ts — Plan 2 Chunk B, Task B1
 *
 * `generateAgents(ctx, plan, persist)` fans each TargetAgentBrief through
 * ToolSmith → PromptWriter → Critic (parallel across agents, 1 Critic re-loop
 * max), then assembles a GeneratedAgentSpec[] (v1 type).
 *
 * Deterministic fallback is wired into every builder, so this works hermetically
 * when the gateway is unconfigured.
 */

import type { BuilderCtx, BuildPlan, SkillSpec } from "./types";
import type { PersistLlmCall } from "./ledger";
import { selectTools } from "./builders/toolsmith";
import { writePrompt } from "./builders/prompt-writer";
import { critique } from "./builders/critic";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import { kebab, pascal, slugifyDomain, deriveSteps } from "@/lib/agent-factory-gen/generate";
import type { RichAction } from "@/lib/agent-factory-gen/generate";
import { actionRole } from "@/lib/agent-factory-gen/context";

/** Build one GeneratedAgentSpec from a brief by running the three builder stages. */
async function assembleAgent(
  ctx: BuilderCtx,
  brief: import("./types").TargetAgentBrief,
  persist: PersistLlmCall,
  skills: SkillSpec[] = [],
): Promise<GeneratedAgentSpec> {
  ctx.emit({ t: "agent.start", name: brief.name });

  // Stage 1: ToolSmith
  const toolSel = await selectTools(ctx, brief, persist);

  // Compute relevant skills: skills sharing ≥1 tool with this agent's selected tools
  const relevantSkills = skills.filter(
    (skill) => skill.tools.some((t) => toolSel.tools.includes(t)),
  );

  // Stage 2: PromptWriter
  let promptResult = await writePrompt(ctx, brief, toolSel.tools, persist, relevantSkills);

  // Stage 3: Critic (1 re-loop max)
  let critiqueResult = await critique(ctx, brief, promptResult, toolSel.tools, persist);

  if (!critiqueResult.approved) {
    // One retry: re-run PromptWriter with issues injected into rationale
    const issueHints = critiqueResult.issues.length
      ? `\n修复意见: ${critiqueResult.issues.slice(0, 4).join("; ")}`
      : "";
    const revisedBrief = { ...brief, rationale: brief.rationale + issueHints };
    promptResult = await writePrompt(ctx, revisedBrief, toolSel.tools, persist, relevantSkills);
    // Accept the revised prompt regardless of a second critique
    critiqueResult = await critique(ctx, brief, promptResult, toolSel.tools, persist);
  }

  // Find the corresponding ontology action (for deriveSteps + ruleRefs)
  const action = ctx.ontology.actions.find((a) => a.name === brief.name) as RichAction | undefined;
  const steps = deriveSteps(action ?? ({
    id: brief.name,
    name: brief.name,
    trigger: brief.trigger,
    triggered_event: brief.emit,
    target_objects: brief.objects,
    tool_use: toolSel.tools,
    description: brief.rationale,
    system_prompt: "",
    user_prompt: "",
    actor: ["Agent"],
  } as RichAction), toolSel.tools);

  const slug = `${slugifyDomain(ctx.domain)}-${kebab(brief.name)}`;
  const short = `${pascal(brief.name)}Agent`;

  // Determine kind: hitl from action role (or default "llm")
  const role = action ? actionRole(action) : "agent";
  const kind: GeneratedAgentSpec["kind"] = role === "hitl" ? "simulated-human" : "llm";

  // Rule refs from brief (already extracted by Planner)
  const ruleRefs = brief.ruleRefs ?? [];

  // Unresolved tools: brief.objects is data objects, not tools —
  // unresolved tool_use entries from the action if available
  const actionToolUse = (action as (RichAction & { tool_use?: string[] }) | undefined)?.tool_use ?? [];
  const unresolvedTools = actionToolUse.filter(
    (t) => !toolSel.tools.includes(t) && t && t !== "—",
  );

  // Confidence from the REAL Critic score (0..1) when the Critic actually ran;
  // only a degraded/unparseable critique (score 0) falls back to a source-based
  // floor. Replaces the old hardcoded 90/75 that ignored the Critic entirely.
  const confidence = critiqueResult.score > 0
    ? Math.round(critiqueResult.score * 100)
    : (promptResult.source === "llm" ? 70 : 55);

  const spec: GeneratedAgentSpec = {
    key: brief.name,
    actionName: brief.name,
    slug,
    short,
    domainId: ctx.domain,
    nameZh: (action as (RichAction & { description?: string }) | undefined)?.description?.split(/[。;，,;\n]/)[0]?.trim()?.slice(0, 18) || brief.name,
    kind,
    trigger: brief.trigger,
    emit: brief.emit,
    tools: toolSel.tools,
    unresolvedTools,
    objects: brief.objects,
    systemPrompt: promptResult.system,
    userPrompt: promptResult.user,
    steps,
    ruleRefs,
    retries: toolSel.retries,
    hitl: role === "hitl",
    confidence,
    promptSource: promptResult.source,
  };

  ctx.emit({
    t: "agent.assembled",
    name: brief.name,
    tools: toolSel.tools,
    promptSource: promptResult.source,
    spec: {
      slug: spec.slug,
      short: spec.short,
      kind: spec.kind,
      nameZh: spec.nameZh,
      trigger: spec.trigger,
      emit: spec.emit,
      objects: spec.objects,
      retries: spec.retries,
      confidence: spec.confidence,
      systemPrompt: spec.systemPrompt,
      userPrompt: spec.userPrompt,
      steps: spec.steps.map((s) => ({ name: s.name, tool: s.tool ?? null })),
    },
  });

  return spec;
}

/**
 * Fan out the generation pipeline across all briefs in `plan` using Promise.all.
 * Each brief → ToolSmith → PromptWriter → Critic (1 re-loop max) → GeneratedAgentSpec.
 * Emits `agent.start` / `agent.assembled` per agent.
 *
 * @param skills - Optional SkillSpec[] from SkillSmith; relevant skills are woven
 *                 into each agent's system prompt by PromptWriter.
 */
export async function generateAgents(
  ctx: BuilderCtx,
  plan: BuildPlan,
  persist: PersistLlmCall,
  skills: SkillSpec[] = [],
): Promise<GeneratedAgentSpec[]> {
  const specs = await Promise.all(
    plan.agents.map((brief) => assembleAgent(ctx, brief, persist, skills)),
  );
  return specs;
}
