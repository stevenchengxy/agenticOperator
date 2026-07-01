// The autonomous Harness brain — a streaming ReAct loop.
//
// One LLM drives: it reasons, calls a tool, observes the result, loops — until
// it calls `finish` (or hits the budget). NOT a fixed pipeline; the brain
// decides every next action. Yields BrainEvents streamed live to the chatbot.

import { streamTurn, type ChatMsg, type ToolSchema } from "./stream-gateway";
import { modelChain, tierForContext } from "./model-router";
import type { BrainEvent, BrainCtx, BrainTool, ReflectionLite, BoundaryEvent } from "./types";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import { injectGroundingEnums } from "../schema-grounding";
import { teardownSandbox } from "@/lib/agent-factory-v2/deploy";
import { chatComplete, isGatewayConfigured } from "@/server/llm/gateway";
import { drainHumanMsgs, disposeMailbox } from "./mailbox";
import { getConversation, hasConversation, saveConversation, rehydrateConversation, persistConversation } from "./conversation-store";
import { recordSkillEvaluation, slugifySkill } from "../skills-library";
import { prisma } from "@/server/db";

// MAX_TURNS is now a RUNAWAY BACKSTOP, not the real bound. Turn-capping is a blunt
// limiter that kills a hard run mid-iteration; the real context-management is
// auto-compaction (maybeCompact below) — it folds the verbose history into a state
// summary so the loop can iterate as long as it needs without blowing the context
// window. So we set this high (a hard run might legitimately take many turns) and
// rely on compaction + the brain calling finish to end the run. It only exists so a
// genuinely stuck loop can't spin forever.
// #9c: tuning is env-overridable (different domains/budgets want different limits) — not baked in.
const envInt = (k: string, d: number): number => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};
const MAX_TURNS = envInt("FACTORY_MAX_TURNS", 200);
// Token budget: DISABLED by default (null = 无限制). Even at 600k the brain kept clipping the
// loop BEFORE it reached `finish` on hard domains. Auto-compaction keeps each turn's context
// bounded, and MAX_TURNS is the runaway backstop. Set FACTORY_MAX_TOKENS to re-impose a ceiling.
const MAX_TOKENS: number | null = process.env.FACTORY_MAX_TOKENS && Number(process.env.FACTORY_MAX_TOKENS) > 0 ? Number(process.env.FACTORY_MAX_TOKENS) : null;

