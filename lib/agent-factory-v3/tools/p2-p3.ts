// P2/P3 tools — the genuinely-dynamic capabilities: research the web, author new
// tools + skills on the fly, and delegate sub-tasks to isolated sub-brains. The
// brain decides when/whether to use any of these; nothing is hardcoded.

import { resolveRegistry } from "@/lib/tools/resolve-registry";
import type { BrainTool, BrainCtx } from "../brain/types";

const REASONING = { reasoning: { type: "string", description: "一句话说明你为什么调用这个工具(会展示给用户)" } } as const;
function params(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties: { ...REASONING, ...props }, required: ["reasoning", ...required] };
}

// ── real web search (keyless: DuckDuckGo instant answers + Wikipedia) ──────────
export async function webSearch(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  try {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&t=ao`, { signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { Heading?: string; AbstractText?: string; AbstractURL?: string; RelatedTopics?: Array<{ Text?: string; FirstURL?: string }> };
    if (j.AbstractText) out.push({ title: j.Heading || query, url: j.AbstractURL || "", snippet: j.AbstractText });
    for (const t of (j.RelatedTopics ?? []).slice(0, 5)) {
      if (t.Text && t.FirstURL) out.push({ title: t.Text.split(" - ")[0].slice(0, 70), url: t.FirstURL, snippet: t.Text });
    }
  } catch { /* fall through */ }
  if (out.length < 2) {
    try {
      const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=4&origin=*`, { signal: AbortSignal.timeout(8000) });
      const j = (await r.json()) as { query?: { search?: Array<{ title: string; snippet?: string }> } };
      for (const s of j.query?.search ?? []) {
        out.push({ title: s.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, "_"))}`, snippet: (s.snippet ?? "").replace(/<[^>]+>/g, "") });
      }
    } catch { /* fall through */ }
  }
  return out.slice(0, 6);
}

const web_search: BrainTool = {
  name: "web_search",
  description: "联网搜索，研究领域知识 / 最佳实践 / 业务规则，帮助你更好地设计 agent 的 prompt 与决策逻辑。返回真实搜索结果(标题/摘要/链接)。",
  parameters: params({ query: { type: "string", description: "搜索词(中英文皆可)" } }, ["query"]),
  async execute(args, ctx) {
    const q = String(args.query ?? "");
    const results = await webSearch(q);
    ctx.emit({ t: "web.result", query: q, results });
    ctx.research.push({ query: q, findings: results.map((r) => `- ${r.title}: ${r.snippet}`).join("\n").slice(0, 1200) });
    return { ok: results.length > 0, summary: results.length ? `搜到 ${results.length} 条真实结果，已纳入研究参考。` : "无结果", output: { query: q, results } };
  },
};

const create_tool: BrainTool = {
  name: "create_tool",
  description: "动态创造一个新工具(能力)，注册到本域工具库；之后 generate_agents 时把它写进某 agent 的 extra_tools 即可绑定。当本体现有工具覆盖不了某能力时用。",
  parameters: params({
    name: { type: "string", description: "工具名，点号分族，如 'recruit.scoreCandidate'" },
    description: { type: "string", description: "工具做什么(给 agent 看)" },
    parameters: { type: "object", description: "参数 JSON schema(可空)" },
  }, ["name", "description"]),
  async execute(args, ctx) {
    if (!ctx.registry) ctx.registry = resolveRegistry(ctx.domain, ctx.ontology ?? undefined);
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, summary: "工具名不能为空" };
    if (ctx.registry.has(name)) return { ok: false, summary: `工具 ${name} 已存在，无需重复创造。` };
    ctx.registry.register({
      name,
      title: name,
      description: String(args.description ?? ""),
      domain: ctx.domain,
      sideEffect: "read",
      parameters: (args.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
      returns: { type: "object" },
      execute: async (a, c) => ({ _created: true, tool: name, args: a, mode: c?.dryRun ? "dry-run" : "live" }),
    });
    ctx.emit({ t: "tool.created", name, description: String(args.description ?? "") });
    return { ok: true, summary: `已创造工具 ${name} 并注册到本域工具库，generate_agents 时可用 extra_tools 绑定。` };
  },
};

const create_skill: BrainTool = {
  name: "create_skill",
  description: "动态创造一个可复用技能：一段织入 agent system prompt 的指导 + 推荐工具 + 决策规则。之后 generate_agents 会把已创造的技能织进每个生成的 agent。",
  parameters: params({
    name: { type: "string" },
    purpose: { type: "string", description: "这个技能解决什么" },
    promptFragment: { type: "string", description: "织入 agent prompt 的指导片段(中文)" },
    tools: { type: "array", items: { type: "string" }, description: "该技能推荐的工具名(可空)" },
    decisionRule: { type: "string", description: "该技能的决策规则(可空)" },
  }, ["name", "purpose", "promptFragment"]),
  async execute(args, ctx) {
    const skill = {
      name: String(args.name ?? "").trim(),
      purpose: String(args.purpose ?? ""),
      promptFragment: String(args.promptFragment ?? ""),
      tools: Array.isArray(args.tools) ? (args.tools as string[]) : [],
      decisionRule: String(args.decisionRule ?? ""),
    };
    if (!skill.name) return { ok: false, summary: "技能名不能为空" };
    ctx.createdSkills = ctx.createdSkills.filter((s) => s.name !== skill.name);
    ctx.createdSkills.push(skill);
    ctx.emit({ t: "skill.created", name: skill.name, purpose: skill.purpose });
    return { ok: true, summary: `已创造技能「${skill.name}」：${skill.purpose}。生成 agent 时会自动织入它的指导。` };
  },
};

const spawn_subagent: BrainTool = {
  name: "spawn_subagent",
  description: "派生一个隔离的子大脑去完成一个聚焦子任务(它有自己独立的上下文，只能读本体+联网搜索，不能部署)，完成后只回传一句摘要。当某个子问题需要独立深入探索而不想污染主上下文时用。",
  parameters: params({ task: { type: "string", description: "给子大脑的聚焦任务(中文)" } }, ["task"]),
  async execute(args, ctx) {
    const task = String(args.task ?? "");
    ctx.emit({ t: "subagent.start", task });
    let summary = "";
    try {
      const { runBrain } = await import("../brain/conductor");
      for await (const e of runBrain({ domain: ctx.domain, goal: task, tools: SUBAGENT_TOOLS })) {
        if (e.t === "message") summary = e.text;
      }
    } catch (e) {
      summary = `子大脑出错：${(e as Error).message}`;
    }
    ctx.emit({ t: "subagent.done", task, summary: summary.slice(0, 400) });
    return { ok: true, summary: `子大脑完成：${summary.slice(0, 220)}`, output: { task, summary } };
  },
};

export const P2_TOOLS: BrainTool[] = [web_search, create_tool, create_skill];
export const P3_TOOLS: BrainTool[] = [spawn_subagent];

// Sub-agents get a restricted, side-effect-free toolset (research only) so an
// isolated sub-task can't deploy/run anything — pure exploration.
import { READONLY_TOOLS } from "./index";
export const SUBAGENT_TOOLS: BrainTool[] = [...READONLY_TOOLS, web_search];
