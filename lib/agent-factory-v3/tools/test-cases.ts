// Feature 2 — full-flow test-case generation + the user-approval gate.
//
// Before the sandbox really deploys + fires, the brain authors a small set of
// NAMED full-flow use cases (happy / reject / edge), each an entry event + payload
// that exercises one path of the event graph. They're streamed to the chat as a
// proposal; the conductor PARKS (awaitingApproval) until the user clicks 执行 or
// 重新生成. On 执行 the sandbox fires THESE cases (not a hardcoded seed), so the
// verification panel proves real I/O on reviewed inputs. The generation is a focused
// LLM call surfaced as a 子大脑 in the brain activity log (matches the user's "再写
// 一个 agent 来生成测试用例"); a deterministic golden fixture is the fallback.

import { chatComplete, isGatewayConfigured } from "@/server/llm/gateway";
import { FACTORY_STRONG_MODEL } from "../brain/stream-gateway";
import type { BrainTool, BrainCtx, BrainToolResult, TestCase } from "../brain/types";

const REASONING = { reasoning: { type: "string", description: "一句话说明你为什么现在调用这个工具(会展示给用户)" } } as const;
function params(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties: { ...REASONING, ...props }, required: ["reasoning", ...required] };
}

/** Entry events of the CURRENT spec set = consumed by some spec, produced by none. */
function entryEventsOf(ctx: BrainCtx): string[] {
  const produced = new Set<string>();
  for (const s of ctx.specs) for (const e of s.emit) if (e && e !== "—") produced.add(e);
  const entry = new Set<string>();
  for (const s of ctx.specs) for (const t of s.trigger) if (t && t !== "—" && !produced.has(t)) entry.add(t);
  return [...entry];
}

/** #9a: a generic ONTOLOGY-DERIVED base fixture — NO recruitment/domain hardcoding. Builds demo
 *  values from the entry event's REAL fields (the consuming spec's inputSchema + its DataObjects'
 *  properties), typed by field name/type. So ANY domain gets a valid fixture; recruitment fields
 *  appear only when the recruitment ontology actually declares them. Generic id fallback if the
 *  ontology yields nothing, so the entry event still fires. */
function typedDemo(field: string, type?: string): unknown {
  const f = field.toLowerCase();
  const t = (type ?? "").toLowerCase();
  if (/(^|_)id$|^id$/.test(f)) return `${field}_demo_001`;
  if (/bool/.test(t)) return true;
  if (/(number|int|float|double|decimal)/.test(t) || /amount|count|qty|num|金额|数量|年限|分数|score/.test(f)) return 1;
  if (/(array|list|\[\])/.test(t)) return [];
  if (/(object|json|map)/.test(t)) return {};
  return `${field}_demo`;
}
function baseFixture(ctx: BrainCtx): Record<string, unknown> {
  const out: Record<string, unknown> = { _demo: true };
  if (!ctx.ontology) { out.id = "demo_001"; return out; }
  const entry = entryEventsOf(ctx)[0];
  const spec = entry ? ctx.specs.find((s) => s.trigger.includes(entry)) : ctx.specs[0];
  const objIndex = new Map<string, Array<{ name: string; type?: string }>>();
  for (const o of ctx.ontology.objects) objIndex.set(o.name, o.properties ?? []);
  const fields: Array<{ name: string; type?: string }> = [];
  for (const f of spec?.inputSchema ?? []) fields.push({ name: f.field, type: f.type });
  for (const n of spec?.objects ?? []) for (const p of objIndex.get(n) ?? []) fields.push({ name: p.name, type: p.type });
  for (const f of fields) if (f.name && out[f.name] === undefined) out[f.name] = typedDemo(f.name, f.type);
  if (Object.keys(out).length <= 1) out.id = "demo_001"; // nothing derived → generic seed so it still fires
  return out;
}

/** Deterministic golden fixture — one happy-path case per entry event. Used when
 *  the gateway is down or the LLM returns nothing usable, so the flow still works. */
function goldenFixture(ctx: BrainCtx): TestCase[] {
  const entries = entryEventsOf(ctx);
  const base = baseFixture(ctx);
  if (!entries.length) return [{ id: "tc_golden_1", name: "默认全流程用例", scenario: "用代表性种子数据触发整条链", kind: "pass", entryEvent: "(入口)", payload: base, expectedOutcome: "走到成功终态" }];
  return entries.map((e, i) => ({
    id: `tc_golden_${i + 1}`,
    name: `${e} · 代表性用例`,
    scenario: `用代表性数据触发 ${e},预期整条链跑到成功终态`,
    kind: "pass" as const,
    entryEvent: e,
    payload: base,
    expectedOutcome: "走到成功终态(非失败分支)",
  }));
}