function systemPrompt(domain: string, reflections: ReflectionLite[]): string {
  const lessons = reflections.length === 0
    ? ""
    : [
        "",
        "【来自之前为这个域生成 agent 的反思——这些是过去真实失败/成功观察到的，要主动避开 / 复用】",
        ...reflections.slice(0, 8).map((r) => `- [${r.kind}] ${r.summary}${r.rootCause ? `（根因：${r.rootCause}）` : ""} → 教训：${r.lesson}`),
        "",
      ].join("\n");

  return [
    "你是工厂的【主控大脑】——一个经验丰富、会自己思考的 Agent 工厂工程师（像 Claude Code / Codex）。我给你工具和信息，但【怎么用、用不用、什么顺序，完全你自己判断】——下面是工具箱和几条硬原则，不是要你逐条照做的清单。相信你的工程判断。",
    `当前业务域：「${domain}」。`,
    "",
    "【像一个会自己思考的工程师那样工作——不是接待员】",
    "用户发来一条消息,你先看懂他【这一句】到底想要什么,然后【自己判断】下一步该做什么、用哪个工具,直接动手。不同的意图自然走不同的路:",
    "  · 想了解/分析这个域(本体、对象、动作、事件、规则,或某次运行、某个 agent 的情况)→ 你应当主动去【读真实数据】再据实回答:read_ontology 看本体结构与事件流、describe_domain 看概览、inspect_run 看某次运行、read_spec 看某个 agent。一个工程师不会凭空回答数据问题,也不会只甩一份菜单让用户选。看完数据,用文字把分析讲清楚——到此为止,除非用户要你继续。",
    "  · 想造/改/部署 agent → 走生成流水线(read_ontology→create_plan→design_agent→…→finish)。",
    "  · 打招呼/闲聊/纯概念问题 → 自然地一句话回应即可,不必调工具。",
    "  · 拿不准他要什么 → 直接问他一句澄清,而不是甩一长串菜单。",
    "【不要】每次都自我介绍、不要列「1.生成 2.查询 3.调试」这种菜单、不要重复同一段问候——那是死板接待员的做法。你是会自己思考、自己决定、自己动手的工程师,像 Claude 那样:看懂需求,直接做对的事。",
    "",
    `当是生成任务时——你的目标：为业务域「${domain}」自主生成一组能真正运行、并能串联跑通的 agent。`,
    "",
    "【核心工作方式：观察驱动，不是清单驱动】",
    "你不是在执行一个固定流水线。每一步你都要【根据刚才观察到的东西】决定下一步做什么。同样的目标，不同的域/状态下，你的工具调用序列可能完全不同——这是正常的、被期望的。",
    "",
    "【你能用的能力（这是工具箱，不是清单）】",
    "调研/规划:",
    "  · read_ontology — 读这个域的动作/事件/规则 + 拿到【工具库 availableTools】",
    "  · create_plan — 把你打算造的 agent 写成显式计划（强烈建议在 design 前先 plan，校验失败时可以回头改 plan 再重新设计）",
    "  · web_search — 联网搜业务规则/最佳实践",
    "  · spawn_subagent — 子问题需要深入探索时，派一个隔离子大脑去研究",
    "  · ask_user — 信息不全 / 外部平台 API 的 input·output 查不到 / 要在几个方案里让用户拍板时，【反问用户并暂停等待】(可给 options 让他点选)。别瞎猜、也别默默降级——拿不准就问。",
    "  · create_skill — 发现可复用模式（如「三级去重」「红线校验」），织成技能注入到后续 agent 的 prompt",
    "  · fetch_doc — 取一个外部平台的【开发者文档 URL】正文(SSRF 防护、内容当不可信数据);要给某平台 API 造工具但库里没有时,先抓它的文档",
    "  · create_tool — 把外部 API【写成工具】存进工具库:给【声明式 HTTP 契约】(method/url/headers/body/responsePath,密钥用 ${ENV} 引用、参数用 {arg}),不写可执行代码。存进去待人工审核,本次运行即可绑定。【备料】阶段缺真实工具时用它造,别只标 unresolvedTools 等人写",
    "自省:",
    "  · list_agents — 看你这一轮已经设计了哪些（避免重复/冲突）",
    "  · read_spec — 读某个已设计 agent 的完整规格 + refine 历史",
    "造/改 agent:",
    "  · reuse_agent — 【优先考虑】某个动作如果 read_ontology 标了 reusable_agent(已造过、事件签名匹配的现成 agent),直接 reuse_agent 采纳它,别从零 design_agent——复用已验证的设计,省时且更可靠。它照常走校验+沙箱。",
    "  · design_agent — 【首次创建】一个 agent。要先想清楚再调，输出 system prompt 必须是为这个 agent 现写、不套模板。read_ontology 返回的 agentActions[i].relevant_rules 列出了这个 action 对应的强制业务规则——设计 prompt 时要把它们编进去。【工具要配齐】：一个真正能干活的 agent 通常要「读取→处理/计算→落库」一整套工具，从 suggested_tools 里按职责挑全、别只绑一个。若你绑得太少，系统会按高相关工具库自动补全并在结果里标「⚙ 已自动补全」——看一眼补得对不对，多了用 refine_agent 删、还差用 refine_agent 加。",
    "  · refine_agent — 【在已有版本上迭代】，保留 attempt 历史 + 你的 critique，不是覆盖。修订后系统【自动 score】并对比上一版，分数下降会在 summary 警告你（R4-1）。",
    "  · revert_refine — 【回滚修订】如果 refine 之后分数下降（regression）或你发现修订让事情更糟，与其再 refine 一次硬塞，不如直接 revert 回上一版，换个角度想清楚再试。",
    "验证/调试:",
    "  · generate_test_cases — 在 sandbox_run 之前,沿事件图造一批【全流程测试用例】(正常/规则不符/缺字段)交给用户确认(执行/重新生成),用户点执行后你再 sandbox_run 用这些用例真实跑通。(就算你直接调 sandbox_run,系统也会在首次自动先弹用例让用户确认,确认后再真跑——这样『喂进沙箱的输入』是用户看过、可控的)",
    "  · validate_graph — 静态校验事件图。【返回 agentIssueMap】每个问题绑到具体哪个 agent slug——直接对那些 slug 调 refine_agent，不要文本匹配猜。它也会查【覆盖率】(每个 Agent 动作是否都有 agent) 和【幻觉事件】。",
    "  · propose_boundary_events — validate_graph 报某些事件【悬空】(emit 了却没有内部 agent 消费)时,先判断:是真断点,还是【交给外部平台消费的交接事件】或【本就是终态】?Inngest 事件是全局的,一个 emit 完全可能由外部 app/webhook/订阅方消费,不一定要本域 agent 接。是外部交接/终态就用这个工具列出来交给【用户确认+补充对外契约】,确认后它们不再算断点、external 的会留一份契约给下游核对;只有【真该由内部 agent 消费却没接上】的才算断点,用 refine_agent 修。别一看到悬空就当 bug、也别硬编个假消费者去骗过校验。",
    "  · review_agent — 让一个【独立审查视角】复核你已生成的所有 agent：分支事件是否在 prompt 里都覆盖、工具是否都接地、强制业务规则是否真的写进了 prompt(由独立 LLM 审查员判断)。把问题绑到 action 让你 refine。design 完一轮后建议跑一次。",
    "  · sandbox_run — 真实部署到 Inngest 跑事件链。如果没到终态：",
    "  · inspect_run — 看上次沙箱每个 agent 的真实细节（状态、失败 step、AgentDecision、错误）。【没到终态时必须先 inspect_run 看清楚，再针对具体那个 agent 调 refine_agent。不要乱猜】",
    "结束:",
    "  · analyze_failure — 把这次的根因/经验/坑写成结构化反思，存进 FailureReflection。下次给这个域生成时这条反思会自动出现在你的 system prompt 里——这是真正的跨次学习",
    "  · finish — 给出中文总结",
    "",
    "【按真实需要决定，别走过场】观察当前状态 → 想清楚 → 选最合适的工具 → 看结果 → 再想再决定。plan / refine / inspect_run / read_spec / analyze_failure 这些都按你判断的真实需要用——不是必须凑齐的步骤，也不是可以一概省略的摆设。",
    "",
    "【关于工具的边界】",
    "真实工具（调 RoboHire/RAAS/MinIO 等 API）是人工预先编好放在工具库里的，你只能从 read_ontology 返回的 availableTools 里【选用已有的】。如果某个能力工具库里没有，照常写进 design_agent 的 tools 字段——系统会标「待人工实现」给人补，绝不要假装它已存在。",
    "",
    "【边想边说】用户看见你思考的唯一途径，是你把分析【作为消息文字】流式输出（不是工具的 reasoning 字段）。重要决策前（尤其 design / refine）先把你的判断说出来再动手——说多深由你定，但别一句不说就直接 tool call。",
    "",
    "【说话风格】第一人称：「让我看看这个动作...」「我注意到 sandbox 失败了，调 inspect_run 看看具体哪儿挂了...」「上次反思里提到 X，这次我会注意 Y...」——不是写报告。",
    "",
    "【这是一场持续对话，不是一次性任务】",
    "你和用户在【同一个对话】里反复交流。你已经做过的工作(读过的本体、造过的 agent、跑过的沙箱)都【还在你的上下文里】,不要从头重来。当用户发来新消息时,先判断他想要什么,再决定怎么回应:",
    "  · 问问题(「为什么给 X 选这个工具」「这个 agent 的分支逻辑是什么」)→ 直接用自然语言回答,需要时 read_spec 取细节。【不要】因为一个问题就重跑 read_ontology / 重新设计所有 agent。",
    "  · 要改某一个 agent(「把 X 的容错加强」「换个工具」)→ 只对那一个 refine_agent / 重新 codegen_agent,别动其它已采纳的。",
    "  · 要继续/补全(「把剩下的造完」)→ 看 list_agents 还差哪些,只补差的。",
    "  · 明确要重来(「全部重新生成」)→ 才重跑流水线。",
    "判断不准时,直接问用户一句澄清,或给两三个选项让他选——像 Claude/Codex 那样协作,而不是默认把整条流水线再跑一遍。",
    lessons,
  ].filter(Boolean).join("\n");
}

/** Load prior FailureReflections for this domain. Sorted newest-first, capped
 *  at a sane count so the system prompt doesn't bloat indefinitely.
 *  Uses the typed Prisma accessor when available; falls back to raw SQL when
 *  the dev server's Prisma client predates the model (HMR doesn't reload the
 *  generated client until restart). */
