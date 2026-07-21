// Meta-brain tools — the orchestration capabilities. Each is deterministic; the
// brain supplies the reasoning + the choices (which slots to generate, how to
// resolve a gap). The tools never decide policy on their own.

import { fetchLiveOntologyStrict } from "@/lib/ontology-generator/ontology-source";
import { listRegistryAgents } from "../registry";
import { selectFromAgents } from "../selection";
import { validateChain, type NodeNeed } from "../orchestrator";
import { buildGoldStandard, compareToStandard } from "../gold-standard";
import { factoryDispatch, mockDispatch } from "../factory-dispatch";
import type { MetaCtx, MetaTool, MetaToolResult, SlotState } from "./types";
import type { RegistryAgent } from "../types";

/** JSON-schema param helper — every tool requires a `reasoning` string so the brain
 *  articulates WHY before acting (mirrors the factory brain convention). */
function params(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties: { reasoning: { type: "string", description: "为什么现在做这一步(中文,简短)" }, ...props },
    required: ["reasoning", ...required],
  };
}

/** The agents currently bound to slots (reused + generated) = the composed set. */
function boundAgents(ctx: MetaCtx): RegistryAgent[] {
  return ctx.slots.filter((s) => s.agent).map((s) => s.agent!);
}

/** Composed nodes for chain validation, WITH the brain's remaps applied: a node that
 *  emits a remapped `from` event also effectively emits the `to` event (the adapter
 *  the orchestrator injects at deploy republishes it). Remaps whose `from` is an
 *  EXTERNAL entry (not emitted by any node) are republished by a synthetic external
 *  adapter, so remapping a platform event onto an internal trigger also works. */
function composedNodes(ctx: MetaCtx): Array<{ name: string; triggerEvents: string[]; emitEvents: string[] }> {
  const nodes = ctx.slots.filter((s) => s.agent).map((s) => {
    const a = s.agent!;
    const extra = ctx.remaps.filter((r) => a.emitEvents.includes(r.from)).map((r) => r.to);
    return { name: a.name, triggerEvents: a.triggerEvents, emitEvents: [...a.emitEvents, ...extra] };
  });
  const fromExternal = ctx.remaps.filter((r) => ctx.entryEvents.includes(r.from)).map((r) => r.to);
  if (fromExternal.length) nodes.push({ name: "__external_adapter__", triggerEvents: [], emitEvents: fromExternal });
  return nodes;
}

// ── inspect_domain ──────────────────────────────────────────────────────────
const inspect_domain: MetaTool = {
  name: "inspect_domain",
  description: "读取本域的【实时本体】(Allmeta/Neo4j,失败即报错不兜底)得到所有需要的 agent 节点槽(动作→事件签名),读取统一注册表得到可复用的现成 agent,并为每个动作配上 招聘-v1 的【黄金标准】(真实生产 agent,逆向工程出签名/决策分支/工具)。这是第一步。",
  parameters: params({}),
  async execute(_args, ctx): Promise<MetaToolResult> {
    const ont = await fetchLiveOntologyStrict(ctx.domain); // throws on empty → fail-closed
    const needs: NodeNeed[] = ont.actions
      .filter((a) => a.actor.includes("Agent"))
      .map((a) => ({ action: a.name, triggerEvents: a.trigger, emitEvents: a.triggered_event }));
    ctx.slots = needs.map((need): SlotState => ({ need, decision: "open", agent: null, reason: "" }));
    ctx.registry = await listRegistryAgents(ctx.domain);
    ctx.goldStandard = buildGoldStandard(needs);
    // event provenance: INTERNAL = what agents produce (ontology agent-action emits);
    // EXTERNAL = consumed-but-no-agent-produces = platform/human entry points where
    // INDEPENDENT agents legitimately start (NOT gaps).
    ctx.internalEvents = [...new Set(needs.flatMap((n) => n.emitEvents))];
    const internalSet = new Set(ctx.internalEvents);
    ctx.entryEvents = [...new Set(needs.flatMap((n) => n.triggerEvents))].filter((t) => !internalSet.has(t));
    const reusable = ctx.registry.filter((a) => a.sandboxProven).length;
    ctx.emit({ t: "inspect", domain: ctx.domain, slots: ctx.slots.length, reusable, standardActions: ctx.goldStandard.length });
    return {
      ok: true,
      summary: `本体 ${ctx.slots.length} 个动作槽 · 注册表 ${ctx.registry.length} 个可选(${reusable} 已验证) · 黄金标准覆盖 ${ctx.goldStandard.length} 个动作 · 外部入口事件 ${ctx.entryEvents.join("、") || "(无)"}`,
      output: {
        slots: needs.map((n) => `${n.action}: ${n.triggerEvents.join("/") || "入口"}→${n.emitEvents.join("/") || "终态"}`),
        reuseCandidates: ctx.registry.map((a) => `${a.name}[${a.source}]: ${a.triggerEvents.join("/")}→${a.emitEvents.join("/")}${a.sandboxProven ? " ✓已验证" : ""}`),
        goldStandard: ctx.goldStandard.map((g) => `${g.action} ⇐ ${g.short}(分支 ${g.emit.join("/")}; 工具 ${g.tools.join(",") || "—"})`),
        externalEntryEvents: ctx.entryEvents,
        note: "外部入口事件来自平台/人工,监听它们的 agent 是独立入口、不算断点;断点只针对【内部事件】(本应由某个 agent 产出却没人产出的)。",
      },
    };
  },
};