function parseJsonArray(text: string): unknown[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { const v = JSON.parse(m[0]); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** LLM-author the full-flow cases, grounded in the event graph + DataObject schemas.
 *  Falls back to the golden fixture on any failure (never blocks the flow). */
async function authorTestCases(ctx: BrainCtx): Promise<TestCase[]> {
  if (!isGatewayConfigured() || !ctx.ontology) return goldenFixture(ctx);
  const entries = entryEventsOf(ctx);
  // event-graph digest + the DataObject fields the entry payloads should carry.
  const chains: string[] = [];
  for (const a of ctx.specs) for (const e of a.emit) for (const b of ctx.specs) if (b.slug !== a.slug && b.trigger.includes(e)) chains.push(`${a.short} —${e}→ ${b.short}`);
  const emitted = new Set(ctx.specs.flatMap((s) => s.emit).filter((e) => e && e !== "—"));
  const consumed = new Set(ctx.specs.flatMap((s) => s.trigger).filter(Boolean));
  const terminals = [...emitted].filter((e) => !consumed.has(e));
  const objIndex = new Map<string, { name: string; type?: string; description?: string }[]>();
  for (const o of ctx.ontology.objects) objIndex.set(o.name, (o.properties ?? []).map((p) => ({ name: p.name, type: p.type, description: p.description })));
  const entryFields = entries.map((e) => {
    const spec = ctx.specs.find((s) => s.trigger.includes(e));
    const fields = (spec?.inputSchema ?? []).map((f) => `${f.field}:${f.type}`);
    const objs = (spec?.objects ?? []).flatMap((n) => (objIndex.get(n) ?? []).map((p) => `${p.name}:${p.type ?? "?"}`));
    return `${e} 需要字段: ${[...new Set([...fields, ...objs])].slice(0, 14).join(", ") || "(未知,用代表性值)"}`;
  });
  const sys =
    "你是工厂的【测试用例设计师】(一个聚焦子大脑)。给定一组将要部署的业务 agent 和它们的事件图,设计 2-4 个【全流程测试用例】,每个用一条入口事件 + 一份真实感的 payload 去触发整条链,覆盖不同路径:" +
    "至少一个 kind=pass(正常走到成功终态)、一个 kind=reject(应触发某条规则/失败分支)、可选一个 kind=edge(缺字段/异常数据)。" +
    "payload 字段要【贴合给出的实体字段】,值要真实(中文名字/真实技能/合理数字),不要留空。" +
    '只输出 JSON 数组,每个元素 {"name":string,"scenario":string,"kind":"pass"|"reject"|"edge","entryEvent":string,"payload":object,"expectedOutcome":string}。entryEvent 必须是给出的入口事件之一。不要任何其它文字。';
  const user = [
    `业务域: ${ctx.domain}`,
    `入口事件: ${entries.join("、") || "(无明确入口)"}`,
    `事件链: ${chains.slice(0, 12).join(" | ") || "(单段)"}`,
    `成功/失败终态: ${terminals.join("、") || "(未知)"}`,
    `各入口事件的 payload 字段:\n${entryFields.join("\n")}`,
    `agent: ${ctx.specs.map((s) => `${s.short}(${s.trigger.join("/") || "入口"}→${s.emit.join("/") || "终态"})`).join("; ")}`,
  ].join("\n");
  try {
    const res = await chatComplete({ system: sys, user, temperature: 0.6, maxTokens: 1800, model: FACTORY_STRONG_MODEL, toolName: "generate_test_cases" });
    const rows = parseJsonArray(res.text);
    const cases: TestCase[] = [];
    rows.forEach((row, i) => {
      if (!row || typeof row !== "object") return;
      const r = row as Record<string, unknown>;
      const entryEvent = String(r.entryEvent ?? entries[0] ?? "(入口)");
      const kind = ["pass", "reject", "edge"].includes(String(r.kind)) ? (String(r.kind) as TestCase["kind"]) : "pass";
      cases.push({
        id: `tc_${i + 1}`,
        name: String(r.name ?? `用例 ${i + 1}`).slice(0, 60),
        scenario: String(r.scenario ?? "").slice(0, 200),
        kind,
        entryEvent: entries.includes(entryEvent) ? entryEvent : (entries[0] ?? entryEvent),
        payload: (r.payload && typeof r.payload === "object" ? r.payload : baseFixture(ctx)) as Record<string, unknown>,
        expectedOutcome: String(r.expectedOutcome ?? "").slice(0, 120),
      });
    });
    return cases.length ? cases : goldenFixture(ctx);
  } catch {
    return goldenFixture(ctx);
  }
}

/** Generate + PROPOSE test cases: store them on ctx, surface as a 子大脑 in the
 *  activity log, emit test.cases, and PARK the conductor for the user's decision.
 *  Shared by the generate_test_cases tool AND sandbox_run's first-run auto-gate. */
export async function proposeTestCases(ctx: BrainCtx): Promise<BrainToolResult> {
  ctx.emit({ t: "subagent.start", task: "造全流程测试用例" });
  const cases = await authorTestCases(ctx);
  ctx.testCases = cases;
  ctx.awaitingApproval = true;
  const kinds = cases.reduce<Record<string, number>>((m, c) => { m[c.kind] = (m[c.kind] ?? 0) + 1; return m; }, {});
  const kindStr = Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join(" · ");
  ctx.emit({ t: "subagent.done", task: "造全流程测试用例", summary: `生成 ${cases.length} 个用例(${kindStr})` });
  ctx.emit({ t: "test.cases", cases, awaitingApproval: true });
  return {
    ok: true,
    summary: `已生成 ${cases.length} 个全流程测试用例(${kindStr})并展示给用户确认。【现在暂停,等用户点「执行」或「重新生成」——不要继续调别的工具】。用户确认后我会把决策作为消息发给你,你再调 sandbox_run 用这些用例真实跑通。`,
    output: { cases, awaitingApproval: true },
  };
}

export const generate_test_cases: BrainTool = {
  name: "generate_test_cases",
  description:
    "在真正 sandbox_run 之前,沿事件图设计一批【全流程测试用例】(正常通过 / 规则不符 / 缺字段各覆盖),每个=一条入口事件+真实 payload,触发整条链。生成后会展示给用户确认(执行/重新生成),你需要【暂停等待用户决策】再继续。这就是把『喂进沙箱的输入』变成用户可见、可控的用例。用户要求重做用例时也调它。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.specs.length) return { ok: false, summary: "还没有 agent 可测,先 design_agent。" };
    return proposeTestCases(ctx);
  },
};
