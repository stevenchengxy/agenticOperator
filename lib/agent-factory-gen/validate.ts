// Static validation of a generated agent set — the cheap, generation-time gate.
// Catches the failure modes that don't need a run to detect: dangling/orphan
// events (event-action graph not closed), hallucinated tools, empty prompts,
// slug collisions. This is "事件-动作图闭合可执行" turned into a real check.

import type { GenerationContext } from "./context";
import type { ValidationReport } from "./types";

const uniq = (xs: string[]) => [...new Set(xs)];
function dups(xs: string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const x of xs) {
    if (seen.has(x)) out.add(x);
    seen.add(x);
  }
  return [...out];
}

export function validate(ctx: GenerationContext): ValidationReport {
  const consumed = new Set<string>();
  const produced = new Set<string>();
  for (const s of ctx.specs) {
    s.trigger.forEach((t) => consumed.add(t));
    s.emit.forEach((e) => produced.add(e));
  }

  // emitted but nobody consumes, and not a declared terminal
  const danglingEmits = [...produced].filter((e) => !consumed.has(e) && !ctx.terminalEvents.has(e)).sort();
  // consumed but nobody produces, and not a declared entry
  const orphanTriggers = [...consumed].filter((t) => !produced.has(t) && !ctx.entryEvents.has(t)).sort();

  const hallucinatedTools = uniq(ctx.specs.flatMap((s) => s.tools).filter((t) => !ctx.registry.has(t))).sort();
  const unresolvedTools = uniq(ctx.specs.flatMap((s) => s.unresolvedTools)).sort();
  const emptyToolAgents = ctx.specs.filter((s) => s.tools.length === 0).map((s) => s.slug);
  const emptyPrompts = ctx.specs.filter((s) => !s.systemPrompt.trim()).map((s) => s.slug);
  const slugCollisions = dups(ctx.specs.map((s) => s.slug));

  const notes: string[] = [];
  if (danglingEmits.length) notes.push(`悬挂事件(emit 无消费者): ${danglingEmits.join(", ")}`);
  if (orphanTriggers.length) notes.push(`孤儿触发(trigger 无生产者): ${orphanTriggers.join(", ")}`);
  if (hallucinatedTools.length) notes.push(`幻觉工具(不在 registry): ${hallucinatedTools.join(", ")}`);
  if (unresolvedTools.length) notes.push(`未解析的 tool_use(本域 registry 无对应工具): ${unresolvedTools.join(", ")}`);
  if (emptyToolAgents.length) notes.push(`零工具 agent(不会做任何事): ${emptyToolAgents.join(", ")}`);
  if (emptyPrompts.length) notes.push(`空 prompt: ${emptyPrompts.join(", ")}`);
  if (slugCollisions.length) notes.push(`slug 冲突: ${slugCollisions.join(", ")}`);
  if (!notes.length) notes.push("事件-动作图闭合,工具全部解析,无幻觉/冲突。");

  const ok =
    danglingEmits.length === 0 &&
    orphanTriggers.length === 0 &&
    hallucinatedTools.length === 0 &&
    unresolvedTools.length === 0 &&
    emptyToolAgents.length === 0 &&
    emptyPrompts.length === 0 &&
    slugCollisions.length === 0;

  return { ok, danglingEmits, orphanTriggers, hallucinatedTools, unresolvedTools, emptyToolAgents, emptyPrompts, slugCollisions, notes };
}