// ── plan_orchestration ──────────────────────────────────────────────────────
const plan_orchestration: MetaTool = {
  name: "plan_orchestration",
  description: "对每个还未绑定的槽,用事件签名打分做 build-vs-reuse 决策:有签名匹配且达标的现成 agent → 复用(直接绑定);否则 → 标记为待生成。返回计划。可在 inspect 后调用,也可在生成/解决断点后重新规划。",
  parameters: params({}),
  async execute(_args, ctx): Promise<MetaToolResult> {
    for (const slot of ctx.slots) {
      if (slot.agent) continue; // already bound (reused or generated)
      const sel = selectFromAgents(ctx.registry, { triggerEvents: slot.need.triggerEvents, emitEvents: slot.need.emitEvents, capability: slot.need.action, domain: ctx.domain });
      if (sel.decision === "reuse" && sel.best) {
        slot.decision = "reuse"; slot.agent = sel.best; slot.reason = sel.reason;
      } else {
        slot.decision = "generate"; slot.reason = sel.reason;
      }
    }
    const nodes = ctx.slots.map((s) => ({ action: s.need.action, decision: (s.decision === "open" ? "generate" : s.decision) as "reuse" | "generate", agent: s.agent?.name ?? null }));
    const reuseCount = ctx.slots.filter((s) => s.decision === "reuse").length;
    const generateCount = ctx.slots.length - reuseCount;
    ctx.emit({ t: "plan", nodes, reuseCount, generateCount });
    return {
      ok: true,
      summary: `计划:复用 ${reuseCount} 个、生成 ${generateCount} 个`,
      output: { nodes, toGenerate: ctx.slots.filter((s) => s.decision === "generate" && !s.agent).map((s) => s.need.action) },
    };
  },
};

// ── generate_agents ─────────────────────────────────────────────────────────
const generate_agents: MetaTool = {
  name: "generate_agents",
  description: "把指定的待生成动作交给【生成 Harness(工厂自主大脑)】真生成 agent(它会读本体→设计→AI 写代码→沙箱验证)。生成出来的 agent 按事件签名绑回对应的槽。actions 留空=生成所有还没绑定的槽。dryRun=true 用占位(不调 LLM,仅验证编排管路)。",
  parameters: params({
    actions: { type: "array", items: { type: "string" }, description: "要生成的动作名;留空=所有未绑定槽" },
    dryRun: { type: "boolean", description: "true=占位生成(快,验证管路);false=真驱动工厂(慢,真造)" },
  }),
  async execute(args, ctx): Promise<MetaToolResult> {
    const want = Array.isArray(args.actions) ? (args.actions as string[]) : [];
    const open = ctx.slots.filter((s) => !s.agent && (want.length === 0 || want.includes(s.need.action)));
    if (!open.length) return { ok: false, summary: "没有待生成的槽(都已绑定?先 plan_orchestration)" };
    const needs = open.map((s) => s.need);
    ctx.emit({ t: "generate.start", actions: needs.map((n) => n.action) });
    const dispatch = args.dryRun ? mockDispatch : factoryDispatch;
    const built = await dispatch(needs, ctx.domain);
    // bind built agents back to their slots by signature
    const bound: Array<{ action: string; name: string; trigger: string[]; emit: string[] }> = [];
    for (const slot of open) {
      const hit = built.find((b) => b.triggerEvents.some((t) => slot.need.triggerEvents.includes(t)) && (slot.need.emitEvents.length === 0 || b.emitEvents.some((e) => slot.need.emitEvents.includes(e))));
      if (hit) {
        slot.agent = hit; slot.decision = "generate"; slot.reason = "factory-generated";
        bound.push({ action: slot.need.action, name: hit.name, trigger: hit.triggerEvents, emit: hit.emitEvents });
      }
    }
    ctx.emit({ t: "generate.done", built: bound });
    const missed = open.filter((s) => !s.agent).map((s) => s.need.action);
    return {
      ok: bound.length > 0,
      summary: `生成并绑定 ${bound.length}/${open.length} 个${missed.length ? `;未产出:${missed.join("、")}` : ""}${args.dryRun ? "(dry-run 占位)" : ""}`,
      output: { built: bound, missed },
    };
  },
};

