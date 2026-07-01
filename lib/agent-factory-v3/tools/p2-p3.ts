// P2/P3 tools — the genuinely-dynamic capabilities: research the web, author
// reusable SKILLS (prompt guidance, not API tools) on the fly, and delegate
// sub-tasks to isolated sub-brains. Real API tools are NOT created here — they
// are human-coded in the tools library; the brain only selects from it.

import type { BrainTool } from "../brain/types";
import { saveSkill, loadSkills, bumpUseCount, slugifySkill, skillEffectiveness } from "../skills-library";

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

// NOTE: there is intentionally no `create_tool`. Real tools (RoboHire/RAAS/MinIO
// API wrappers) are HUMAN-CODED ahead of time in lib/tools/recruitment-tools.ts —
// that's the trust boundary. A tool "created" at runtime could only ever be a
// mock stub that never calls a real API, so it would be a lie. The brain instead
// SELECTS from the pre-coded library; a capability the library lacks is recorded
// on the agent as `unresolvedTools` ("待人工实现") for a human to implement.

const create_skill: BrainTool = {
  name: "create_skill",
  description:
    "动态创造一个可复用技能：一段织入 agent system prompt 的指导 + 推荐工具 + 决策规则。它会①在本次运行里被 design_agent 织进 agent，②【持久化到技能库】(skills-library/<slug>/SKILL.md)，以后任何运行都能 use_skill 复用它。如果这个技能是通用的(不只本域适用)，把 general=true，它会成为跨域技能。先用 use_skill 看看库里有没有现成的，避免重复造。",
  parameters: params({
    name: { type: "string" },
    purpose: { type: "string", description: "这个技能解决什么" },
    promptFragment: { type: "string", description: "织入 agent prompt 的指导片段(中文)" },
    tools: { type: "array", items: { type: "string" }, description: "该技能推荐的工具名(可空)" },
    decisionRule: { type: "string", description: "该技能的决策规则(可空)" },
    general: { type: "boolean", description: "true=通用技能(跨域可复用)；默认 false(仅本域)" },
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
    // Persist to the on-disk library so future runs can reuse it.
    let persisted = "";
    try {
      const saved = await saveSkill({ ...skill, general: args.general === true }, ctx.domain);
      persisted = `，已存入技能库(skills-library/${saved.slug}/，${saved.domain === "*" ? "通用" : "本域"})`;
    } catch {
      persisted = "（技能库落盘失败，仅本次可用）";
    }
    return { ok: true, summary: `已创造技能「${skill.name}」：${skill.purpose}${persisted}。生成 agent 时会自动织入它的指导。` };
  },
};

const use_skill: BrainTool = {
  name: "use_skill",
  description:
    "查看/复用【技能库】里已有的技能(以前的运行沉淀下来的know-how)。不传 name → 列出本域可用的技能(名字+用途+复用次数)。传 name → 把那个技能调入本次运行，design_agent 会把它织进对应 agent。设计前先 use_skill 看一眼，能复用就别重造。",
  parameters: params({
    name: { type: "string", description: "要复用的技能名(或 slug)；留空=只列出可用技能" },
  }, []),
  async execute(args, ctx) {
    const available = await loadSkills(ctx.domain);
    const want = String(args.name ?? "").trim();
    if (!want) {
      if (!available.length) return { ok: true, summary: "技能库目前为空(本域+通用)。需要时用 create_skill 创造并沉淀。", output: { skills: [] } };
      // SkillsBench (B): show EFFECTIVENESS (sandbox pass-rate of runs that used it)
      // so the brain prefers skills that proved out, not just oft-reused ones.
      const pct = (s: { evalCount: number; successCount: number }) => (s.evalCount ? `${Math.round(skillEffectiveness(s) * 100)}%效(${s.successCount}/${s.evalCount})` : "未评测");
      return {
        ok: true,
        summary: `技能库可复用 ${available.length} 个(按效果排序)：${available.map((s) => `${s.name}[${pct(s)}·用${s.useCount}次]`).join("、")}`,
        output: { skills: available.map((s) => ({ name: s.name, slug: s.slug, purpose: s.purpose, domain: s.domain, tools: s.tools, useCount: s.useCount, effectiveness: Math.round(skillEffectiveness(s) * 100), evalCount: s.evalCount, successCount: s.successCount })) },
      };
    }
    const slug = slugifySkill(want);
    const found = available.find((s) => s.slug === slug || s.name === want);
    if (!found) return { ok: false, summary: `技能库里没有「${want}」。可先 use_skill(不带name) 看有哪些，或 create_skill 新造。` };
    ctx.createdSkills = ctx.createdSkills.filter((s) => s.name !== found.name);
    ctx.createdSkills.push({ name: found.name, purpose: found.purpose, promptFragment: found.promptFragment, tools: found.tools, decisionRule: found.decisionRule });
    await bumpUseCount(found.slug).catch(() => {});
    ctx.emit({ t: "skill.created", name: found.name, purpose: `(复用自技能库) ${found.purpose}` });
    return { ok: true, summary: `已从技能库复用「${found.name}」(累计复用 ${found.useCount + 1} 次)，design_agent 会织进相关 agent。` };
  },
};

const spawn_subagent: BrainTool = {
  name: "spawn_subagent",
  description:
    "派生一个【真正隔离的子大脑】去做一个聚焦子任务。它有自己的 message history、自己的 ctx（独立 specs / 计划 / 反思），只能用研究型工具(read_ontology, list_agents, read_spec, inspect_run, web_search, finish)——不能部署、不能改 agent。完成后回传它的总结。当某个子问题需要独立深入分析（例如「先调研下行业规则再定阈值」）而不想污染主对话时用。",
  parameters: params({
    task: { type: "string", description: "给子大脑的聚焦任务(中文)：要它具体探索什么、产出什么结论" },
    domain: { type: "string", description: "可选——让子大脑去看其它域的本体（默认沿用当前域）" },
  }, ["task"]),
  async execute(args, ctx) {
    const task = String(args.task ?? "");
    const subDomain = (typeof args.domain === "string" && args.domain.trim()) || ctx.domain;
    ctx.emit({ t: "subagent.start", task });
    let summary = "";
    let lastFinishSummary = "";
    let toolCallCount = 0;
    let messageContent = "";
    try {
      const { runBrain } = await import("../brain/conductor");
      // Recursive isolated brain: own ctx, own message history, restricted tools.
      // isSubAgent=true → no reflection load (focused exploration, not pipeline).
      for await (const e of runBrain({
        domain: subDomain,
        goal: task,
        tools: SUBAGENT_TOOLS,
        isSubAgent: true,
        // P2 (audit MAJOR): forward the parent's abort signal so a client disconnect /
        // cancel CASCADES to the sub-brain instead of leaving it running for minutes
        // unstoppable. A cancelled run should stop everything it spawned.
        signal: ctx.signal,
      })) {
        if (e.t === "message") messageContent = e.text;
        else if (e.t === "tool.result" && e.name === "finish") lastFinishSummary = e.summary;
        else if (e.t === "tool.call") toolCallCount++;
      }
      // Prefer the LLM's final message; fall back to finish tool's summary.
      summary = messageContent || lastFinishSummary || `(子大脑无明确结论 · ${toolCallCount} 次工具调用)`;
    } catch (e) {
      summary = `子大脑出错：${(e as Error).message}`;
    }
    ctx.emit({ t: "subagent.done", task, summary: summary.slice(0, 400) });
    return {
      ok: !summary.startsWith("子大脑出错"),
      summary: `子大脑完成（${toolCallCount} 次工具调用）：${summary.slice(0, 220)}`,
      output: { task, domain: subDomain, summary, toolCallCount },
    };
  },
};

export const P2_TOOLS: BrainTool[] = [web_search, create_skill, use_skill];
export const P3_TOOLS: BrainTool[] = [spawn_subagent];

// Sub-agents get a restricted, side-effect-free toolset (research only) so an
// isolated sub-task can't deploy/run anything — pure exploration.
import { READONLY_TOOLS } from "./index";
export const SUBAGENT_TOOLS: BrainTool[] = [...READONLY_TOOLS, web_search];