async function loadReflections(domain: string): Promise<ReflectionLite[]> {
  type Row = { kind: string; summary: string; rootCause: string | null; lesson: string; createdAt: Date };
  const pc = prisma as unknown as { failureReflection?: { findMany: (args: unknown) => Promise<Row[]> } };
  try {
    if (pc.failureReflection?.findMany) {
      const rows = await pc.failureReflection.findMany({
        where: { domain },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { kind: true, summary: true, rootCause: true, lesson: true, createdAt: true },
      });
      return rows.map((r) => ({
        kind: (r.kind as "failure" | "success" | "caveat") ?? "failure",
        summary: r.summary,
        rootCause: r.rootCause ?? undefined,
        lesson: r.lesson,
        createdAt: r.createdAt.toISOString(),
      }));
    }
    // Raw SQL fallback (typed accessor unavailable on stale Prisma client).
    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT "kind","summary","rootCause","lesson","createdAt" FROM "FailureReflection" WHERE "domain" = $1 ORDER BY "createdAt" DESC LIMIT 8`,
      domain,
    );
    return rows.map((r) => ({
      kind: (r.kind as "failure" | "success" | "caveat") ?? "failure",
      summary: r.summary,
      rootCause: r.rootCause ?? undefined,
      lesson: r.lesson,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  } catch {
    return []; // amnesiac fallback — never block a run on a DB hiccup
  }
}

// ── auto-compaction ─────────────────────────────────────────────────────────
// The loop's "memory" is the full message history re-sent every turn. On a hard
// domain that takes many turns, that grows unbounded → cost + eventually the
// context window. Turn-capping is a blunt fix (it kills the run mid-iteration).
// Instead: when the history gets large, COMPACT it — keep the system prompt, the
// goal, and the most recent turns verbatim, and replace the older middle with a
// deterministic STATE SUMMARY built from ctx (which already holds the structured
// state: specs, plan, last validation/sandbox, refine history). The brain loses
// the verbose old tool dumps but keeps everything it needs to keep going.

/** Tier-1 (ACON "critical state"): a faithful, deterministic snapshot of the run
 *  state, from ctx — guaranteed-accurate + free. Explicitly anchors the OPEN
 *  PROBLEMS (failed validation, non-terminal sandbox, agents still under refine),
 *  since those are exactly the bits a compression must never drop. */
export function buildStateSummary(ctx: BrainCtx): string {
  const specs = ctx.specs.map((s) => `${s.short}(${s.trigger.join("/") || "入口"}→${s.emit.join("/") || "终态"}; 工具 ${s.tools.length}${s.unresolvedTools?.length ? `; 缺 ${s.unresolvedTools.join(",")}` : ""})`);
  const refines = Object.entries(ctx.attemptHistory).map(([k, v]) => `${k}×${v.length}`);
  const val = ctx.lastValidation
    ? (ctx.lastValidation.ok ? "通过" : `有问题: ${Object.keys(ctx.lastValidation.agentIssueMap).join(", ")}`)
    : "未校验";
  // Open problems = the work still owed. These are preserved verbatim.
  const open: string[] = [];
  if (ctx.lastValidation && !ctx.lastValidation.ok) open.push(`事件图未闭合，待修 agent: ${Object.keys(ctx.lastValidation.agentIssueMap).join(", ")}`);
  for (const s of ctx.specs) if (!s.tools?.length) open.push(`${s.short} 还没绑工具`);
  for (const s of ctx.specs) if (s.unresolvedTools?.length) open.push(`${s.short} 有未接地工具: ${s.unresolvedTools.join(",")}`);
  // #3 FIX (memory): keep the real ontology action/event NAMES inside the folded summary — counts
  // alone let the brain hallucinate forgotten symbols after compaction. Capped with a "+N" tail.
  const cap = (arr: string[], n: number) => (arr.length > n ? `${arr.slice(0, n).join("、")}…(+${arr.length - n})` : arr.join("、"));
  const ontoLine = ctx.ontology
    ? `· 本体快照(只能用这些真名,别脑补) · Agent动作: ${cap(ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name), 30)} · 事件: ${cap(ctx.ontology.events.map((e) => e.name), 40)}`
    : "";
  return [
    "【早期进展已自动压缩 —— 以下是浓缩后的当前状态(权威),据此继续；完整的早期工具输出已折叠】",
    `· 域: ${ctx.domain}`,
    ontoLine,
    `· 已设计 agent (${ctx.specs.length}): ${specs.join("；") || "无"}`,
    `· 当前计划: ${ctx.currentPlan ? `v${ctx.currentPlan.version}（${ctx.currentPlan.agents.length} 个 agent）` : "未制定"}`,
    `· 上次静态校验: ${val}`,
    `· 上次沙箱: ${ctx.lastSandbox ? `${ctx.lastSandbox.agentsRan}/${ctx.lastSandbox.deployed} agent 真跑${ctx.lastSandbox.fullChainRan ? "、全链路跑通 ✓" : "、链未串完(需 verify_chain 定位+修+重跑)"}` : ctx.lastSandboxRunIds.length ? `跑过 ${ctx.lastSandboxRunIds.length} 个 run` : "未跑"}`,
    `· refine 历史: ${refines.join("; ") || "无"}`,
    open.length ? `· ⚠ 还没解决的问题: ${open.join("；")}` : "· 暂无未解决的结构性问题",
    // RANK-5: human directives are authoritative + must survive compaction.
    ctx.humanDirectives?.length ? `· 🧑 人工介入指令(必须遵守/回应): ${ctx.humanDirectives.map((d) => `「${d}」`).join(" ")}` : "",
    "继续基于以上状态推进；需要某个 agent 的完整规格就调 read_spec，需要沙箱细节就调 inspect_run。",
  ].filter(Boolean).join("\n");
}

/** Tier-2 (FoldAct / ReSum): a best-effort LLM ABSTRACTIVE summary of the dropped
 *  turns — captures the REASONING NUANCE the structured snapshot can't (why a
 *  decision was made, what a diagnosis concluded). Falls back to "" (tier-1 only)
 *  if the gateway is down — compaction must never block on it. */
async function summarizeDropped(dropped: ChatMsg[]): Promise<string> {
  if (!isGatewayConfigured() || dropped.length === 0) return "";
  const text = dropped
    .map((m) => `[${m.role}] ${typeof m.content === "string" ? m.content : ""}${m.tool_calls ? " →调用:" + m.tool_calls.map((c) => c.function.name).join(",") : ""}`)
    .join("\n")
    .slice(0, 50_000);
  try {
    const r = await chatComplete({
      system:
        "你在压缩一个『Agent 工厂大脑』的早期对话历史。提炼成要点，必须保留：①做过的关键决策与原因 ②遇到的问题与诊断结论 ③还没解决/待办的事 ④涉及的具体名字(agent slug / 事件名 / 工具名 / runId)。丢弃寒暄、重复、冗长的工具原始输出。只输出要点，简洁，不要展开。",
      user: text,
    });
    return (r.text || "").trim().slice(0, 4000);
  } catch {
    return ""; // tier-1 (structured) still carries the authoritative state
  }
}

/** Compact in place when the history exceeds ~120k chars (~30-40k tokens). Keeps
 *  messages[0..1] (system + goal) + a HYBRID summary (deterministic state anchor +
 *  best-effort LLM abstractive nuance) + the last KEEP_TURNS tool-call turns
 *  verbatim. Slices ONLY at assistant-tool-call boundaries so every tool result
 *  keeps its preceding tool_calls (API-valid). Returns true when it compacted.
 *  Dropped detail stays RECOVERABLE via read_spec / inspect_run (AgentFold-style
 *  look-back), so nothing is truly lost — only paged out of the hot context. */
export async function maybeCompact(messages: ChatMsg[], ctx: BrainCtx): Promise<boolean> {
  const THRESHOLD = envInt("FACTORY_COMPACT_THRESHOLD", 120_000); // #9c env-overridable
  const KEEP_TURNS = envInt("FACTORY_COMPACT_KEEP_TURNS", 6);
  const size = messages.reduce(
    (n, m) => n + (typeof m.content === "string" ? m.content.length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0),
    0,
  );
  if (size < THRESHOLD) return false;
  // indices of assistant messages that opened a tool-call turn (after system+goal)
  const turnStarts = messages.map((m, i) => (m.role === "assistant" && m.tool_calls?.length ? i : -1)).filter((i) => i >= 2);
  if (turnStarts.length <= KEEP_TURNS) return false; // not enough turns to fold
  const cutAt = turnStarts[turnStarts.length - KEEP_TURNS];
  const dropped = messages.slice(2, cutAt);
  const structured = buildStateSummary(ctx);           // tier-1: faithful anchor (always)
  const narrative = await summarizeDropped(dropped);   // tier-2: abstractive nuance (best-effort)
  const content = structured + (narrative ? `\n\n【折叠轮次的推理脉络(摘要)】\n${narrative}` : "");
  messages.splice(2, cutAt - 2, { role: "system", content });
  return true;
}

export async function* runBrain(opts: {
  domain: string;
  goal: string;
  tools: BrainTool[];
  /** Aborts the loop when the SSE client disconnects, so a closed chatbot tab
   *  stops the brain instead of leaving it looping + burning LLM calls. */
  signal?: AbortSignal;
  /** Internal: when this brain IS itself a spawn_subagent run, suppress writing
   *  any FailureReflection / persist side effects (sub-brains are exploration only). */
  isSubAgent?: boolean;
  /** RANK-5 (HITL): the FactoryBrainRun id, so the conductor can drain
   *  human-injected messages from the mailbox at each turn boundary. */
  runId?: string;
  /** CHATBOT: the conversation key. If a conversation under this id already exists,
   *  RESUME it (load prior messages + ctx, append this `goal` as the next user turn)
   *  instead of starting a fresh pipeline. Saved at the end of every turn-cluster so
   *  the next message continues. Usually = runId (the first run's id). */
  conversationId?: string;
}): AsyncGenerator<BrainEvent> {
  const buffer: BrainEvent[] = [];

  // CHATBOT: resume an existing conversation (its ctx carries the ontology, specs,
  // plan, reflections already) so a follow-up continues instead of restarting.
  // DURABLE: if the in-memory cache was wiped (server restart/HMR recompile), pull
  // the ctx back from Postgres FIRST so "继续" genuinely resumes — the bug the user
  // hit was the in-memory store being gone, so a follow-up started over.
  if (!opts.isSubAgent && opts.conversationId && !hasConversation(opts.conversationId)) {
    await rehydrateConversation(opts.conversationId);
  }
  const saved = !opts.isSubAgent && opts.conversationId ? getConversation(opts.conversationId) : undefined;

  // P1-4: load prior reflections for this domain so the brain starts wiser.
  // Sub-brains don't load — they're focused exploration, not main pipeline.
  const priorReflections = saved ? saved.ctx.priorReflections : (opts.isSubAgent ? [] : await loadReflections(opts.domain));

  const ctx: BrainCtx = saved ? saved.ctx : {
    domain: opts.domain,
    goal: opts.goal,
    emit: (e) => buffer.push(e),
    specs: [],
    ontology: null,
    registry: null,
    createdSkills: [],
    research: [],
    budget: { maxTokens: MAX_TOKENS, maxTurns: MAX_TURNS },
    spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    // Upgraded state
    currentPlan: null,
    attemptHistory: {},
    lastSandboxRunIds: [],
    lastSandboxVersionLabel: null,
    lastSandbox: null,
    humanDirectives: [],
    lastValidation: null,
    priorReflections,
    rulesByAction: {},
    suggestedToolsByAction: {},
    pendingSandboxDomain: null,
  };
  ctx.emit = (e) => buffer.push(e); // (re)point emit to THIS turn's buffer (resume reuses ctx)
  ctx.goal = opts.goal;
  ctx.runId = opts.runId;     // P2: long tools peek the mailbox via this
  ctx.signal = opts.signal;   // P2: spawn_subagent forwards this so abort cascades

  const toolSchemas: ToolSchema[] = opts.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  const messages: ChatMsg[] = saved
    ? (saved.messages.push({ role: "user", content: opts.goal }), saved.messages) // follow-up turn
    : [
    { role: "system", content: systemPrompt(opts.domain, priorReflections) },
    { role: "user", content: opts.goal },
  ];
  // On RESUME, messages[0] is the system prompt frozen when the conversation started —
  // refresh it so prompt improvements (the routing 铁律) apply to ongoing conversations
  // too, not just brand-new ones.
  if (saved && messages[0]?.role === "system") {
    messages[0] = { role: "system", content: systemPrompt(opts.domain, priorReflections) };
  }

  // Closure flag for the fail-safe reflection write. Set when ANY t:"reflect"
  // event is yielded (either by analyze_failure, by the new finish that writes
  // its own reflection, or by an earlier fail-safe). Read after the loop ends
  // to decide whether to synthesize one. Tracking the event (not "did finish
  // run") makes the fail-safe robust to HMR / stale-module cases where finish
  // doesn't actually write — we still get a cross-run lesson.
  let sawReflect = false;
  // Function-scoped outcome flags (the loop-local `finished` isn't visible after
  // the loop). Drive the honest terminal `status` on the done event.
  let finishedOk = false;
  let erroredOut = false;
  let finishRefusals = 0; // RANK-1 caveat: consecutive finish-gate refusals → honest-fail nudge
  // COMPLETION GUARD: the brain must design ALL Agent actions before stopping. When it
  // chats mid-generation (no tool call) with coverage still incomplete, we nudge it on
  // instead of ending the run. Bounded, but the budget RESETS whenever a new agent gets
  // designed (real progress) — so only a genuinely stuck brain ever hits the cap.
  let incompleteNudges = 0;
  let nudgeBaselineSpecs = 0;
  // Feature 2: how many ~1.2s ticks we've parked waiting for the test-case decision.
  // Capped so a forgotten run auto-proceeds (implicit approve) instead of hanging.
  let parkTicks = 0;
  const PARK_TIMEOUT_MS = Number(process.env.FACTORY_TEST_APPROVAL_TIMEOUT_MS) || 20 * 60_000;
  const PARK_MAX_TICKS = Math.max(30, Math.round(PARK_TIMEOUT_MS / 1200));

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (opts.signal?.aborted) break; // client disconnected → stop looping

      // Feature 2 — TEST-CASE APPROVAL GATE. If the brain proposed test cases, PARK
      // here: poll the mailbox (no LLM turn, no turn consumed) until the user decides
      // 执行 / 重新生成. The run is in the background, so parking survives navigation —
      // the user can return and click. A non-decision message is a steering directive.
      if (!opts.isSubAgent && ctx.awaitingApproval) {
        const human = await drainHumanMsgs(opts.runId);
        let decided: null | { decision: "approve" | "regenerate"; note: string } = null;
        for (const text of human) {
          const m = text.match(/^\[测试用例决策[:：]\s*(执行|approve|重新生成|regenerate)\]\s*([\s\S]*)$/i);
          if (m) decided = { decision: /执行|approve/i.test(m[1]) ? "approve" : "regenerate", note: (m[2] ?? "").trim() };
          else { ctx.humanDirectives.push(text); messages.push({ role: "user", content: `[人工介入] ${text}` }); yield { t: "message", text: `🧑 收到你的介入：「${text}」` }; }
        }
        if (!decided && parkTicks >= PARK_MAX_TICKS) {
          decided = { decision: "approve", note: "(超过等待时限，自动确认执行)" };
          yield { t: "message", text: "⏱ 用例确认等待超时——自动按「执行」继续试运行。" };
        }
        if (!decided) { parkTicks++; await new Promise((r) => setTimeout(r, 1200)); turn--; continue; }
        parkTicks = 0;
        ctx.awaitingApproval = false;
        ctx.emit({ t: "test.decision", decision: decided.decision, note: decided.note || undefined });
        if (decided.decision === "approve") {
          messages.push({ role: "user", content: "[测试用例决策] 用户已确认执行这批测试用例。现在调用 sandbox_run 真实部署并用这些用例触发跑通,然后让我看每个 agent 的真实输入/输出。" });
          yield { t: "message", text: "✅ 你确认了用例——开始真实试运行。" };
        } else {
          messages.push({ role: "user", content: `[测试用例决策] 用户要求重新生成测试用例${decided.note ? `，要求：${decided.note}` : ""}。请调用 generate_test_cases 重新设计一批,再 propose_test_cases 给用户确认。` });
          yield { t: "message", text: `🔄 你要求重做用例${decided.note ? `：${decided.note}` : ""}——重新生成中。` };
        }
      }

      // BOUNDARY-EVENT GATE (mirrors the test-case gate). After the brain proposes
      // boundary events, PARK polling the mailbox until the user submits their per-event
      // classification (external handoff / terminal / break) + external contracts.
      if (!opts.isSubAgent && ctx.awaitingBoundary) {
        const human = await drainHumanMsgs(opts.runId);
        let decided: BoundaryEvent[] | null = null;
        for (const text of human) {
          const m = text.match(/^\[边界事件决策\]\s*([\s\S]+)$/);
          if (m) {
            try {
              const parsed = JSON.parse(m[1].trim());
              if (Array.isArray(parsed)) {
                decided = parsed
                  .filter((e) => e && typeof e === "object" && typeof e.event === "string")
                  .map((e) => ({
                    event: String(e.event),
                    kind: (["external", "terminal", "break"].includes(String(e.kind)) ? String(e.kind) : "external") as BoundaryEvent["kind"],
                    consumer: typeof e.consumer === "string" ? e.consumer : undefined,
                    payloadContract: typeof e.payloadContract === "string" ? e.payloadContract : undefined,
                    note: typeof e.note === "string" ? e.note : undefined,
                  }));
              }
            } catch { /* malformed → keep parking */ }
          } else { ctx.humanDirectives.push(text); messages.push({ role: "user", content: `[人工介入] ${text}` }); yield { t: "message", text: `🧑 收到你的介入：「${text}」` }; }
        }
        if (!decided && parkTicks >= PARK_MAX_TICKS) {
          // timeout → auto-apply the AI's own suggested classification.
          decided = (ctx.boundaryProposals ?? []).map((p) => ({ event: p.event, kind: p.suggestedKind, consumer: p.consumer, payloadContract: p.payloadContract }));
          yield { t: "message", text: "⏱ 边界事件确认超时——按你的初判处理继续。" };
        }
        if (!decided) { parkTicks++; await new Promise((r) => setTimeout(r, 1200)); turn--; continue; }
        parkTicks = 0;
        ctx.awaitingBoundary = false;
        ctx.boundaryProposals = undefined;
        const byEv = new Map((ctx.boundaryEvents ?? []).map((b) => [b.event, b]));
        for (const b of decided) byEv.set(b.event, b);
        ctx.boundaryEvents = [...byEv.values()];
        ctx.lastValidation = null; // re-validate with the new boundary classification
        ctx.emit({ t: "boundary.decided", events: decided });
        const ext = decided.filter((b) => b.kind === "external");
        const term = decided.filter((b) => b.kind === "terminal");
        const brk = decided.filter((b) => b.kind === "break");
        messages.push({ role: "user", content: `[边界事件决策] 用户已分类:${decided.map((b) => `${b.event}=${b.kind}${b.consumer ? `(${b.consumer})` : ""}`).join("; ")}。${ext.length ? `把这些【外部交接】事件各总结成一份「对外契约」(事件名、payload 字段、触发时机、含义)用文字清晰呈现给我看,供下游消费方核对。` : ""}${brk.length ? `这些被判为【真断点】的事件(${brk.map((b) => b.event).join("、")})要你 refine_agent/补 agent 修。` : ""}外部/终态事件已不再算断点,继续推进。` });
        yield { t: "message", text: `✅ 边界事件已确认(${ext.length} 外部交接 · ${term.length} 终态 · ${brk.length} 待修断点)。` };
      }

      // #4 ASK-USER GATE (mirrors the test-case / boundary gates). After the brain calls ask_user,
      // PARK: poll the mailbox until the user answers (free-form text OR a clicked option). Survives
      // navigation; a long timeout proceeds on the brain's best judgment so a forgotten run can't hang.
      if (!opts.isSubAgent && ctx.awaitingAsk) {
        const human = await drainHumanMsgs(opts.runId);
        let answer: string | null = null;
        for (const text of human) { const a = text.trim(); if (a) { answer = a; break; } }
        if (answer === null && parkTicks >= PARK_MAX_TICKS) answer = "(用户未在时限内回答，按你的最佳判断继续，别再问同一个问题)";
        if (answer === null) { parkTicks++; await new Promise((r) => setTimeout(r, 1200)); turn--; continue; }
        parkTicks = 0;
        const asked = ctx.pendingAsk?.question ?? "";
        const askId = ctx.pendingAsk?.id ?? "";
        ctx.awaitingAsk = false;
        ctx.pendingAsk = undefined;
        ctx.humanDirectives.push(`对问题「${asked}」的回答：${answer}`);
        messages.push({ role: "user", content: `[用户回答] 针对你的问题「${asked}」，用户回答：${answer}。据此继续，别再重复问同样的问题。` });
        yield { t: "ask_user", id: askId, question: asked, awaitingAnswer: false };
        yield { t: "message", text: `🧑 你回答了：${answer}` };
      }

      ctx.spent.turns = turn + 1;

      // RANK-5 (HITL): drain any human messages injected since the last turn and
      // feed them to the brain as an AUTHORITATIVE user turn. Injected at the turn
      // boundary (between tool turns) so tool_calls↔tool-result pairing stays
      // API-valid. The brain is free to analyze / re-plan / verify them with tools
      // — it's steering, not a hard command. Directives also persist in ctx so
      // they survive compaction (see buildStateSummary).
      if (!opts.isSubAgent) {
        const human = await drainHumanMsgs(opts.runId);
        for (const text of human) {
          ctx.humanDirectives.push(text);
          messages.push({ role: "user", content: `[人工介入] ${text}` });
          yield { t: "message", text: `🧑 收到你的介入：「${text}」——我会在下一步把它纳入分析。` };
        }
      }

      // Auto-compaction: fold the verbose early history into a state summary once
      // it gets large, so a long run stays within the context window WITHOUT
      // turn-capping it short. The structured state lives in ctx, so nothing the
      // brain needs is lost. Emit a notice so the user sees it happened.
      if (await maybeCompact(messages, ctx)) {
        // #2d FIX: surface compaction as a first-class, EXPANDABLE event. After maybeCompact splices
        // the folded summary in at index 2, messages[2] IS that snapshot — pass it as `state` so the
        // UI can show exactly what was compacted behind a hide/expand toggle.
        const state = typeof messages[2]?.content === "string" ? messages[2]!.content : buildStateSummary(ctx);
        yield { t: "compaction", summary: "上下文已自动压缩：保留近期若干轮 + 结构化状态 + 推理脉络摘要，早期冗长输出已折叠（细节仍可 inspect_run / read_spec 取回）。", state };
      }

      // R2-5: inject a budget hint every 3 turns so the brain can pace itself.
      // Sub-brains skip — they have their own focused budget concerns.
      if (!opts.isSubAgent && turn > 0 && turn % 3 === 0) {
        const tokenK = Math.round(ctx.spent.tokens / 1000);
        const tokenStr = MAX_TOKENS == null ? `${tokenK}k tokens(无上限)` : `${tokenK}k/${Math.round(MAX_TOKENS / 1000)}k tokens`;
        // COST METER (A): SOFT thresholds only — surface the level + nudge the brain
        // to converge when high, but NEVER block (user vetoed hard caps). Tunable
        // via env. This is the "cost meter + 软阈值" the user asked for.
        const elevatedAt = Number(process.env.FACTORY_COST_ELEVATED_TOKENS) || 2_000_000;
        const highAt = Number(process.env.FACTORY_COST_HIGH_TOKENS) || 4_000_000;
        const level = ctx.spent.tokens >= highAt ? "high" : ctx.spent.tokens >= elevatedAt ? "elevated" : "ok";
        const costNote =
          level === "high"
            ? `⚠ 成本偏高(${tokenK}k tokens · ${ctx.spent.sandboxRuns} 次沙箱)——若已接近可交付,优先收敛到 finish,别再开新探索分支。`
            : level === "elevated"
              ? `成本中高(${tokenK}k tokens)——能 finish 就别再额外 refine。`
              : undefined;
        messages.push({
          role: "system",
          content: `[预算检查] 已用 ${turn}/${MAX_TURNS} turn · ${tokenStr} · ${ctx.spent.sandboxRuns} 次沙箱 · 已造 ${ctx.specs.length} 个 agent · ${ctx.lastSandboxRunIds.length ? "上次沙箱已跑过" : "尚未跑沙箱"}${ctx.currentPlan ? ` · BuildPlan v${ctx.currentPlan.version} 在场` : " · 没计划"}。${costNote ?? "如果你还在前期探索，继续；如果接近 finish，记得带上 reflection。"}`,
        });
        yield {
          t: "budget",
          turn,
          maxTurns: MAX_TURNS,
          tokens: ctx.spent.tokens,
          maxTokens: MAX_TOKENS,
          specsBuilt: ctx.specs.length,
          sandboxRuns: ctx.spent.sandboxRuns,
          level,
          costNote,
        };
      }

      let pendingCalls: { id: string; name: string; args: string }[] | null = null;
      let assistantContent = "";

      // P5 — constrained decoding. Once the ontology/registry are known, rebuild
      // the design_agent/refine_agent schemas with enum constraints over the REAL
      // action + tool names, so the model can't emit invented symbols (when the
      // gateway honors enum). Cheap to rebuild each turn; before read_ontology
      // (ontology null) the base schemas are used as-is.
      const groundedSchemas = ctx.ontology
        ? injectGroundingEnums(toolSchemas, {
            actionNames: ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name),
            toolNames: ctx.registry?.names() ?? [],
          })
        : toolSchemas;

      // #7: route this turn's model by DIFFICULTY through a config-driven fallback chain — fast
      // while reading/planning, hard once designing/coding/refining; an isolated sub-brain stays on
      // the fast tier. streamTurn falls through the chain on a model the gateway can't serve, and
      // reports which model actually served the turn so the activity log can annotate it.
      const tier: "fast" | "default" | "hard" = opts.isSubAgent ? "fast" : tierForContext(ctx);
      for await (const ev of streamTurn(messages, groundedSchemas, { signal: opts.signal, models: modelChain(tier) })) {
        if (ev.t === "think") yield { t: "think", delta: ev.delta };
        else if (ev.t === "model") yield { t: "model", model: ev.model, tier, turn: turn + 1 };
        else if (ev.t === "usage") ctx.spent.tokens += ev.promptTokens + ev.completionTokens;
        else if (ev.t === "tool_calls") { pendingCalls = ev.calls; assistantContent = ev.content; }
        else if (ev.t === "done") assistantContent = ev.content;
      }

      // No tool calls → the brain is talking; treat as its answer for this turn.
      if (!pendingCalls || pendingCalls.length === 0) {
        if (assistantContent.trim()) yield { t: "message", text: assistantContent.trim() };
        // COMPLETION GUARD — don't let a generation stop mid-way on a chatty turn. If the
        // brain committed to generating (made a plan / designed ≥1 agent) but the ontology's
        // Agent actions aren't all covered and it hasn't successfully finished, tell it
        // exactly what's left and KEEP LOOPING (this was the "stops after createJD (1/6)"
        // bug: the model coded one agent, chatted, and the loop broke). The nudge budget
        // resets on real progress, so a stuck brain still exits instead of spinning.
        // #8 FIX: gate ONLY on real specs existing — NOT on a plan alone. A plan can exist for an
        // analysis/exploration turn the user never asked to finish; nudging then makes "分析一下这个域"
        // requests loop forever. The genuine generation path still trips this once the first spec exists.
        if (!opts.isSubAgent && !finishedOk && ctx.ontology && ctx.specs.length > 0) {
          const agentActions = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
          const covered = new Set(ctx.specs.map((s) => s.actionName));
          const remaining = agentActions.filter((a) => !covered.has(a));
          if (ctx.specs.length > nudgeBaselineSpecs) { incompleteNudges = 0; nudgeBaselineSpecs = ctx.specs.length; } // real progress → refill the nudge budget
          if (incompleteNudges < 5) {
            incompleteNudges += 1;
            if (remaining.length > 0) {
              // DESIGN phase: still agents to build — point at the next uncovered one.
              messages.push({ role: "user", content: `[继续生成 · 别停在中途] 这个任务要为本域生成【全部 ${agentActions.length} 个 Agent】,你现在只设计了 ${ctx.specs.length} 个(${[...covered].join("、") || "无"}),还差 ${remaining.length} 个:${remaining.join("、")}。立刻 design_agent 设计【下一个还没设计的】(${remaining[0]}),逐个把剩下的都设计完(每个 design_agent + codegen_agent),全齐了再 validate_graph → sandbox_run → finish。别只反复改 ${[...covered][0] ?? "同一个"}、也别现在停下来问我。` });
              yield { t: "message", text: `↪ 还差 ${remaining.length} 个 agent 没设计(${remaining.join("、")})——继续把它们造完，别停。` };
            } else {
              // FINISH phase: all designed but not finished — push validate → sandbox → finish.
              messages.push({ role: "user", content: `[完成它] 全部 ${ctx.specs.length} 个 agent 都已设计。现在按顺序收尾:validate_graph → (有问题就 refine_agent 修) → sandbox_run(用测试用例真跑通事件链) → finish。别停在这里、别只是描述,真去调工具完成。` });
              yield { t: "message", text: `↪ ${ctx.specs.length} 个 agent 都设计好了——继续 validate → sandbox → finish，别停。` };
            }
            continue; // keep the ReAct loop running instead of ending mid-generation
          }
        }
        break;
      }

      // Append the assistant's tool-call message to history.
      messages.push({
        role: "assistant",
        content: assistantContent || null,
        tool_calls: pendingCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
      });

      let finished = false;
      for (const call of pendingCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.args || "{}"); } catch { args = {}; }
        const reasoning = typeof args.reasoning === "string" ? args.reasoning : "";
        // NOTE: we intentionally do NOT re-emit `reasoning` as a synthetic
        // think delta. Visible "thinking" must be REAL streamed content from
        // the LLM (the system prompt now requires it). Injecting a tool-arg
        // string here previously made the UI look like the model was thinking
        // when it had skipped content emission and gone straight to tool calls.
        yield { t: "tool.call", id: call.id, name: call.name, reasoning, input: args };

        const tool = byName.get(call.name);
        let result;
        if (!tool) result = { ok: false, summary: `未知工具 ${call.name}` };
        else {
          try { result = await tool.execute(args, ctx); }
          catch (e) { result = { ok: false, summary: `工具 ${call.name} 出错：${(e as Error).message}` }; }
        }
        // drain any events the tool emitted (agent.created / validation / sandbox)
        while (buffer.length) {
          const ev = buffer.shift()!;
          if (ev.t === "reflect") sawReflect = true;
          yield ev;
        }
        // #5: stream the FULL tool output (not just the one-line summary) so the 活动日志 shows
        // complete I/O. Capped generously so a huge read_ontology doesn't bloat the SSE.
        const outStr = result.output !== undefined ? (typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)) : undefined;
        const outForUi = outStr && outStr.length > 16000 ? outStr.slice(0, 16000) + "\n…[输出过长已截断，完整内容用对应工具重取]" : outStr;
        yield { t: "tool.result", id: call.id, name: call.name, ok: result.ok, summary: result.summary, output: outForUi };
        // RANK-2 fix: the old `JSON.stringify(result.output).slice(0,8000)` DROPPED
        // result.summary entirely when output existed, and hard-capped at 8000 —
        // so read_ontology's big output (44 DataObjects woven in) lost actions
        // 2..N + the whole tool catalog + event_flow, and the brain HALLUCINATED
        // the rest. Now: always keep the summary, and use a generous per-tool cap
        // (maybeCompact at 120k handles total context). Truncation is marked, not
        // silent, so the brain knows to re-fetch instead of guessing.
        const TOOL_RESULT_CAP = 60_000;
        const toolBody = result.output !== undefined
          ? { summary: result.summary, output: result.output }
          : { ok: result.ok, summary: result.summary };
        let toolContent = JSON.stringify(toolBody);
        if (toolContent.length > TOOL_RESULT_CAP) {
          toolContent = toolContent.slice(0, TOOL_RESULT_CAP) + `…[本工具结果过长,已截断到 ${TOOL_RESULT_CAP} 字符;需要完整内容请用对应工具(如 read_action / read_spec)重取,不要凭记忆脑补]`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: toolContent });

        // #3 FIX (memory safety net): if a grounding tool rejected an unknown action/event/field
        // name — the brain forgot the real symbol after compaction — don't just surface the error.
        // Re-inject the REAL names from ctx.ontology (which survives compaction in memory) so the
        // next turn self-corrects without a wasted re-read. Cheap: no extra LLM/tool call.
        if (!result.ok && ctx.ontology && /design_agent|refine_agent|codegen_agent|reuse_agent/.test(call.name) && /未知|不存在|unknown|not found|没有该|无效|invalid|找不到/.test(String(result.summary ?? ""))) {
          const acts = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
          const evs = ctx.ontology.events.map((e) => e.name);
          messages.push({ role: "system", content: `[命名纠正] 你引用了本体里不存在的名字。只能用这些真名(别脑补)：可用 Agent 动作: ${acts.join("、")}；可用事件: ${evs.join("、")}。据此改正后重试。` });
        }

        // P0 — the finish tool can REFUSE (ok:false) when actor=Agent actions are
        // still uncovered; only a successful finish ends the loop, so the brain is
        // forced back to design the missing agents. (Without the `result.ok` guard
        // the loop would break on the finish call regardless, which is exactly how
        // the rule-check agent was silently dropped.)
        if (call.name === "finish") {
          if (result.ok) { finished = true; finishedOk = true; }
          else if (!opts.isSubAgent) {
            // The behavioral gate refused finish. If it keeps refusing, a genuinely
            // unrunnable domain shouldn't grind to MAX_TURNS — nudge an honest fail.
            finishRefusals += 1;
            if (finishRefusals >= 4) {
              messages.push({ role: "system", content: `[诚实收尾] 你已被验收门拒绝 ${finishRefusals} 次。如果反复 verify_chain/refine/codegen/sandbox_run 仍跑不通,很可能是数据/环境限制或本体本身的问题——【不要继续硬试】,改调 analyze_failure(kind=failure) 把真实根因记下来诚实收尾,这比假装成功有价值得多。` });
              yield { t: "message", text: `⚠ 验收门已拒绝 ${finishRefusals} 次——若确实跑不通,请 analyze_failure 诚实收尾,别硬试到耗尽预算。` };
            }
          }
        }
      }

      if (finished) break;
      if (MAX_TOKENS != null && ctx.spent.tokens >= MAX_TOKENS) { yield { t: "message", text: "已达 token 预算上限，停止。" }; break; }
    }
  } catch (e) {
    erroredOut = true;
    const raw = (e as Error).message ?? "";
    // Make a transient gateway hiccup read as what it is — an upstream capacity
    // blip, not an agent bug — and tell the user it's safe to resume.
    const transient = /overload|\b50[234]\b|temporarily|unavailable|timeout|timed out|too many requests|rate.?limit|econn|socket hang/i.test(raw);
    const message = transient
      ? `AI 网关临时过载/不可用(${raw.slice(0, 80)})——已自动重试多次仍未恢复。这是上游算力波动，不是 agent 的问题。已生成的内容都在，稍等点「重新开始」续跑即可。`
      : raw;
    yield { t: "error", message };
  } finally {
    // The DEDICATED sandbox app stayed deployed (visible + inspectable) through
    // the session. Now the brain is done — tear it down (delete the ephemeral
    // sandbox rows + offline the sandbox app). The real domain's Fleet drafts are
    // separate + untouched; the operator owns the final deploy via the Fleet.
    // Best-effort; never block. Sub-brains never ship.
    if (!opts.isSubAgent && ctx.pendingSandboxDomain) {
      await teardownSandbox(ctx.pendingSandboxDomain).catch(() => {});
      ctx.pendingSandboxDomain = null;
    }
    await disposeMailbox(opts.runId); // RANK-5: drop the HITL mailbox when the run ends
    // SkillsBench (B): record this run's sandbox verdict against every skill it USED,
    // so loadSkills can rank by effectiveness (did reuse actually help?) not just by
    // reuse count. One eval per skill per run; only when a sandbox produced a verdict.
    if (!opts.isSubAgent && ctx.lastSandbox && ctx.createdSkills.length) {
      const ok = ctx.lastSandbox.fullChainRan;
      for (const s of ctx.createdSkills) await recordSkillEvaluation(slugifySkill(s.name), ok).catch(() => {});
    }
    // CHATBOT: persist messages + ctx so the user's NEXT message continues this same
    // conversation (ontology/specs/plan intact) instead of restarting the pipeline.
    if (!opts.isSubAgent && opts.conversationId) {
      saveConversation(opts.conversationId, messages, ctx);
      // Mirror to Postgres (awaited so the checkpoint is durable before the run
      // fully ends) — this is what lets a later "继续" survive a server restart.
      await persistConversation(opts.conversationId, messages, ctx);
    }
  }

  // R2-1 fail-safe: if no reflection was written by the LLM (analyze_failure
  // / finish-with-reflection), synthesize one from observable state and
  // persist it so next time isn't amnesiac. Sub-brains opt out (no
  // pipeline-level lessons to record).
  if (!opts.isSubAgent && !sawReflect) {
    try {
      const refineCount = Object.values(ctx.attemptHistory).reduce((n, h) => n + h.length, 0);
      const sawSandbox = ctx.lastSandboxRunIds.length > 0;
      const tokenExhausted = MAX_TOKENS != null && ctx.spent.tokens >= MAX_TOKENS;
      const note = tokenExhausted
        ? `token 预算耗尽 (${Math.round(ctx.spent.tokens / 1000)}k / ${Math.round((MAX_TOKENS as number) / 1000)}k) 前未能结束`
        : ctx.spent.turns >= MAX_TURNS
          ? `turn 预算耗尽 (${ctx.spent.turns}/${MAX_TURNS}) 前未能结束`
          : `循环退出但没正常 finish`;
      await prisma.failureReflection.create({
        data: {
          domain: opts.domain,
          kind: "caveat",
          summary: `${note}：${ctx.specs.length} agent + ${refineCount} refine + sandbox ${sawSandbox ? "已跑" : "未跑"}`,
          rootCause: tokenExhausted ? "迭代次数过多 / 单 turn 内容过大" : null,
          lesson: tokenExhausted
            ? "下次为该域生成时：早一点 finish；refine 失败 2 次后改换思路而不是继续迭代；inspect_run 用 failed_only=true 省 token。"
            : "下次为该域生成时：循环走偏时早点 finish 总结现状，留下经验比空手退出有价值。",
          ranAgents: ctx.specs.length ? JSON.stringify(ctx.specs.map((s) => s.short)) : null,
        },
      });
      yield { t: "reflect", kind: "caveat", lesson: "(自动) 退出前留下了一条警示反思" };
    } catch { /* never block the done event on a DB hiccup */ }
  }

  // Honest terminal verdict: only a finish that PASSED the acceptance gate is
  // success; everything else is a failed/incomplete run.
  const status: Extract<BrainEvent, { t: "done" }>["status"] =
    finishedOk ? "finished"
    : erroredOut ? "errored"
    : (MAX_TOKENS != null && ctx.spent.tokens >= MAX_TOKENS) ? "budget_exhausted"
    : ctx.spent.turns >= MAX_TURNS ? "turns_exhausted"
    : "incomplete";
  yield { t: "done", tokensUsed: ctx.spent.tokens, turns: ctx.spent.turns, status };
}


// re-export so the route can warm the ontology cheaply if needed
export { fetchRunnableOntology };