// ── validate_chain ──────────────────────────────────────────────────────────
const validate_chain: MetaTool = {
  name: "validate_chain",
  description: "用已绑定 agent 的【真实事件签名】(含已应用的 remap)组装事件图,校验链路是否连通。断点 = 某个被消费的 trigger 既没有上游节点产出、又不是本体真入口(常见于复用的 agent 真签名和本槽期望不一致)。",
  parameters: params({}),
  async execute(_args, ctx): Promise<MetaToolResult> {
    const { chainOk, gaps } = validateChain(composedNodes(ctx), ctx.internalEvents);
    ctx.lastGaps = gaps;
    ctx.emit({ t: "validate", chainOk, gaps });
    const unbound = ctx.slots.filter((s) => !s.agent).map((s) => s.need.action);
    return {
      ok: chainOk && unbound.length === 0,
      summary: `${chainOk ? "链路连通 ✓" : `⚠ ${gaps.length} 处断点`}${unbound.length ? ` · ${unbound.length} 个槽未绑定(${unbound.join("、")})` : ""}`,
      output: { chainOk, gaps, unbound },
    };
  },
};

// ── resolve_gap ─────────────────────────────────────────────────────────────
const resolve_gap: MetaTool = {
  name: "resolve_gap",
  description: "针对一个链路断点做决策并应用。decision=remap:断言某个上游/入口事件 remapFrom 在语义上等同于断点期望的 event(编排器在部署时注入一个事件适配器把 remapFrom 转发成 event)——零额外生成。decision=generate:放弃在该槽复用现成 agent(它自带的 trigger 对不齐),把该槽改回【待生成】,稍后用 generate_agents 重造一个签名严格匹配本链的 agent。",
  parameters: params({
    event: { type: "string", description: "断点事件(被消费但没人产出的那个)" },
    neededBy: { type: "string", description: "消费该事件的节点名(validate 给的 neededBy)" },
    decision: { type: "string", enum: ["remap", "generate"], description: "remap=事件适配;generate=该槽改回重造" },
    remapFrom: { type: "string", description: "decision=remap 时:要转发成 event 的上游/入口事件" },
  }, ["event", "neededBy", "decision"]),
  async execute(args, ctx): Promise<MetaToolResult> {
    const event = String(args.event ?? ""), neededBy = String(args.neededBy ?? ""), decision = String(args.decision ?? "");
    const reason = String(args.reasoning ?? "");
    if (decision === "remap") {
      const from = String(args.remapFrom ?? "");
      if (!from) return { ok: false, summary: "remap 需要 remapFrom(要转发成 event 的上游事件)" };
      const produced = new Set(composedNodes(ctx).flatMap((n) => n.emitEvents));
      if (!produced.has(from) && !ctx.entryEvents.includes(from)) {
        return { ok: false, summary: `remapFrom「${from}」本链也没人产出、也不是入口——换一个真实存在的上游事件` };
      }
      ctx.remaps.push({ from, to: event, reason });
      ctx.emit({ t: "resolve", event, neededBy, decision: "remap", detail: `${from} → ${event}` });
      return { ok: true, summary: `已记录适配:${from} → ${event}(部署时注入转发)`, output: { remaps: ctx.remaps } };
    }
    if (decision === "generate") {
      const slot = ctx.slots.find((s) => s.agent?.name === neededBy);
      if (!slot) return { ok: false, summary: `找不到绑定 agent 名为「${neededBy}」的槽` };
      slot.agent = null; slot.decision = "generate"; slot.reason = `复用签名对不齐(${event}),改为重造`;
      ctx.emit({ t: "resolve", event, neededBy, decision: "generate", detail: `${slot.need.action} 槽改回待生成` });
      return { ok: true, summary: `「${slot.need.action}」槽已解绑改为待生成——接下来 generate_agents 重造`, output: { reopened: slot.need.action } };
    }
    return { ok: false, summary: "decision 必须是 remap 或 generate" };
  },
};

