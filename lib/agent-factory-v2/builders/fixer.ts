/**
 * fixer.ts — Plan 3
 *
 * LLM-powered self-repair for individual GeneratedAgentSpec failures detected by
 * simulateChain. Asks the LLM for a minimal patch (trigger/emit/tools updates),
 * validates and applies it. Degrades gracefully when the gateway is unavailable.
 *
 * Emits BuildEvent repair.start / repair.done (variants added in types.ts).
 * NEVER throws — callers expect changed:false on any failure.
 */

import type { BuilderCtx } from "../types";
import type { PersistLlmCall } from "../ledger";
import { recordLlmCall } from "../ledger";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import { toolSignature } from "@/lib/tools/registry";

export interface FixerFailure {
  kind: "dangling" | "unreached" | "tool-error";
  detail: string;
}

export interface FixerResult {
  spec: GeneratedAgentSpec;
  changed: boolean;
}

/** Parsed patch returned by the LLM: only the fields present should be applied. */
interface SpecPatch {
  trigger?: string[];
  emit?: string[];
  tools?: string[];
  reason?: string;
}

function parsePatch(text: string): SpecPatch | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const patch: SpecPatch = {};
    if (Array.isArray(o.trigger) && o.trigger.every((x) => typeof x === "string")) {
      patch.trigger = o.trigger as string[];
    }
    if (Array.isArray(o.emit) && o.emit.every((x) => typeof x === "string")) {
      patch.emit = o.emit as string[];
    }
    if (Array.isArray(o.tools) && o.tools.every((x) => typeof x === "string")) {
      patch.tools = o.tools as string[];
    }
    if (typeof o.reason === "string") patch.reason = o.reason;
    // Reject empty patches (only reason)
    if (!patch.trigger && !patch.emit && !patch.tools) return null;
    return patch;
  } catch {
    return null;
  }
}

/** Apply a validated patch to a spec. Returns {spec, changed}. */
function applyPatch(
  spec: GeneratedAgentSpec,
  patch: SpecPatch,
  registry: NonNullable<BuilderCtx["registry"]>,
): FixerResult {
  let changed = false;
  let next = { ...spec };

  if (patch.trigger) {
    const triggers = patch.trigger.filter((t) => typeof t === "string" && t.trim());
    if (triggers.length > 0 && JSON.stringify(triggers) !== JSON.stringify(spec.trigger)) {
      next = { ...next, trigger: triggers };
      changed = true;
    }
  }

  if (patch.emit) {
    const emits = patch.emit.filter((e) => typeof e === "string" && e.trim());
    if (emits.length > 0 && JSON.stringify(emits) !== JSON.stringify(spec.emit)) {
      next = { ...next, emit: emits };
      changed = true;
    }
  }

  if (patch.tools) {
    // Validate: only keep tools that exist in the registry
    const validTools = patch.tools.filter((t) => registry.has(t));
    if (validTools.length > 0 && JSON.stringify(validTools) !== JSON.stringify(spec.tools)) {
      next = { ...next, tools: validTools };
      changed = true;
    }
  }

  return { spec: next, changed };
}

export async function fix(
  ctx: BuilderCtx,
  spec: GeneratedAgentSpec,
  failure: FixerFailure,
  persist: PersistLlmCall,
): Promise<FixerResult> {
  // Emit repair.start
  ctx.emit({ t: "repair.start", agent: spec.short, kind: failure.kind });

  // If no registry, can't validate tool patches → degrade
  const registry = ctx.registry;
  if (!registry) {
    ctx.emit({ t: "repair.done", agent: spec.short, changed: false });
    return { spec, changed: false };
  }

  // Build tool catalog for the LLM
  const catalog = registry
    .list()
    .map((t) => `- ${toolSignature(t)}`)
    .join("\n") || "（无可用工具）";

  // Known domain events (from ontology)
  const knownEvents = [
    ...new Set([
      ...(ctx.ontology.events ?? []).map((e) => (typeof e === "string" ? e : (e as { name?: string }).name ?? "")),
      // Also include events from all specs' trigger/emit arrays (not available here directly,
      // but the spec's own trigger/emit gives context)
      ...spec.trigger,
      ...spec.emit,
    ]),
  ]
    .filter(Boolean)
    .join(", ");

  const system = [
    "你是 agent 工厂的 Fixer 模块。",
    "给定一个 agent spec 的当前 trigger/emit/tools 以及一个失败原因,提供最小化的修复补丁。",
    "只修改必要的字段。以 JSON 格式返回补丁:{ \"trigger\"?: string[], \"emit\"?: string[], \"tools\"?: string[], \"reason\": string }",
    "规则:",
    "- trigger/emit 必须是合法的事件名字符串",
    "- tools 只能包含工具目录中存在的工具名(精确匹配)",
    "- 如无需修改某字段则省略它(不要包含空数组)",
    "- reason 简要说明修复逻辑(中文即可)",
    "- 无额外解释、无 markdown 代码块",
  ].join("\n");

  const user = [
    `Agent: ${spec.short}`,
    `当前 trigger: ${spec.trigger.join(", ") || "（无）"}`,
    `当前 emit: ${spec.emit.join(", ") || "（无）"}`,
    `当前 tools: ${spec.tools.join(", ") || "（无）"}`,
    ``,
    `失败类型: ${failure.kind}`,
    `失败详情: ${failure.detail}`,
    ``,
    `工具目录:`,
    catalog,
    ``,
    `域内已知事件(供参考): ${knownEvents || "（无）"}`,
  ].join("\n");

  // Real LLM repair or throw (no fallback). A successful call that proposes no
  // applicable structural patch is a legitimate no-op (changed=false), NOT a fake.
  const { text } = await recordLlmCall(ctx, {
    builder: "fixer",
    target: spec.short,
    purpose: `修复 ${failure.kind} 失败`,
    system,
    user,
    persist,
    maxTokens: 500,
  });

  let changed = false;
  let patchedSpec = spec;
  const patch = parsePatch(text);
  if (patch) {
    const applied = applyPatch(spec, patch, registry);
    patchedSpec = applied.spec;
    changed = applied.changed;
  }

  ctx.emit({ t: "repair.done", agent: spec.short, changed });
  return { spec: patchedSpec, changed };
}