// ── compare_to_standard ─────────────────────────────────────────────────────
const compare_to_standard: MetaTool = {
  name: "compare_to_standard",
  description: "把当前组装好的 agent 集合对标 招聘-v1 的【黄金标准】打分:签名对齐、决策分支覆盖(是否产出了真 agent 的全部结果事件)、工具覆盖(是否用了同命名空间的工具)。这是衡量『工厂读同一本体重造出来的 agent 有多接近真生产 agent』的尺子。",
  parameters: params({}),
  async execute(_args, ctx): Promise<MetaToolResult> {
    if (!ctx.goldStandard.length) return { ok: true, summary: "本域无黄金标准(没有签名相近的真生产 agent)——跳过对标", output: { meanTotal: null } };
    const cmp = compareToStandard(boundAgents(ctx), ctx.goldStandard, ctx.domain);
    ctx.lastComparison = cmp;
    ctx.emit({ t: "compare", meanTotal: cmp.meanTotal, uncovered: cmp.uncovered, scores: cmp.scores });
    return {
      ok: true,
      summary: cmp.summary,
      output: { meanTotal: cmp.meanTotal, uncovered: cmp.uncovered, scores: cmp.scores.map((s) => `${s.action}(对 ${s.matchedGenerated}):总分 ${s.total}|签名 ${s.signatureMatch}|分支 ${s.branchCoverage}|工具 ${s.toolCoverage ?? "—"}${s.notes.length ? ` · ${s.notes.join(";")}` : ""}`) },
    };
  },
};

// ── finish ──────────────────────────────────────────────────────────────────
const finish: MetaTool = {
  name: "finish",
  description: "声明编排完成。门槛(全部确定性核验,不达标会被拒绝并告诉你缺什么):①每个槽都绑定了 agent;②组装后链路连通(含 remap),零断点。建议 finish 前先 compare_to_standard 看看对标分。",
  parameters: params({ note: { type: "string", description: "完成说明" } }),
  async execute(args, ctx): Promise<MetaToolResult> {
    const unbound = ctx.slots.filter((s) => !s.agent).map((s) => s.need.action);
    const { chainOk, gaps } = validateChain(composedNodes(ctx), ctx.internalEvents);
    if (unbound.length) return { ok: false, summary: `还不能 finish:${unbound.length} 个槽未绑定(${unbound.join("、")})——plan/generate 它们`, output: { unbound } };
    if (!chainOk) return { ok: false, summary: `还不能 finish:${gaps.length} 处链断(${gaps.map((g) => g.event).join("、")})——resolve_gap 处理`, output: { gaps } };
    const reuse = ctx.slots.filter((s) => s.decision === "reuse").length;
    const gen = ctx.slots.filter((s) => s.decision === "generate").length;
    return {
      ok: true,
      summary: `✓ 编排完成:${ctx.slots.length} 个槽(复用 ${reuse}、生成 ${gen})链路连通${ctx.remaps.length ? ` · ${ctx.remaps.length} 处适配` : ""}${ctx.lastComparison ? ` · 对标均分 ${ctx.lastComparison.meanTotal}` : ""}。${String(args.note ?? "")}`,
      output: { complete: true, reuse, generate: gen, remaps: ctx.remaps, comparison: ctx.lastComparison },
    };
  },
};

export const META_TOOLS: MetaTool[] = [inspect_domain, plan_orchestration, generate_agents, validate_chain, resolve_gap, compare_to_standard, finish];
