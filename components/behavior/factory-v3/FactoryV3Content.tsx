"use client";

// Agent Factory v3 — the autonomous Harness brain cockpit (Claude/Codex-style).
//
// Center = a streaming conversation: the brain's reasoning streams in, tool
// calls render as cards (reasoning → input → result), generated agents + sandbox
// runs appear inline. Right inspector = Agents (tools used + agents made) ·
// Trace (full chronological log) · Eval (validation + real sandbox run).
// Driven by the BrainEvent SSE stream from /api/factory-v3/brain/stream.

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { BrainEvent, AgentCardLite, ToolCardLite, AgentDesignLite, TestCase, AgentRunIO, CaseResult, BoundaryProposal, BoundaryEvent } from "@/lib/agent-factory-v3/brain/types";

// AI replies are markdown — render them (headers/bold/lists/code/tables) instead of
// dumping raw text. GFM enables tables/strikethrough/task-lists; breaks keeps single
// newlines as line breaks (so plain multi-line text doesn't collapse).
function Markdown({ children }: { children: string }) {
  return <div className="fv3-md"><ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{children}</ReactMarkdown></div>;
}
import { Ic } from "@/components/shared/Ic";

const FACTORY_TOKEN = process.env.NEXT_PUBLIC_FACTORY_TOKEN ?? "";

// Factory domains are LIVE Allmeta→Neo4j ids only (no snapshot). recruit-gen-v1
// was a snapshot-only id (absent from Allmeta) — it would now fail-closed, so the
// live recruitment ontology is read via Agents-generation instead.
const DOMAINS = [
  { id: "Agents-generation", label: "招聘 (Agents 生成)", tag: "Agents-generation" },
  { id: "energy", label: "能源调度", tag: "energy" },
  { id: "feikong", label: "费控", tag: "feikong" },
];

// Empty-state pipeline + example goals (click to fill the composer).
const PIPELINE_STEPS = ["读业务定义", "规划", "设计", "校验", "试运行", "交付"];
const EXAMPLE_GOALS = [
  "为这个业务域生成能真正跑通的智能体，并试运行验证整条事件链。",
  "只生成「简历处理 → 规则校验 → 简历匹配」这条链路的智能体。",
  "生成全部智能体，重点把每个智能体的强制业务规则写进它的指令。",
];

// Business-language labels for every builder step (no raw tool names / English
// "agent" / "ontology" / "sandbox" leaking to the user).
const TOOL_LABEL: Record<string, string> = {
  read_ontology: "读业务定义",
  create_plan: "制定计划",
  list_agents: "看已造智能体",
  read_spec: "看设计",
  design_agent: "设计智能体",
  codegen_agent: "写代码",
  refine_agent: "修订智能体",
  revert_refine: "回滚修订",
  diff_spec: "看改动",
  score_spec: "评分",
  validate_graph: "校验事件图",
  review_agent: "独立审查",
  verify_chain: "定位断点",
  sandbox_run: "试运行验证",
  inspect_run: "查运行细节",
  analyze_failure: "复盘反思",
  finish: "完成交付",
  web_search: "联网检索",
  create_skill: "沉淀技能",
  use_skill: "复用技能",
  create_tool: "造工具",
  fetch_doc: "取开发文档",
  spawn_subagent: "派辅助大脑",
};

type Block =
  | { kind: "think"; text: string }
  | { kind: "tool"; id: string; name: string; reasoning: string; input: unknown; model?: string; result?: { ok: boolean; summary: string; output?: string } }
  | { kind: "agent"; spec: AgentCardLite; design?: AgentDesignLite }
  | { kind: "validation"; ok: boolean; issues: string[]; agentIssueMap?: Record<string, unknown[]> }
  | { kind: "sandbox"; ran: number; reachedTerminal: boolean; reachedSuccessTerminal?: boolean; agents: string[]; events: string[]; appId?: string; functionsRegistered?: number; deployed?: number; fullChainRan?: boolean; deployFailed?: boolean; degradedAgents?: string[]; missedAgents?: string[]; runUrls?: Array<{ runId: string; url: string; status: string; fn: string }>; agentRuns?: AgentRunIO[]; cases?: Array<{ name: string; entryEvent: string; payload: Record<string, unknown> }>; caseResults?: CaseResult[] }
  | { kind: "testcases"; cases: TestCase[]; awaitingApproval: boolean; decided?: "approve" | "regenerate" }
  | { kind: "boundarycases"; proposals: BoundaryProposal[]; awaitingDecision: boolean; decided?: boolean }
  | { kind: "boundarydecided"; events: BoundaryEvent[] }
  | { kind: "web"; query: string; results: Array<{ title: string; url: string; snippet: string }> }
  | { kind: "skill"; name: string; purpose: string }
  | { kind: "toolnew"; name: string; description: string }
  | { kind: "subagent"; task: string; summary?: string }
  | { kind: "plan"; summary: string; agentCount: number; version: number; planAgents: Array<{ actionName: string; role: string }> }
  | { kind: "refine"; actionName: string; attemptNumber: number; critique: string; diff?: { systemPromptChanged: boolean; toolsAdded: string[]; toolsRemoved: string[]; decisionLogicChanged: boolean } }
  | { kind: "inspect"; runId: string; agentSlug: string; status: string; degraded?: boolean; error?: string }
  | { kind: "reflect"; kind2: string; lesson: string }
  | { kind: "sandboxProgress"; phase: string; detail?: string; runsSoFar?: number; eventsSoFar?: number }
  | { kind: "message"; text: string }
  | { kind: "compaction"; summary: string; state: string }
  | { kind: "askuser"; id: string; question: string; options?: Array<{ label: string; value: string }>; context?: string; awaiting: boolean }
  | { kind: "error"; message: string };

function toBlocks(events: BrainEvent[]): Block[] {
  const blocks: Block[] = [];
  let think = "";
  let currentModel = ""; // #7 — the model the current turn was routed to; stamped on tool steps.
  const flush = () => { if (think.trim()) blocks.push({ kind: "think", text: think.trim() }); think = ""; };
  for (const e of events) {
    if (e.t === "think") { think += e.delta; continue; }
    if (e.t === "model") { currentModel = String(e.model || ""); continue; } // #7 — annotate following steps
    flush();
    if (e.t === "tool.call") blocks.push({ kind: "tool", id: e.id, name: e.name, reasoning: e.reasoning, input: e.input, model: currentModel || undefined });
    else if (e.t === "tool.result") {
      // #5: carry the FULL tool output (not just the one-line summary) so the activity log is complete.
      for (let i = blocks.length - 1; i >= 0; i--) { const b = blocks[i]; if (b.kind === "tool" && b.id === e.id) { b.result = { ok: e.ok, summary: e.summary, output: e.output ? String(e.output) : undefined }; break; } }
    } else if (e.t === "compaction") blocks.push({ kind: "compaction", summary: e.summary, state: e.state }); // #2d
    else if (e.t === "ask_user") { // #4
      if (e.awaitingAnswer) blocks.push({ kind: "askuser", id: e.id, question: e.question, options: e.options, context: e.context, awaiting: true });
      else { for (let i = blocks.length - 1; i >= 0; i--) { const b = blocks[i]; if (b.kind === "askuser" && b.id === e.id) { b.awaiting = false; break; } } }
    }
    else if (e.t === "agent.created") blocks.push({ kind: "agent", spec: e.spec, design: e.design });
    else if (e.t === "validation") blocks.push({ kind: "validation", ok: e.ok, issues: e.issues, agentIssueMap: e.agentIssueMap });
    else if (e.t === "sandbox") blocks.push({ kind: "sandbox", ran: e.ran, reachedTerminal: e.reachedTerminal, reachedSuccessTerminal: e.reachedSuccessTerminal, agents: e.agents, events: e.events, appId: e.appId, functionsRegistered: e.functionsRegistered, deployed: e.deployed, fullChainRan: e.fullChainRan, deployFailed: e.deployFailed, degradedAgents: e.degradedAgents, missedAgents: e.missedAgents, runUrls: e.runUrls, agentRuns: e.agentRuns, cases: e.cases, caseResults: e.caseResults });
    else if (e.t === "test.cases") blocks.push({ kind: "testcases", cases: e.cases, awaitingApproval: e.awaitingApproval });
    else if (e.t === "test.decision") { for (let i = blocks.length - 1; i >= 0; i--) { const b = blocks[i]; if (b.kind === "testcases") { b.awaitingApproval = false; b.decided = e.decision; break; } } }
    else if (e.t === "boundary.cases") blocks.push({ kind: "boundarycases", proposals: e.proposals, awaitingDecision: e.awaitingDecision });
    else if (e.t === "boundary.decided") { for (let i = blocks.length - 1; i >= 0; i--) { const b = blocks[i]; if (b.kind === "boundarycases") { b.awaitingDecision = false; b.decided = true; break; } } blocks.push({ kind: "boundarydecided", events: e.events }); }
    else if (e.t === "web.result") blocks.push({ kind: "web", query: e.query, results: e.results });
    else if (e.t === "skill.created") blocks.push({ kind: "skill", name: e.name, purpose: e.purpose });
    else if (e.t === "tool.created") blocks.push({ kind: "toolnew", name: e.name, description: e.description });
    else if (e.t === "subagent.start") blocks.push({ kind: "subagent", task: e.task });
    else if (e.t === "subagent.done") {
      for (let i = blocks.length - 1; i >= 0; i--) { const b = blocks[i]; if (b.kind === "subagent" && b.task === e.task) { b.summary = e.summary; break; } }
    } else if (e.t === "plan") blocks.push({ kind: "plan", summary: e.plan.summary, agentCount: e.plan.agents.length, version: e.plan.version, planAgents: e.plan.agents.map((a) => ({ actionName: a.actionName, role: a.role })) });
    else if (e.t === "refine") blocks.push({ kind: "refine", actionName: e.actionName, attemptNumber: e.attemptNumber, critique: e.critique, diff: e.diff });
    else if (e.t === "inspect") blocks.push({ kind: "inspect", runId: e.runId, agentSlug: e.agentSlug, status: e.status, degraded: e.degraded, error: e.error });
    else if (e.t === "reflect") blocks.push({ kind: "reflect", kind2: e.kind, lesson: e.lesson });
    else if (e.t === "sandbox.progress") {
      // Coalesce: replace the previous sandboxProgress block with this latest snapshot
      const i = blocks.findIndex((b) => b.kind === "sandboxProgress");
      const snap = { kind: "sandboxProgress" as const, phase: e.phase, detail: e.detail, runsSoFar: e.runsSoFar, eventsSoFar: e.eventsSoFar };
      if (i >= 0) blocks[i] = snap; else blocks.push(snap);
    }
    else if (e.t === "message") blocks.push({ kind: "message", text: e.text });
    else if (e.t === "error") blocks.push({ kind: "error", message: e.message });
  }
  flush();
  return blocks;
}

// Two agent planes get two surfaces: product agents (智能体 + 事件图) vs the
// harness/process agents that BUILD them (大脑 — the main brain + the sub-agents
// it spawns, each its own harness). They are deliberately NOT mixed.
type RightTab = "agents" | "eventgraph" | "harness" | "trace" | "knowledge" | "eval";

// Fix #3: per-domain localStorage cache so a page refresh restores the
// in-progress transcript instantly (the server-side FactoryBrainRun powers the
// durable 历史运行 list + cross-device).
const LS_KEY = (d: string) => `fv3:last:${d}`;
// The id of a run that's CURRENTLY running in the background for this domain. Set on
// run.started, cleared on done — so returning to the page (or switching back to the
// domain) re-attaches to the live run instead of just showing a stale transcript.
const ACTIVE_KEY = (d: string) => `fv3:active:${d}`;
type RunSummary = {
  id: string; domain: string; goal: string; status: string;
  tokensUsed: number; turns: number; agentsCount: number;
  reachedTerminal: boolean; createdAt: string;
};

export function FactoryV3Content() {
  const [domain, setDomain] = React.useState("Agents-generation");
  // EMPTY by default — the factory must NOT default to "generate everything". The user
  // types their actual intent (a greeting, a question, or a generation goal); the sample
  // chips below the composer one-click-fill the generation goal when that IS what's wanted.
  const [goal, setGoal] = React.useState("");
  const [events, setEvents] = React.useState<BrainEvent[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const [tab, setTab] = React.useState<RightTab>("agents");
  // fullscreen overlay for any detailed view (graph / prompt / code / tools).
  const [full, setFull] = React.useState<{ title: string; body: React.ReactNode } | null>(null);
  const [history, setHistory] = React.useState<RunSummary[]>([]);
  // non-null = viewing a past run read-only (don't overwrite the live cache).
  const [viewingRunId, setViewingRunId] = React.useState<string | null>(null);
  // RANK-5 (HITL): the live run's id (from the run.started SSE event) so the user
  // can inject steering messages mid-run; + the inject input box text.
  const [liveRunId, setLiveRunId] = React.useState<string | null>(null);
  const [injectText, setInjectText] = React.useState("");
  // CHATBOT: the conversation id (= the first run's id). Once set, the composer
  // CONTINUES the conversation (brain keeps its ontology/specs/plan) instead of
  // restarting the pipeline. `followup` is the continue-conversation input text.
  const [convId, setConvId] = React.useState<string | null>(null);
  const [followup, setFollowup] = React.useState("");
  // #6: AI run-review (score + problems + suggestions) of the current / viewed run.
  const [analysis, setAnalysis] = React.useState<Record<string, unknown> | null>(null);
  const [analyzing, setAnalyzing] = React.useState(false);
  const esRef = React.useRef<EventSource | null>(null);
  const doneRef = React.useRef(false);
  const feedRef = React.useRef<HTMLDivElement>(null);
  // Are we pinned to the bottom of the FEED? Starts true; flips false the moment
  // the user scrolls up, so streaming output never yanks them back down.
  const stickRef = React.useRef(true);
  const [showJump, setShowJump] = React.useState(false);
  const lastSaveRef = React.useRef(0);
  const mountedRef = React.useRef(true);

  // Unmount = navigate away. Closing the EventSource just UNSUBSCRIBES — the
  // background run keeps going server-side (that's the whole point), and we re-attach
  // on return via the ACTIVE_KEY. mountedRef stops a pending auto-reconnect from
  // firing after we've left.
  React.useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; esRef.current?.close(); }; }, []);

  // Track whether the user is at (near) the bottom of the feed. Pure scroll
  // bookkeeping — drives both the stick-to-bottom decision and the jump button.
  const onFeedScroll = React.useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    stickRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  const jumpToLatest = React.useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickRef.current = true;
    setShowJump(false);
  }, []);

  // Stick-to-bottom: only when the user is already pinned, and only the FEED
  // container scrolls — never the window (which is what made the whole page jump).
  // Instant, not smooth: smooth-scrolling on every streamed token is janky.
  React.useLayoutEffect(() => {
    if (!stickRef.current) return;
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const fetchHistory = React.useCallback(async (forDomain: string) => {
    try {
      const p = new URLSearchParams({ domain: forDomain });
      if (FACTORY_TOKEN) p.set("token", FACTORY_TOKEN);
      const r = await fetch(`/api/factory-v3/runs?${p.toString()}`);
      const j = await r.json();
      setHistory(Array.isArray(j.runs) ? j.runs : []);
    } catch { /* offline / table missing → leave list as-is */ }
  }, []);

  // Restore this domain's last transcript + refresh its history when the domain
  // changes (and on first mount). Skipped while streaming so we never clobber a
  // live run.
  React.useEffect(() => {
    if (streaming) return;
    setViewingRunId(null);
    stickRef.current = true; setShowJump(false); // show latest after a domain switch
    // If a run is still live in the background for this domain (we navigated away
    // mid-run, or just switched back), RE-ATTACH to it instead of showing a stale
    // transcript — the task kept running while we were gone.
    const activeId = (() => { try { return localStorage.getItem(ACTIVE_KEY(domain)); } catch { return null; } })();
    if (activeId) { reconnect(activeId); fetchHistory(domain); return; }
    try {
      const raw = localStorage.getItem(LS_KEY(domain));
      if (raw) { const o = JSON.parse(raw); setEvents(Array.isArray(o.events) ? o.events : []); if (typeof o.goal === "string" && o.goal) setGoal(o.goal); }
      else setEvents([]);
    } catch { setEvents([]); }
    fetchHistory(domain);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  // Persist the transcript to localStorage (throttled during streaming) so a
  // refresh mid- or post-run restores it. Not while viewing a past run.
  React.useEffect(() => {
    if (viewingRunId || !events.length) return;
    const now = Date.now();
    if (streaming && now - lastSaveRef.current < 1500) return;
    lastSaveRef.current = now;
    try { localStorage.setItem(LS_KEY(domain), JSON.stringify({ events: events.slice(-4000), goal, savedAt: now })); } catch { /* quota */ }
  }, [events, streaming, viewingRunId, domain, goal]);

  // shared SSE wiring for a fresh run, a conversation continuation, OR a reconnect.
  // When `attaching` is true the stream is replaying a background run (the events
  // are already in the buffer), so a transient drop auto-reconnects via ?runId=.
  function attachStream(es: EventSource, attaching = false) {
    esRef.current = es;
    es.onmessage = (m) => {
      let e: BrainEvent | { t: "run.started"; runId: string };
      try { e = JSON.parse(m.data); } catch { return; }
      // capture the run id → it's the HITL inject target, the conversation key for
      // the next message, AND the background-run handle to re-attach to on return.
      if ((e as { t: string }).t === "run.started") {
        const id = (e as { runId: string }).runId;
        // liveRunId = THIS turn's run (inject/stop/reconnect handle); convId = the STABLE
        // conversation key (same across every turn), so a follow-up resumes the context
        // instead of colliding with the prior run's id. They diverge after turn 1.
        const cid = (e as { conversationId?: string }).conversationId ?? id;
        setLiveRunId(id); setConvId(cid);
        try { localStorage.setItem(ACTIVE_KEY(domain), id); } catch { /* quota */ }
        return;
      }
      setEvents((prev) => [...prev, e as BrainEvent]);
      if ((e as BrainEvent).t === "done") {
        doneRef.current = true; es.close(); setStreaming(false); setLiveRunId(null);
        try { localStorage.removeItem(ACTIVE_KEY(domain)); } catch { /* */ }
        fetchHistory(domain);
      }
    };
    es.onerror = () => {
      es.close();
      // The background run keeps going server-side; a dropped SSE just needs a
      // re-attach. If we know the run id, transparently reconnect via ?runId=.
      const activeId = (() => { try { return localStorage.getItem(ACTIVE_KEY(domain)); } catch { return null; } })();
      if (!doneRef.current && activeId) { setTimeout(() => { if (!doneRef.current && mountedRef.current) reconnect(activeId); }, 1500); return; }
      if (!doneRef.current) setEvents((p2) => [...p2, { t: "error", message: "流式连接中断" }]);
      setStreaming(false); setLiveRunId(null); fetchHistory(domain);
    };
    void attaching;
  }

  // Re-attach to a background run that's (still) running — or replay it if it has
  // since finished. Used on page return / domain switch / transient SSE drop.
  function reconnect(runId: string) {
    if (streaming && esRef.current) esRef.current.close();
    doneRef.current = false;
    setConvId(runId); setLiveRunId(runId);
    setEvents([]); // the attach replays the full buffer, so start clean
    setStreaming(true);
    stickRef.current = true; setShowJump(false);
    const p = new URLSearchParams({ domain, runId });
    if (FACTORY_TOKEN) p.set("token", FACTORY_TOKEN);
    attachStream(new EventSource(`/api/factory-v3/brain/stream?${p.toString()}`), true);
  }

  // Feature 3: STOP the live run. Aborts the background driver; the brain breaks at
  // its next step, runs cleanup, and finalizes as aborted. For an ORPHANED run (server
  // restarted → no live driver, row stuck 'running') /stop flips the durable row. We
  // optimistically clear the UI either way so "停止" actually feels stopped.
  async function stopRun() {
    const id = liveRunId ?? convId;
    if (!id) return;
    try {
      await fetch(`/api/factory-v3/brain/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: id }) });
    } catch { /* best-effort */ }
    // Optimistic clear: don't wait for a `done` that may never arrive for an orphan.
    doneRef.current = true;
    try { esRef.current?.close(); } catch { /* */ }
    setStreaming(false); setLiveRunId(null);
    try { localStorage.removeItem(ACTIVE_KEY(domain)); } catch { /* */ }
    setEvents((prev) => [...prev, { t: "message", text: "⏹ 已停止本次运行。已生成的内容保留；你可以继续对话或开新会话。" } as BrainEvent]);
    fetchHistory(domain);
  }

  // Feature 2: the user's decision on the proposed test cases (执行 / 重新生成). Posts
  // through the HITL mailbox; the parked conductor picks it up and proceeds.
  async function decideTestCases(decision: "approve" | "regenerate", note?: string) {
    const id = liveRunId ?? convId;
    if (!id) return;
    const text = decision === "approve" ? "[测试用例决策:执行]" : `[测试用例决策:重新生成] ${note ?? ""}`.trim();
    try {
      await fetch(`/api/factory-v3/brain/inject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: id, text }) });
    } catch { /* best-effort */ }
  }

  // Boundary events: the user's per-event classification (external / terminal / break)
  // + external contracts. Posts through the HITL mailbox; the parked conductor applies it.
  async function decideBoundary(events: BoundaryEvent[]) {
    const id = liveRunId ?? convId;
    if (!id) return;
    const text = `[边界事件决策] ${JSON.stringify(events)}`;
    try {
      await fetch(`/api/factory-v3/brain/inject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: id, text }) });
    } catch { /* best-effort */ }
  }

  // Fresh run — a NEW conversation (clears the transcript + ctx). Use 重新开始 to
  // deliberately abandon the current conversation and regenerate from scratch.
  function start() {
    if (streaming || !goal.trim()) return; // require a real goal — no empty/default-generation submit
    esRef.current?.close();
    doneRef.current = false;
    setViewingRunId(null); setConvId(null);
    setEvents([]); setStreaming(true);
    stickRef.current = true; setShowJump(false); // pin to bottom for the new run
    const p = new URLSearchParams({ domain, goal });
    if (FACTORY_TOKEN) p.set("token", FACTORY_TOKEN);
    attachStream(new EventSource(`/api/factory-v3/brain/stream?${p.toString()}`));
  }

  // CHATBOT: continue the SAME conversation — the brain keeps its ontology/specs/
  // plan and responds to this follow-up in context (answer a question, tweak one
  // agent, finish the rest) instead of re-running the whole pipeline.
  function continueConversation(text: string) {
    if (streaming || !convId || !text.trim()) return;
    esRef.current?.close();
    doneRef.current = false;
    setStreaming(true);
    stickRef.current = true; setShowJump(false);
    setEvents((prev) => [...prev, { t: "message", text: `🧑 ${text.trim()}` } as BrainEvent]); // user turn bubble
    const p = new URLSearchParams({ domain, goal: text.trim(), convId });
    if (FACTORY_TOKEN) p.set("token", FACTORY_TOKEN);
    attachStream(new EventSource(`/api/factory-v3/brain/stream?${p.toString()}`));
    setFollowup("");
  }

  // RANK-5 (HITL): inject a steering message into the LIVE brain run. It consumes
  // it at the next turn boundary and is free to analyze / re-plan / verify with
  // tools — steering, not a hard command.
  async function sendInject(text: string) {
    if (!text.trim() || !liveRunId) return;
    try {
      await fetch(`/api/factory-v3/brain/inject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: liveRunId, text }),
      });
    } catch { /* best-effort — the run keeps going */ }
  }
  async function inject() { const t = injectText.trim(); if (!t) return; setInjectText(""); await sendInject(t); }

  // F1: per-agent card action → structured steering message the live brain acts on.
  function cardAct(a: Extract<Block, { kind: "agent" }>, action: "accept" | "regen", hint?: string) {
    const who = `agent「${a.spec.short}」(${a.spec.nameZh})`;
    const text = action === "accept"
      ? `[卡片操作] 我采纳了 ${who} —— 它的设计/代码我认可,保留它,继续推进其它的。`
      : `[卡片操作] 请只对 ${who} 重新设计(refine_agent / 必要时重新 codegen_agent)${hint ? `,要求:${hint}` : ""}。只改这一个,别动其它已采纳的;改完重新沙箱验证。`;
    void sendInject(text);
  }

  // Load a past run read-only (Fix #3 — reopen after refresh / from another day).
  async function openRun(id: string) {
    if (streaming) return;
    try {
      const p = new URLSearchParams();
      if (FACTORY_TOKEN) p.set("token", FACTORY_TOKEN);
      const r = await fetch(`/api/factory-v3/runs/${id}?${p.toString()}`);
      const j = await r.json();
      if (j.run) { setEvents(Array.isArray(j.run.transcript) ? j.run.transcript : []); if (j.run.goal) setGoal(j.run.goal); setViewingRunId(id); setAnalysis(null); stickRef.current = true; setShowJump(false); }
    } catch { /* ignore */ }
  }

  // #6: AI review of the current / viewed run — POST its saved transcript to the analyzer, which
  // scores it 0–100 + surfaces problems / suggestions, so the user can see what went wrong each run.
  async function analyzeRunUi() {
    const id = viewingRunId ?? liveRunId ?? convId;
    if (!id || analyzing) return;
    setAnalyzing(true); setAnalysis(null);
    try {
      const p = new URLSearchParams(); if (FACTORY_TOKEN) p.set("token", FACTORY_TOKEN);
      const r = await fetch(`/api/factory-v3/runs/${id}/analyze?${p.toString()}`, { method: "POST" });
      const j = await r.json();
      setAnalysis(j.review ?? { error: j.error ?? "分析失败" });
    } catch (e) { setAnalysis({ error: (e as Error).message }); }
    finally { setAnalyzing(false); }
  }

  // Start a fresh session in the CURRENT domain: drop the restored transcript +
  // history view so the user can give a new goal from a clean slate. Doesn't
  // touch persisted past runs (those stay in 历史运行) — only clears the live cache.
  function newSession() {
    if (streaming) return;
    esRef.current?.close();
    setViewingRunId(null);
    setEvents([]);
    setAnalysis(null);
    try { localStorage.removeItem(LS_KEY(domain)); localStorage.removeItem(ACTIVE_KEY(domain)); } catch { /* ignore */ }
  }

  // Leave the read-only past-run view and restore the live cache for this domain.
  function exitViewing() {
    setViewingRunId(null);
    try {
      const raw = localStorage.getItem(LS_KEY(domain));
      setEvents(raw ? (JSON.parse(raw).events ?? []) : []);
    } catch { setEvents([]); }
  }

  const blocks = toBlocks(events);
  // The center feed is the SIMPLE story: what the factory produced + its
  // narration (plan → agents → validation → sandbox → skills → messages). All
  // the internal reasoning (think tokens, every tool call/result, inspect,
  // refine, sandbox progress, web) lives in the 轨迹 (trace) tab instead, so the
  // main view reads like a clean chat, not a firehose.
  const FEED_KINDS = new Set(["message", "agent", "validation", "sandbox", "plan", "skill", "subagent", "error", "testcases", "boundarycases", "boundarydecided", "compaction", "askuser"]);
  const feedBlocks = blocks.filter((b) => FEED_KINDS.has(b.kind));
  // A single live-activity line so the feed shows momentum during the long
  // design phase without dumping raw reasoning into it.
  const liveActivity = (() => {
    if (!streaming) return null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === "think" && (b as Extract<Block, { kind: "think" }>).text) return "💭 " + (b as Extract<Block, { kind: "think" }>).text.replace(/\s+/g, " ").slice(-90);
      if (b.kind === "tool") return "🔧 " + (TOOL_LABEL[(b as Extract<Block, { kind: "tool" }>).name] ?? (b as Extract<Block, { kind: "tool" }>).name) + ((b as Extract<Block, { kind: "tool" }>).result ? " ✓" : " …");
    }
    return "思考中…";
  })();
  // Dedupe agents by slug — the brain may re-run generate_agents (after creating
  // skills/tools), so keep the latest card per agent (and avoid duplicate keys).
  const agentMap = new Map<string, Extract<Block, { kind: "agent" }>>();
  for (const b of blocks) if (b.kind === "agent") agentMap.set(b.spec.slug, b);
  const agents = [...agentMap.values()];
  // The domain's tool library (latest catalog emitted by read_ontology).
  const catalog = events.reduce<ToolCardLite[]>((acc, e) => (e.t === "catalog" ? e.tools : acc), []);
  // tool id → business title, so agent cards show "下载简历原件" not "minio.getResume".
  const toolTitle = Object.fromEntries(catalog.map((c) => [c.name, c.title]));
  const toolCalls = events.filter((e): e is Extract<BrainEvent, { t: "tool.call" }> => e.t === "tool.call");
  const toolCounts = new Map<string, number>();
  for (const tc of toolCalls) toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1);
  const validation = [...blocks].reverse().find((b) => b.kind === "validation") as Extract<Block, { kind: "validation" }> | undefined;
  const sandbox = [...blocks].reverse().find((b) => b.kind === "sandbox") as Extract<Block, { kind: "sandbox" }> | undefined;
  // P2 observability: per-slot live status from the latest sandbox run, so each agent
  // card shows whether it ran / degraded / never fired — the "see it to fix it" matrix.
  const slotStatusFor = (slug: string, short: string): "ran" | "degraded" | "missed" | "draft" => {
    if (!sandbox) return "draft";
    const hit = (list?: string[]) => (list ?? []).some((x) => x === short || x === slug || slug.includes(x) || x.includes(slug));
    if (hit(sandbox.degradedAgents)) return "degraded";
    if (hit(sandbox.missedAgents)) return "missed";
    if (hit(sandbox.agents)) return "ran";
    return "draft";
  };
  const tokens = events.reduce((n, e) => (e.t === "done" ? e.tokensUsed : n), 0);
  const turns = events.reduce((n, e) => (e.t === "done" ? e.turns : n), 0);
  // Knowledge ledger derivations (R2-7): plans across versions, refine
  // timeline, reflections written, latest budget snapshot.
  const plans = blocks.filter((b) => b.kind === "plan") as Array<Extract<Block, { kind: "plan" }>>;
  const refines = blocks.filter((b) => b.kind === "refine") as Array<Extract<Block, { kind: "refine" }>>;
  const reflects = blocks.filter((b) => b.kind === "reflect") as Array<Extract<Block, { kind: "reflect" }>>;
  const lastBudget = events.reduce<{ turn: number; maxTurns: number; tokens: number; maxTokens: number | null; specsBuilt: number; sandboxRuns?: number; level?: "ok" | "elevated" | "high"; costNote?: string } | null>((acc, e) => (e.t === "budget" ? { turn: e.turn, maxTurns: e.maxTurns, tokens: e.tokens, maxTokens: e.maxTokens, specsBuilt: e.specsBuilt, sandboxRuns: e.sandboxRuns, level: e.level, costNote: e.costNote } : acc), null);

  return (
    <div className="fv3-root">
      <style>{FV3_CSS}</style>

      <aside className="fv3-left">
        <div className="fv3-brand"><span className="fv3-logo">AO</span><div><b>智能体工厂</b><small>自动生成 · 验证 · 部署</small></div></div>
        <div className="fv3-grp">业务域</div>
        {DOMAINS.map((d) => (
          <button key={d.id} className={`fv3-sess ${domain === d.id ? "on" : ""}`} onClick={() => setDomain(d.id)} disabled={streaming}>
            {d.label}<span className="fv3-domtag">{d.tag}</span>
          </button>
        ))}
        <div className="fv3-grp">本次运行</div>
        <div className="fv3-step"><span className="fv3-mini">{turns ? `${turns} 轮 · ${(tokens / 1000).toFixed(1)}k tok` : streaming ? "推理中…" : "就绪"}</span></div>
        <button className="fv3-newsess" onClick={newSession} disabled={streaming} title="清空当前对话，在本业务域开一个全新会话（历史运行仍保留）">＋ 开新会话</button>
        <div className="fv3-grp">历史运行（{history.length}）</div>
        {history.length === 0 && <div className="fv3-empty">暂无历史运行</div>}
        {history.map((h) => (
          <button
            key={h.id}
            className={`fv3-hist ${viewingRunId === h.id ? "on" : ""}`}
            onClick={() => openRun(h.id)}
            disabled={streaming}
            title={h.goal}
          >
            <span className={`fv3-histdot ${h.reachedTerminal ? "ok" : h.status === "error" ? "err" : h.status === "running" ? "run" : "warn"}`} />
            <span className="fv3-histmeta">
              {h.agentsCount} agent · {h.turns}轮 · {(h.tokensUsed / 1000).toFixed(0)}k
              <small>{new Date(h.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}{h.reachedTerminal ? " · 跑通" : h.status === "running" ? " · 运行中" : h.status === "error" ? " · 出错" : ""}</small>
            </span>
          </button>
        ))}
        <div className="fv3-grp">生成的智能体（{agents.length}）</div>
        {agents.length === 0 && <div className="fv3-empty">生成的智能体会出现在这里</div>}
        {agents.map((a) => (
          <div key={a.spec.slug} className="fv3-draft"><span className="fv3-draftname">{a.spec.nameZh}</span><span className="fv3-badge draft">DRAFT</span></div>
        ))}
      </aside>

      <main className="fv3-center">
        <div className="fv3-head">
          <span className="fv3-crumb">自主大脑 · {DOMAINS.find((d) => d.id === domain)?.label}</span>
          {viewingRunId
            ? <span className="fv3-chip viewing">👁 查看历史运行（只读）<button className="fv3-exitview" onClick={exitViewing}>返回</button></span>
            : streaming
              ? <span className="fv3-chip live"><span className="fv3-livedot" />推理中</span>
              : <span className="fv3-chip">{sandbox?.reachedTerminal ? "✓ 跑通到终态" : tokens ? "完成" : "就绪"}</span>}
        </div>

        <div className="fv3-feed" ref={feedRef} onScroll={onFeedScroll}>
          {events.length === 0 && !streaming && !viewingRunId ? (
            <div className="fv3-hero">
              <div className="fv3-herologo">⚡</div>
              <h2 className="fv3-herotitle">自主智能体工厂</h2>
              <p className="fv3-herosub">给一个目标，大脑会自己<strong>读取本体 → 规划 → 设计 → 校验 → 沙箱验证</strong>，全程把推理和每一步操作展示给你看。</p>
              <div className="fv3-pipeline">
                {PIPELINE_STEPS.map((s, i) => (
                  <React.Fragment key={s}>
                    <span className="fv3-pipestep">{s}</span>
                    {i < PIPELINE_STEPS.length - 1 && <span className="fv3-pipearrow">→</span>}
                  </React.Fragment>
                ))}
              </div>
              <div className="fv3-egwrap2">
                <div className="fv3-eglabel2">试试这些目标</div>
                {EXAMPLE_GOALS.map((g) => (
                  <button key={g} className="fv3-egchip" onClick={() => setGoal(g)} title="点一下填入输入框">{g}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="fv3-userbubble">{goal}</div>
          )}
          {feedBlocks.map((b, i) => <div className="fv3-block" key={i}><BlockView b={b} streaming={false} onTestDecision={decideTestCases} onBoundaryDecision={decideBoundary} onAnswer={(ans) => sendInject(ans)} /></div>)}
          {liveActivity && <div className="fv3-activity">{liveActivity}<span className="fv3-cursor">▍</span></div>}
          {!streaming && events.length > 0 && <div className="fv3-feedhint">完整推理与每一步工具调用在右侧「轨迹」里。</div>}
          {/* #6: AI run review — score + problems + suggestions for the finished/viewed run. */}
          {!streaming && events.length > 0 && (
            (!analysis || (analysis as { error?: unknown }).error) ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
                <button className="fv3-btn" onClick={analyzeRunUi} disabled={analyzing} style={{ fontSize: 12, padding: "5px 12px" }}>{analyzing ? "评审中…" : "🔎 AI 评审本次运行"}</button>
                {!!(analysis as { error?: unknown })?.error && <span style={{ color: "var(--c-warn,#f5b556)", fontSize: 12 }}>{String((analysis as { error?: unknown }).error)}</span>}
              </div>
            ) : (
              <RunReviewPanel a={analysis} onRedo={analyzeRunUi} analyzing={analyzing} />
            )
          )}
        </div>

        {showJump && (
          <button className="fv3-jump" onClick={jumpToLatest} title="跳到最新">
            ↓ 最新{streaming ? " · 生成中" : ""}
          </button>
        )}

        {streaming && (
          <div className="fv3-bgbar">
            <span className="fv3-bgrun"><span className="fv3-livedot" />后台运行中 · 切到别的页面也会继续跑，回来自动接上</span>
            <button className="fv3-stop" onClick={stopRun} title="停止这个任务（已生成的内容会保留）">{Ic.stop({ width: 13, height: 13 })} 停止任务</button>
          </div>
        )}
        <div className="fv3-composer">
          {streaming && liveRunId ? (
            // RANK-5 (HITL): the brain is running — let the user steer it live. The
            // message lands at the next turn boundary; the brain is free to analyze
            // / re-plan / verify it with tools (steering, not a hard command).
            <>
              <input className="fv3-input" value={injectText} onChange={(e) => setInjectText(e.target.value)} placeholder="运行中——随时打字介入：纠偏 / 提要求 / 给提示，大脑下一步会纳入分析…" onKeyDown={(e) => { if (e.key === "Enter") inject(); }} autoFocus />
              <button className="fv3-run" onClick={inject} disabled={!injectText.trim()} title="把消息发给正在运行的大脑">介入 ↵</button>
            </>
          ) : convId && !viewingRunId ? (
            // CHATBOT: a conversation exists — keep talking. The brain continues with
            // its ontology/specs/plan in context (answer / tweak one agent / finish
            // the rest), it does NOT restart the pipeline. 重新开始 to start fresh.
            <>
              <input className="fv3-input" value={followup} onChange={(e) => setFollowup(e.target.value)} placeholder="继续对话：追问「为什么给它选这个工具」/「把 X 的容错加强」/「把剩下的造完」…" onKeyDown={(e) => { if (e.key === "Enter") continueConversation(followup); }} autoFocus />
              <button className="fv3-regen" onClick={start} title="抛开当前对话，从零重新生成">重新开始</button>
              <button className="fv3-run" onClick={() => continueConversation(followup)} disabled={!followup.trim()} title="继续这场对话（大脑保留上下文，不重跑流水线）">发送 ↵</button>
            </>
          ) : (
            <>
              <input className="fv3-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="给大脑一个目标…" disabled={streaming} onKeyDown={(e) => { if (e.key === "Enter") start(); }} />
              <button className="fv3-run" disabled={streaming || !goal.trim()} onClick={start}>{streaming ? "运行中…" : viewingRunId ? "新运行" : "开始"}</button>
            </>
          )}
        </div>
      </main>

      <aside className="fv3-right">
        <div className="fv3-tabs">
          {(["agents", "eventgraph", "harness", "trace", "knowledge", "eval"] as RightTab[]).map((t) => (
            <button key={t} className={`fv3-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t === "agents" ? "智能体" : t === "eventgraph" ? "事件图" : t === "harness" ? "大脑" : t === "trace" ? "轨迹" : t === "knowledge" ? "过程" : "验证"}</button>
          ))}
        </div>
        <div className="fv3-tabbody">
          {tab === "agents" && (
            <>
              <div className="fv3-ititle">生成的智能体（{agents.length}）{streaming && <span className="fv3-live">● live</span>}</div>
              {agents.length === 0 && <div className="fv3-empty">运行后这里逐个列出智能体，点开可看它的指令和代码。</div>}
              {agents.map((a) => <AgentDetailCard key={a.spec.slug} a={a} status={slotStatusFor(a.spec.slug, a.spec.short)} canAct={streaming && !!liveRunId} onAct={(action, hint) => cardAct(a, action, hint)} onFull={setFull} toolTitle={toolTitle} />)}
              {catalog.length > 0 && (
                <details className="fv3-acc">
                  <summary>工具明细（已调用 {toolCalls.length} · 工具库 {catalog.length}）<button className="fv3-fullbtn sm" style={{ marginLeft: 8 }} title="全屏看工具库" onClick={(e) => { e.preventDefault(); setFull({ title: `工具库（${catalog.length}）`, body: <ToolsFull catalog={catalog} /> }); }}>⛶ 全屏</button></summary>
                  <div className="fv3-accbody">
                    {[...toolCounts.keys()].map((n) => (
                      <div key={n} className="fv3-agentrow"><span className="fv3-dot ok" /><span className="fv3-agnm">{TOOL_LABEL[n] ?? n}</span><span className="fv3-agms">{toolCounts.get(n) || ""}</span></div>
                    ))}
                    <div className="fv3-sub" style={{ margin: "8px 0 4px" }}>可绑定工具库</div>
                    {catalog.map((t) => (
                      <div key={t.name} className="fv3-toolrow" title={t.signature}>
                        <span className={`fv3-se ${t.sideEffect}`}>{t.sideEffect === "read" ? "读" : t.sideEffect === "write" ? "写" : "双写"}</span>
                        <span className="fv3-toolnm">{t.title}</span>
                        <span className="fv3-toolid">{t.name}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
          {tab === "eventgraph" && (
            <>
              <div className="fv3-fullbar"><button className="fv3-fullbtn" title="全屏查看事件流程图" onClick={() => setFull({ title: "事件流程图", body: <EventGraph events={events} streaming={streaming} slotStatusFor={slotStatusFor} validation={validation} full /> })}>⛶ 全屏</button></div>
              <EventGraph events={events} streaming={streaming} slotStatusFor={slotStatusFor} validation={validation} />
            </>
          )}
          {tab === "harness" && (
            <>
              <div className="fv3-fullbar"><button className="fv3-fullbtn" title="全屏查看幕后大脑树" onClick={() => setFull({ title: "幕后大脑（造智能体的过程 · 非交付物）", body: <HarnessView goal={goal} domain={domain} blocks={blocks} toolCounts={toolCounts} agentsBuilt={agents.length} lastBudget={lastBudget} streaming={streaming} /> })}>⛶ 全屏</button></div>
              <HarnessView goal={goal} domain={domain} blocks={blocks} toolCounts={toolCounts} agentsBuilt={agents.length} lastBudget={lastBudget} streaming={streaming} />
            </>
          )}
          {tab === "trace" && (
            <>
              {events.length === 0 && <div className="fv3-empty">运行后这里按时间线逐条显示推理与每一步操作。</div>}
              <div className="fv3-timeline">
                {blocks.filter((b) => b.kind !== "think" || (b as any).text).map((b, i) => {
                  const dot = b.kind === "tool" ? (b.result?.ok === false ? "err" : "tool") : b.kind === "agent" ? "agent" : b.kind === "validation" ? (b.ok ? "ok" : "warn") : b.kind === "sandbox" ? (b.reachedTerminal ? "ok" : "warn") : "think";
                  return (
                    <div key={i} className={`fv3-tlrow d-${dot}`}>
                      {b.kind === "think" && <div className="fv3-tracethink">💭 {(b as Extract<Block, { kind: "think" }>).text}</div>}
                      {b.kind === "tool" && <div className="fv3-tracetool"><span className={`fv3-pill t-${b.name}`}>{TOOL_LABEL[b.name] ?? b.name}</span> {b.result ? (b.result.ok ? "✓ " : "✗ ") + b.result.summary : "…"}</div>}
                      {b.kind === "agent" && <div className="fv3-traceagent">🤖 生成智能体「{b.spec.nameZh}」</div>}
                      {b.kind === "validation" && <div className={`fv3-traceval ${b.ok ? "ok" : "warn"}`}>{b.ok ? "✓ 事件图闭合" : "⚠ " + (b.issues[0] ?? "")}</div>}
                      {b.kind === "sandbox" && <div className={`fv3-traceval ${b.reachedTerminal ? "ok" : "warn"}`}>⚙ 真实运行 {b.ran} 个智能体 · {b.reachedTerminal ? "到达终态" : "未到终态"}</div>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {tab === "knowledge" && (
            <>
              <div className="fv3-ititle">成本计量{streaming && <span className="fv3-live">● live</span>}{lastBudget?.level && lastBudget.level !== "ok" && <span className={`fv3-costchip ${lastBudget.level}`}>{lastBudget.level === "high" ? "成本偏高" : "成本中高"}</span>}</div>
              {lastBudget ? (
                <div className="fv3-budgetbar">
                  <div className="fv3-budgetrow"><span>Turn</span><span className="mono">{lastBudget.turn}/{lastBudget.maxTurns}</span></div>
                  <div className="fv3-bar"><span className="fv3-bar-fg" style={{ width: `${Math.min(100, (lastBudget.turn / lastBudget.maxTurns) * 100)}%` }} /></div>
                  <div className="fv3-budgetrow"><span>Tokens</span><span className="mono">{Math.round(lastBudget.tokens / 1000)}k{lastBudget.maxTokens == null ? "(无上限)" : ` / ${Math.round(lastBudget.maxTokens / 1000)}k`}</span></div>
                  <div className="fv3-bar"><span className={`fv3-bar-fg ${lastBudget.level ?? "ok"}`} style={{ width: `${lastBudget.maxTokens == null ? Math.min(100, (lastBudget.tokens / 4_000_000) * 100) : Math.min(100, (lastBudget.tokens / lastBudget.maxTokens) * 100)}%` }} /></div>
                  <div className="fv3-budgetrow"><span>沙箱试运行</span><span className="mono">{lastBudget.sandboxRuns ?? 0} 次</span></div>
                  {lastBudget.costNote && <div className="fv3-costnote">{lastBudget.costNote}</div>}
                  <div className="fv3-sub" style={{ marginTop: 6 }}>软阈值,只提示不拦截(可调 FACTORY_COST_*_TOKENS)</div>
                </div>
              ) : <div className="fv3-empty">运行后显示成本计量。</div>}

              <div className="fv3-ititle" style={{ marginTop: 14 }}>构建计划（{plans.length}）</div>
              {plans.length === 0 && <div className="fv3-empty">运行后显示计划版本。</div>}
              {plans.map((p, i) => (
                <div key={i} className="fv3-kledger">
                  <div className="fv3-klhead">📋 <b>v{p.version}</b> <span className="fv3-klmeta">{p.agentCount} 个 agent</span></div>
                  <div className="fv3-klbody">{p.summary}</div>
                </div>
              ))}

              <div className="fv3-ititle" style={{ marginTop: 14 }}>修订记录（{refines.length}）</div>
              {refines.length === 0 && <div className="fv3-empty">运行后显示修订轨迹。</div>}
              {refines.map((r, i) => (
                <div key={i} className="fv3-kledger">
                  <div className="fv3-klhead">🔁 <b>{r.actionName}</b> · #{r.attemptNumber}</div>
                  <div className="fv3-klbody">{r.critique}</div>
                  {r.diff && (
                    <div className="fv3-kldiff">
                      {r.diff.systemPromptChanged && <span className="fv3-dchip">prompt ✎</span>}
                      {r.diff.decisionLogicChanged && <span className="fv3-dchip">决策逻辑 ✎</span>}
                      {r.diff.toolsAdded.map((t) => <span key={"a" + t} className="fv3-dchip add">+{t}</span>)}
                      {r.diff.toolsRemoved.map((t) => <span key={"r" + t} className="fv3-dchip rem">−{t}</span>)}
                    </div>
                  )}
                </div>
              ))}

              <div className="fv3-ititle" style={{ marginTop: 14 }}>学到的经验（{reflects.length}）<span className="fv3-sub">下次自动复用</span></div>
              {reflects.length === 0 && <div className="fv3-empty">运行结束会留下经验，下次自动复用。</div>}
              {reflects.map((rf, i) => (
                <div key={i} className="fv3-kledger">
                  <div className="fv3-klhead">💡 <span className={`fv3-rkind ${rf.kind2}`}>{rf.kind2}</span></div>
                  <div className="fv3-klbody">{rf.lesson}</div>
                </div>
              ))}
            </>
          )}
          {tab === "eval" && (() => {
            // P2 fix: expected coverage is DERIVED — the latest plan's agent count
            // (the brain's decomposition of the ontology), not a hardcoded 6. The
            // "ran" checks use the real behavioral signals (deployed / fullChainRan).
            const expected = plans.length ? plans[plans.length - 1].agentCount : agents.length;
            const deployed = sandbox?.deployed ?? sandbox?.ran ?? 0;
            const structIssues = validation?.issues.filter((s) => /悬空|孤儿|缺少|幻觉|无工具/.test(s)) ?? [];
            const payloadIssues = validation?.issues.filter((s) => /字段缺口|字段未约定/.test(s)) ?? [];
            const degraded = sandbox?.degradedAgents ?? [];
            const missed = sandbox?.missedAgents ?? [];
            return (
            <>
              {/* Feature 2: the use cases that were fired + each agent's REAL input→
                  tools→output — the proof the sandbox genuinely ran, not just counts. */}
              <SandboxIOPanel sandbox={sandbox} domain={domain} />
              <div className="fv3-ititle" style={{ marginTop: 14 }}>真实验证清单</div>
              <EvalLine ok={expected > 0 && agents.length >= expected} label={`智能体覆盖（${agents.length}/${expected || "?"}，按本体动作）`} />
              <EvalLine ok={validation ? structIssues.length === 0 : undefined} label="事件图结构闭合（每个事件有上下游）" detail={structIssues.length ? structIssues.slice(0, 2).join("；") : undefined} />
              <EvalLine ok={validation ? payloadIssues.length === 0 : undefined} label="字段合同闭合（下游要的字段上游都产出）" detail={payloadIssues.length ? payloadIssues.slice(0, 2).join("；") : undefined} />
              <EvalLine ok={!!sandbox && (sandbox.ran ?? 0) > 0} label={`部署上线并真实运行（${sandbox?.ran ?? 0}${deployed ? `/${deployed}` : ""} 个智能体）`} />
              <EvalLine ok={sandbox ? sandbox.reachedSuccessTerminal : undefined} label="跑到成功终态（不是失败分支）" detail={sandbox && sandbox.reachedSuccessTerminal === false ? "只到了失败分支终态——正常通过的主路径没跑通(检查喂进去的入口数据)" : undefined} />
              <EvalLine ok={sandbox?.fullChainRan} label="全链路端到端跑通（全触发 · 无降级）" detail={sandbox && !sandbox.fullChainRan && (degraded.length || missed.length) ? `${missed.length ? `未触发：${missed.join("、")}` : ""}${missed.length && degraded.length ? " · " : ""}${degraded.length ? `降级兜底：${degraded.join("、")}` : ""}` : undefined} />
              <EvalLine ok={sandbox?.caseResults?.length ? sandbox.caseResults.every((r) => r.ok) : undefined} label={`用例判断正确（${sandbox?.caseResults?.filter((r) => r.ok).length ?? 0}/${sandbox?.caseResults?.length ?? 0}）`} detail={sandbox?.caseResults?.some((r) => !r.ok) ? sandbox.caseResults.filter((r) => !r.ok).map((r) => `${r.name}：${r.detail}`).slice(0, 2).join("；") : undefined} />
              {sandbox && <div className="fv3-evalnote">真实运行的事件链（{sandbox.events.length} 个事件）：{sandbox.events.slice(0, 8).map((e) => e.replace(`${domain}/`, "")).join(" · ")}…</div>}
              <div className="fv3-evalnote">金标准对标(和 招聘-v1 真 agent 比签名/分支/工具相似度)在「多 Harness 编排」层(/api/harness · gold-standard)——要接进这里我可以加。</div>
            </>
            );
          })()}
        </div>
      </aside>
      {full && <FullModal title={full.title} onClose={() => setFull(null)}>{full.body}</FullModal>}
    </div>
  );
}

// Fullscreen overlay for any detailed view — graph, prompt, agent code, tools. Esc or
// the ✕ closes it. Used so the user can read long prompts / .ts / wide event graphs.
function FullModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  React.useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fv3-full" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="fv3-fullinner" onClick={(e) => e.stopPropagation()}>
        <div className="fv3-fullhead"><span className="fv3-fulltitle">{title}</span><button className="fv3-fullx" onClick={onClose} title="关闭(Esc)">✕</button></div>
        <div className="fv3-fullbody">{children}</div>
      </div>
    </div>
  );
}

// Live event-flow graph. Derives an event-driven DAG from the brain's stream:
// the latest create_plan (planned agents + their trigger/emit events) seeds it,
// then each agent.created upgrades a planned node to a built one with its REAL
// trigger/emit. Edges = a shared event (A emits e, B triggers on e → A→e→B). It
// re-renders on every new plan/agent event, so the graph builds + improves live.
// Dynamic event-flow graph — renders the generated agents (Inngest functions) the way
// the 招聘-v1 reference does: agents AND events are BOTH nodes, in a vertical chain
// (event → agent → event → agent …), with terminal/failure events as red nodes and a
// status tint per agent slot. Rebuilt live from agent.created / plan events.
function EventGraph({ events, streaming, slotStatusFor, validation, full }: { events: BrainEvent[]; streaming: boolean; slotStatusFor?: (slug: string, short: string) => "ran" | "degraded" | "missed" | "draft"; validation?: Extract<Block, { kind: "validation" }>; full?: boolean }) {
  type GN = { key: string; short: string; label: string; trigger: string[]; emit: string[]; built: boolean };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  let planAgents: Array<{ name: string; trigger: string[]; emit: string[] }> = [];
  for (const e of events) if (e.t === "plan") planAgents = e.plan.agents.map((a) => ({ name: a.actionName, trigger: a.triggerEvents || [], emit: a.emitEvents || [] }));
  const builtMap = new Map<string, GN>();
  for (const e of events) if (e.t === "agent.created") builtMap.set(e.spec.slug, { key: e.spec.slug, short: e.spec.short, label: e.spec.nameZh || e.spec.short, trigger: e.spec.trigger || [], emit: e.spec.emit || [], built: true });
  const agents = [...builtMap.values()];
  const builtKeys = agents.map((b) => norm(b.key));
  for (const p of planAgents) {
    const k = norm(p.name);
    if (!builtKeys.some((bk) => bk === k || bk.includes(k) || k.includes(bk))) agents.push({ key: "plan:" + p.name, short: p.name, label: p.name, trigger: p.trigger, emit: p.emit, built: false });
  }
  if (agents.length === 0) {
    return <div className="fv3-empty">大脑制定计划 / 生成智能体后，这里会<strong>实时画出事件流程图</strong>：事件触发哪个智能体、智能体又发出哪个事件、哪条是失败终态，随生成过程逐步成形。</div>;
  }

  const isFail = (ev: string) => /FAIL|REJECT|ERROR|CONFLICT|MISSING|DENIED/i.test(ev);
  const allEmits = new Set(agents.flatMap((n) => n.emit).filter(Boolean));
  const allTriggers = new Set(agents.flatMap((n) => n.trigger).filter(Boolean));
  const allEvents = [...new Set([...allEmits, ...allTriggers])].filter(Boolean);

  // Contract-closure overlay: validate_graph already computes the analysis's exact
  // invariant — 悬空 emit (produced, no consumer, not a real terminal) and per-agent
  // agentIssueMap (a broken trigger/emit contract). Surface it ON the graph so the
  // user sees where the AI's *designed* flow is unclosed (the AI then self-refines).
  const danglingEmits = new Set<string>();
  const payloadGapEvents = new Set<string>(); // contract layer: event whose payload a consumer needs but no producer provides
  for (const s of validation?.issues ?? []) {
    const m = s.match(/^悬空\s*emit[：:]\s*(.+)$/);
    if (m) for (const ev of m[1].split(/[、,，]/)) danglingEmits.add(ev.trim());
    const g = s.match(/^字段缺口：事件「(.+?)」/);
    if (g) payloadGapEvents.add(g[1].trim());
  }
  const issueAgentKeys = Object.keys(validation?.agentIssueMap ?? {}).map(norm);
  const hasIssue = (key: string, short: string) =>
    issueAgentKeys.some((k) => k === norm(key) || k === norm(short) || k.includes(norm(short)) || norm(short).includes(k));

  // combined node set: one per agent + one per event. THIS is what gives the detailed
  // look — events are first-class nodes, not edge labels.
  type Kind = "agent" | "event" | "entry" | "success" | "fail" | "orphan";
  type CN = { id: string; kind: Kind; label: string; sub?: string; built?: boolean; status?: string; issue?: boolean; gap?: boolean };
  const cnodes: CN[] = [];
  for (const a of agents) cnodes.push({ id: "a:" + a.key, kind: "agent", label: a.label, sub: a.short, built: a.built, status: a.built && slotStatusFor ? slotStatusFor(a.key, a.short) : undefined, issue: a.built && hasIssue(a.key, a.short) });
  for (const ev of allEvents) {
    const isEntry = !allEmits.has(ev);
    const isTerm = !allTriggers.has(ev);
    // orphan = validator flagged it as a 悬空 emit (no consumer AND not a known
    // terminal) → broken contract, not a legit leaf. success = a clean terminal
    // that isn't a failure. fail = failure branch/terminal. Distinguishing the
    // happy-path terminal from failure terminals = the analysis's "don't equate
    // terminal with success".
    const kind: Kind = danglingEmits.has(ev) ? "orphan" : isFail(ev) ? "fail" : isEntry ? "entry" : isTerm ? "success" : "event";
    cnodes.push({ id: "e:" + ev, kind, label: ev, gap: payloadGapEvents.has(ev) });
  }
  // edges: event → agent (it triggers on), agent → event (it emits)
  const cedges: Array<{ from: string; to: string }> = [];
  for (const a of agents) {
    for (const t of a.trigger) if (allEvents.includes(t)) cedges.push({ from: "e:" + t, to: "a:" + a.key });
    for (const m of a.emit) if (allEvents.includes(m)) cedges.push({ from: "a:" + a.key, to: "e:" + m });
  }
  // longest-path layering over the combined graph → vertical event/agent alternation
  const depth = new Map<string, number>(cnodes.map((n) => [n.id, 0]));
  for (let it = 0; it <= cnodes.length * 2; it++) for (const e of cedges) { const d = (depth.get(e.from) || 0) + 1; if (d > (depth.get(e.to) || 0)) depth.set(e.to, d); }
  const layers = new Map<number, CN[]>();
  for (const n of cnodes) { const d = depth.get(n.id) || 0; if (!layers.has(d)) layers.set(d, []); layers.get(d)!.push(n); }
  // Crossing reduction: order each layer by the BARYCENTER (avg horizontal
  // position of its predecessors) so an edge runs roughly straight down instead of
  // diagonally across the graph. Failure/orphan nodes still bias to the right edge
  // so the happy path reads down the center. Cuts the edge tangle the user flagged.
  const normX = new Map<string, number>();
  const sortedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0]);
  for (const [d, layer] of sortedLayers) {
    if (d > 0) {
      const bary = (n: CN) => {
        const preds = cedges.filter((e) => e.to === n.id).map((e) => normX.get(e.from)).filter((x): x is number => x != null);
        return preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : 0.5;
      };
      layer.sort((a, b) => {
        const fa = a.kind === "fail" || a.kind === "orphan" ? 1 : 0;
        const fb = b.kind === "fail" || b.kind === "orphan" ? 1 : 0;
        return fa !== fb ? fa - fb : bary(a) - bary(b);
      });
    } else {
      layer.sort((a, b) => (a.kind === "fail" || a.kind === "orphan" ? 1 : 0) - (b.kind === "fail" || b.kind === "orphan" ? 1 : 0));
    }
    layer.forEach((n, i) => normX.set(n.id, (i + 0.5) / layer.length));
  }
  const maxLayer = Math.max(...layers.keys());
  const maxPer = Math.max(...[...layers.values()].map((l) => l.length));

  const AW = 168, AH = 50, EW = 200, EH = 30, ROWH = 84, COLW = 238, PADTOP = 20, PADBOT = 20, PADX = 16;
  const W = Math.max(360, maxPer * COLW + PADX * 2);
  const H = PADTOP + (maxLayer + 1) * ROWH + PADBOT;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, layer] of layers) layer.forEach((n, i) => pos.set(n.id, { x: PADX + ((i + 0.5) / layer.length) * (W - PADX * 2), y: PADTOP + d * ROWH + AH / 2 }));
  const curve = (x1: number, y1: number, x2: number, y2: number) => `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
  const statusColor = (s?: string) => s === "ran" ? "var(--c-ok)" : s === "degraded" || s === "missed" ? "var(--c-warn, #f5b556)" : undefined;

  return (
    <div className={`fv3-egwrap ${full ? "full" : ""}`}>
      {!full && <div className="fv3-ititle">事件流程图{streaming && <span className="fv3-live">● live</span>}<span className="fv3-sub" style={{ marginLeft: "auto" }}>{agents.filter((a) => a.built).length} 智能体 · {allEvents.length} 事件{validation ? (validation.ok ? " · 合同闭合 ✓" : " · 未闭合 ⚠") : " · 动态"}</span></div>}
      <svg className="fv3-eg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMin meet" role="img" aria-label="事件流程图">
        <defs><marker id="egarrow" markerWidth="8" markerHeight="8" refX="6.5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="var(--c-ink-3)" /></marker></defs>
        {cedges.map((e, i) => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          const fromAgent = e.from.startsWith("a:");
          const dk = cnodes.find((n) => n.id === e.to)?.kind;
          const toRed = e.to.startsWith("e:") && (dk === "fail" || dk === "orphan");
          const fromH = fromAgent ? AH / 2 : EH / 2, toH = e.to.startsWith("a:") ? AH / 2 : EH / 2;
          return <path key={"ce" + i} d={curve(a.x, a.y + fromH, b.x, b.y - toH)} fill="none" stroke={toRed ? "var(--c-bad, #ff7a8a)" : "var(--c-line)"} strokeWidth="1.4" markerEnd="url(#egarrow)" opacity={toRed ? 0.85 : 1} strokeDasharray={dk === "orphan" ? "4 3" : undefined} />;
        })}
        {cnodes.map((n) => {
          const p = pos.get(n.id)!;
          if (n.kind === "agent") {
            // contract issue (validate_graph flagged this agent) outranks the run
            // status tint — a broken trigger/emit is the thing to fix first.
            const sc = n.issue ? "var(--c-warn, #f5b556)" : statusColor(n.status);
            const sub = n.issue ? "⚠ 合同待修" : n.status === "ran" ? "✓ 跑通" : n.status === "degraded" ? "⚠ 降级" : n.status === "missed" ? "○ 未触发" : n.built ? "已生成" : "计划中";
            return (
              <g key={n.id} className={`fv3-cgagent ${n.built ? "built" : "ghost"} ${n.issue ? "issue" : ""}`}>
                <rect x={p.x - AW / 2} y={p.y - AH / 2} width={AW} height={AH} rx="11" style={sc ? { stroke: sc, strokeWidth: n.issue ? 2 : undefined } : undefined} />
                <text x={p.x} y={p.y - 6} textAnchor="middle" className="fv3-cgatitle">{n.label.length > 14 ? n.label.slice(0, 13) + "…" : n.label}</text>
                <text x={p.x} y={p.y + 11} textAnchor="middle" className="fv3-cgasub">{sub}{n.sub ? " · " + n.sub.slice(0, 16) : ""}</text>
              </g>
            );
          }
          const cls = (n.kind === "fail" ? "fail" : n.kind === "orphan" ? "orphan" : n.kind === "success" ? "success" : n.kind === "entry" ? "entry" : "event") + (n.gap ? " gap" : "");
          const label = n.kind === "orphan" || n.gap ? "⚠ " + n.label : n.label;
          const w = Math.min(EW, Math.max(80, label.length * 8 + 22));
          return (
            <g key={n.id} className={`fv3-cgevent ${cls}`}>
              <rect x={p.x - w / 2} y={p.y - EH / 2} width={w} height={EH} rx="15" />
              <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central" className="fv3-cgetext">{label.length > 24 ? label.slice(0, 23) + "…" : label}</text>
            </g>
          );
        })}
      </svg>
      <div className="fv3-eglegend">
        <div><span className="fv3-egdot agent" />智能体</div>
        <div><span className="fv3-egdot event" />事件</div>
        <div><span className="fv3-egdot success" />成功终态</div>
        <div><span className="fv3-egdot term" />失败分支</div>
        {danglingEmits.size > 0 && <div><span className="fv3-egdot orphan" />悬空(无下游)</div>}
        {payloadGapEvents.size > 0 && <div><span className="fv3-egdot gap" />字段缺口</div>}
        {agents.some((a) => !a.built) && <div><span className="fv3-egdot ghost" />计划中</div>}
      </div>
      {validation && !validation.ok && (
        <div className="fv3-egcontract">⚠ 事件合同未闭合：{validation.issues.slice(0, 2).join("；")}{validation.issues.length > 2 ? ` 等 ${validation.issues.length} 处` : ""}<span className="fv3-egcontracthint">（这是 AI 当前设计的真实状态，下一轮会 refine 修正）</span></div>
      )}
    </div>
  );
}

// The main brain's ReAct loop, as named stages → the tools that realize each.
// refine is the loop-back (设计⇄验收). Used to draw the brain's actual harness flow.
// Each stage of the brain's loop is a NAMED ROLE (persona) it plays — so "每个 agent
// 角色都清晰". role = the persona, label = what it does, tools = how.
const HARNESS_STAGES: Array<{ role: string; label: string; tools: string[] }> = [
  { role: "业务分析师", label: "读业务定义", tools: ["read_ontology"] },
  { role: "方案架构师", label: "制定计划", tools: ["create_plan"] },
  { role: "智能体设计师", label: "设计智能体", tools: ["design_agent"] },
  { role: "代码工程师", label: "写代码", tools: ["codegen_agent"] },
  { role: "质检员", label: "校验闭合", tools: ["validate_graph", "review_agent", "verify_chain"] },
  { role: "试运行工程师", label: "试运行验证", tools: ["sandbox_run", "inspect_run"] },
  { role: "交付", label: "完成交付", tools: ["finish"] },
];

// SVG of the brain's ReAct harness loop, with this run's REAL call counts overlaid
// and a 修订 (refine) loop-back from 验收 → 设计. Stages with 0 calls render faint.
function HarnessLoopSvg({ toolCounts }: { toolCounts: Map<string, number> }) {
  const cnt = (tools: string[]) => tools.reduce((s, t) => s + (toolCounts.get(t) ?? 0), 0);
  const refine = toolCounts.get("refine_agent") ?? 0;
  const BW = 154, BH = 38, ROWH = 56, X = 95, PADTOP = 14, LOOPX = 252;
  const H = PADTOP + HARNESS_STAGES.length * ROWH;
  const yOf = (i: number) => PADTOP + i * ROWH + BH / 2;
  return (
    <svg className="fv3-hloop" viewBox={`0 0 300 ${H}`} preserveAspectRatio="xMidYMin meet" role="img" aria-label="主大脑工作循环">
      <defs><marker id="hlarrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--c-ink-3)" /></marker></defs>
      {HARNESS_STAGES.slice(0, -1).map((_, i) => (
        <line key={i} x1={X} y1={yOf(i) + BH / 2} x2={X} y2={yOf(i + 1) - BH / 2} stroke="var(--c-line)" strokeWidth="1.4" markerEnd="url(#hlarrow)" />
      ))}
      {/* refine loop-back: 验收(5) → 设计(2) */}
      {refine > 0 && (
        <g>
          <path d={`M ${X + BW / 2} ${yOf(5)} C ${LOOPX} ${yOf(5)}, ${LOOPX} ${yOf(2)}, ${X + BW / 2} ${yOf(2)}`} fill="none" stroke="var(--c-warn,#f5b556)" strokeWidth="1.4" strokeDasharray="4 3" markerEnd="url(#hlarrow)" />
          <text x={LOOPX + 4} y={(yOf(5) + yOf(2)) / 2} className="fv3-hlooplbl">修订 ×{refine}</text>
        </g>
      )}
      {HARNESS_STAGES.map((s, i) => {
        const n = cnt(s.tools);
        return (
          <g key={s.label} className={`fv3-hlstage ${n > 0 ? "on" : "off"}`}>
            <rect x={X - BW / 2} y={yOf(i) - BH / 2} width={BW} height={BH} rx="8" />
            <text x={X} y={yOf(i) - 5} textAnchor="middle" className="fv3-hltext">{s.role}{n > 0 ? `  ×${n}` : ""}</text>
            <text x={X} y={yOf(i) + 7} textAnchor="middle" className="fv3-hlsub">{s.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// A faithful (not verbatim) sketch of how each internal agent runs, as code — so
// "show me the code" has an answer for the harness agents too. The real source is
// conductor.ts / p2-p3.ts; this is the shape.
const HARNESS_CODE_MAIN = `// 主大脑 = 自主 ReAct 循环  (lib/agent-factory-v3/brain/conductor.ts)
while (未完成 && turn < MAX_TURNS) {
  // 1. 自己流式思考，决定下一步调哪个工具（不写死顺序）
  const turn = await streamTurn(messages, 可用工具集, { 约束解码: 本体真实动作名 })

  // 2. 执行它选的工具：读本体 / 设计 / 校验 / 试运行 / 修订 …
  for (const call of turn.toolCalls) {
    const result = await 执行工具(call)   // 工具实现在 tools/index.ts
    messages.push(result)                  // 观察结果 → 进下一轮
  }

  // 3. 只有调用 finish 且通过「验收门」(全链路跑通) 才结束
  if (调用了 finish && lastSandbox.fullChainRan) break
}`;

const HARNESS_CODE_SUB = `// 子大脑 = 递归的隔离 ReAct  (lib/agent-factory-v3/tools/p2-p3.ts · spawn_subagent)
for await (const e of runBrain({
  goal: 子任务,
  tools: 只读研究工具,        // read_ontology / web_search / inspect — 不能部署、不能改
  isSubAgent: true,           // 独立 ctx + 独立 message history
  signal: 父大脑.signal,       // 父被取消 → 级联取消
})) { /* 收集它的结论，回传 summary，不落任何副作用 */ }`;

// BRAIN ACTIVITY LOG — the per-actor, chronological record the user asked for: every
// agent (the main brain + each sub-brain) and what it actually did, step by step,
// concise but with the real input/output one click away. This is the default 大脑
// view (the radial graph is kept as a secondary "活动图"). Pure render over the
// blocks already streamed — no new data needed.
// #6 — the AI run-review panel: score + summary + problems / suggestions / strengths + the model used.
function RunReviewPanel({ a, onRedo, analyzing }: { a: Record<string, unknown>; onRedo: () => void; analyzing: boolean }) {
  const score = Number(a.score) || 0;
  const color = score >= 80 ? "var(--c-ok,#5cc98c)" : score >= 55 ? "var(--c-warn,#f5b556)" : "var(--c-err,#e5707e)";
  const list = (label: string, items: unknown, c: string) => {
    const arr = (Array.isArray(items) ? items : []).map(String).filter(Boolean);
    if (!arr.length) return null;
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 10.5, opacity: 0.55, fontFamily: "monospace", textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
        {arr.map((t, i) => <div key={i} style={{ fontSize: 12.5, lineHeight: 1.5, paddingLeft: 12, textIndent: -10 }}><span style={{ color: c }}>· </span>{t}</div>)}
      </div>
    );
  };
  return (
    <div style={{ border: "1px solid var(--fv3-border,#2a2f3a)", borderRadius: 10, padding: 14, marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <b style={{ fontSize: 13 }}>AI 运行评审</b>
        <span style={{ fontSize: 24, fontWeight: 800, color, fontFamily: "monospace" }}>{a.scored ? score : "—"}</span>
        <span style={{ fontSize: 11, opacity: 0.5 }}>/ 100</span>
        {a.scored && a.model ? <span title="评审使用的模型" style={{ fontSize: 10, opacity: 0.5, fontFamily: "monospace" }}>🧠 {String(a.model).split("/").pop()}</span> : null}
        <button className="fv3-btn" onClick={onRedo} disabled={analyzing} style={{ marginLeft: "auto", fontSize: 11, padding: "3px 8px" }}>{analyzing ? "评审中…" : "重新评审"}</button>
      </div>
      {a.summary ? <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 8, lineHeight: 1.6 }}>{String(a.summary)}</div> : null}
      {list("问题", a.problems, "var(--c-err,#e5707e)")}
      {list("建议", a.suggestions, "var(--c-ok,#5cc98c)")}
      {list("优点", a.strengths, "var(--c-muted,#8a90a0)")}
    </div>
  );
}

function BrainActivityLog({ blocks, streaming }: { blocks: Block[]; streaming: boolean }) {
  // The ACTION log: skip raw think tokens + narration; keep what each actor DID.
  const steps = blocks.filter((b) => b.kind !== "think" && b.kind !== "message");
  const toolCount = steps.filter((b) => b.kind === "tool").length;
  const subs = blocks.filter((b) => b.kind === "subagent");
  if (steps.length === 0) {
    return <div className="fv3-empty">运行后这里按角色（主大脑 / 子大脑）逐步记录它做的每一件事：调了什么工具（点开看真实输入/输出）、生成了什么、校验与试运行结果——简洁但完整。</div>;
  }
  return (
    <div className="fv3-balog">
      <div className="fv3-balogcap">活动时间线 · {toolCount} 步{subs.length ? ` · ${subs.length} 子大脑` : ""}{streaming && <span className="fv3-live"> ● live</span>}</div>
      <div className="fv3-balogsteps">
        {steps.map((b, i) => <LogRow key={i} b={b} />)}
      </div>
    </div>
  );
}

// One row of the brain activity log. Tool steps are collapsible (▸ → input/output);
// milestones (生成 agent / 技能 / 工具 / 计划) + verdicts (校验 / 试运行 / 用例) are one-liners;
// a sub-brain renders as its own small nested block with its task + conclusion.
function LogRow({ b }: { b: Block }) {
  const [open, setOpen] = React.useState(false);
  switch (b.kind) {
    case "tool": {
      const ok = b.result?.ok;
      return (
        <div className="fv3-balogrow tool">
          <button className="fv3-balogtool" onClick={() => setOpen(!open)}>
            <span className={`fv3-balogdot ${ok === false ? "err" : b.result ? "ok" : "run"}`} />
            <span className="fv3-balogname">{TOOL_LABEL[b.name] ?? b.name}</span>
            {b.reasoning && <span className="fv3-balogwhy">{b.reasoning}</span>}
            {b.model && <span title="本步使用的模型" style={{ fontSize: 9.5, opacity: 0.6, marginLeft: 4, fontFamily: "monospace", whiteSpace: "nowrap" }}>🧠 {b.model.split("/").pop()}</span>}
            <span className="fv3-balogchev">{open ? "▾" : "▸"}</span>
          </button>
          {open && (
            <div className="fv3-balogio">
              <div className="fv3-balogiolbl">输入</div>
              <pre className="fv3-balogpre">{JSON.stringify(b.input, null, 2)}</pre>
              {b.result && (<><div className="fv3-balogiolbl">结果 {b.result.ok ? "✓" : "✗"}</div><div className="fv3-balogres">{b.result.summary}</div></>)}
              {/* #5: the COMPLETE tool output, not just the summary. */}
              {b.result?.output && (<><div className="fv3-balogiolbl">完整输出</div><pre className="fv3-balogpre">{b.result.output}</pre></>)}
            </div>
          )}
        </div>
      );
    }
    case "subagent":
      return (
        <div className="fv3-balogrow sub">
          <div className="fv3-balogsubhd"><span className="fv3-balogava sub">{Ic.branch({ width: 12, height: 12 })}</span>子大脑 · {b.task}</div>
          {b.summary && <div className="fv3-balogsubsum">{b.summary}</div>}
        </div>
      );
    case "agent":
      return <div className="fv3-balogrow milestone"><span className="fv3-balogtag agent">生成</span>{b.spec.nameZh} <i>· {b.spec.tools.length} 工具</i></div>;
    case "skill":
      return <div className="fv3-balogrow milestone"><span className="fv3-balogtag skill">技能</span>{b.name}</div>;
    case "toolnew":
      return <div className="fv3-balogrow milestone"><span className="fv3-balogtag tool">造工具</span>{b.name}</div>;
    case "plan":
      return <div className="fv3-balogrow milestone"><span className="fv3-balogtag plan">计划 v{b.version}</span>{b.agentCount} 个 agent</div>;
    case "validation":
      return <div className="fv3-balogrow"><span className={`fv3-balogtag ${b.ok ? "ok" : "warn"}`}>校验</span>{b.ok ? "事件图闭合 ✓" : (b.issues[0] ?? "未闭合")}</div>;
    case "sandbox":
      return <div className="fv3-balogrow"><span className={`fv3-balogtag ${b.fullChainRan ? "ok" : "warn"}`}>试运行</span>{b.ran}/{b.deployed ?? b.ran} 跑起来 · {b.fullChainRan ? "全链路 ✓" : b.reachedTerminal ? "到终态" : "未到终态"}</div>;
    case "refine":
      return <div className="fv3-balogrow"><span className="fv3-balogtag refine">修订</span>{b.actionName} #{b.attemptNumber}</div>;
    case "inspect":
      return <div className="fv3-balogrow"><span className="fv3-balogtag">诊断</span>{b.agentSlug} · {b.status}{b.degraded ? " · 降级" : ""}</div>;
    case "web":
      return <div className="fv3-balogrow"><span className="fv3-balogtag">检索</span>{b.query} · {b.results.length} 条</div>;
    case "testcases":
      return <div className="fv3-balogrow"><span className="fv3-balogtag tc">用例</span>{b.cases.length} 个全流程用例{b.awaitingApproval ? " · 待确认" : b.decided === "approve" ? " · 已执行" : b.decided === "regenerate" ? " · 重做" : ""}</div>;
    case "compaction":
      return (
        <div className="fv3-balogrow tool">
          <button className="fv3-balogtool" onClick={() => setOpen(!open)}>
            <span className="fv3-balogdot ok" /><span className="fv3-balogname">🗜 上下文压缩</span>
            <span className="fv3-balogwhy">{b.summary}</span><span className="fv3-balogchev">{open ? "▾" : "▸"}</span>
          </button>
          {open && <div className="fv3-balogio"><div className="fv3-balogiolbl">折叠后的状态快照</div><pre className="fv3-balogpre">{b.state}</pre></div>}
        </div>
      );
    case "askuser":
      return <div className="fv3-balogrow"><span className="fv3-balogtag tc">提问</span>{b.question}{b.awaiting ? " · 待你回答" : " · 已回答"}</div>;
    default:
      return null;
  }
}

// LIVE brain-activity graph — one window showing EVERYTHING the main brain is doing
// this run: the business agents it designs, the SKILLS it sinters, the tools it
// builds, and the sub-brains it spawns — as a radial map that GROWS live (each node
// animates in as its event arrives). The "动态展示大脑在发生什么 + 谁生成了谁" the user asked for.
function BrainActivityGraph({ blocks, streaming, full }: { blocks: Block[]; streaming: boolean; full?: boolean }) {
  // Dedupe by identity (agent.created / skill.created re-emit on every refine/reuse,
  // so the raw blocks repeat — keep the latest per slug/name).
  const agentMap = new Map<string, Extract<Block, { kind: "agent" }>>();
  const skillMap = new Map<string, Extract<Block, { kind: "skill" }>>();
  const toolMap = new Map<string, Extract<Block, { kind: "toolnew" }>>();
  for (const b of blocks) {
    if (b.kind === "agent") agentMap.set(b.spec.slug, b);
    else if (b.kind === "skill") skillMap.set(b.name, b);
    else if (b.kind === "toolnew") toolMap.set(b.name, b);
  }
  const agents = [...agentMap.values()];
  const skills = [...skillMap.values()];
  const tools = [...toolMap.values()];
  const subs = blocks.filter((b): b is Extract<Block, { kind: "subagent" }> => b.kind === "subagent");
  type G = { key: string; dir: number; color: string; label: string; items: Array<{ label: string; sub: string }> };
  const groups: G[] = ([
    { key: "agent", dir: -90, color: "var(--c-accent)", label: "业务智能体", items: agents.map((a) => ({ label: a.spec.nameZh, sub: a.spec.short })) },
    { key: "sub", dir: 0, color: "var(--c-warn,#f5b556)", label: "子大脑", items: subs.map((s, i) => ({ label: `子大脑 #${i + 1}`, sub: (s.task || "").slice(0, 16) })) },
    { key: "skill", dir: 90, color: "oklch(.74 .13 250)", label: "技能", items: skills.map((s) => ({ label: s.name, sub: (s.purpose || "").slice(0, 16) })) },
    { key: "tool", dir: 180, color: "var(--c-ok)", label: "造的工具", items: tools.map((t) => ({ label: t.name, sub: (t.description || "").slice(0, 16) })) },
  ] as G[]).filter((g) => g.items.length > 0);
  const total = groups.reduce((s, g) => s + g.items.length, 0);
  if (total === 0) return <div className="fv3-empty">运行后这里<strong>动态画出</strong>大脑做的每一件事:设计的业务智能体、沉淀的技能、造的工具、派生的子大脑——每出现一个就长出一个节点。</div>;
  const CX = 350, CY = 350, R = 222, BR = 42, NW = 120, NH = 34;
  const nodes: Array<{ id: string; label: string; sub: string; color: string; x: number; y: number }> = [];
  for (const g of groups) {
    const n = g.items.length;
    const spread = Math.min(165, 22 + n * 17);
    g.items.forEach((it, i) => {
      const deg = g.dir + (n > 1 ? ((i + 0.5) / n - 0.5) * spread : 0);
      const ang = (deg * Math.PI) / 180;
      const r = R + (i % 2) * 32;
      nodes.push({ id: `${g.key}-${i}`, label: it.label, sub: it.sub, color: g.color, x: CX + Math.cos(ang) * r, y: CY + Math.sin(ang) * r });
    });
  }
  return (
    <div className={`fv3-bawrap ${full ? "full" : ""}`}>
      {!full && <div className="fv3-ititle">大脑活动图{streaming && <span className="fv3-live">● live</span>}<span className="fv3-sub" style={{ marginLeft: "auto" }}>{agents.length} 智能体 · {skills.length} 技能 · {tools.length} 工具 · {subs.length} 子大脑</span></div>}
      <svg className="fv3-ba" viewBox="0 0 700 700" preserveAspectRatio="xMidYMid meet" role="img" aria-label="大脑活动图">
        {nodes.map((nd) => <line key={"e" + nd.id} x1={CX} y1={CY} x2={nd.x} y2={nd.y} stroke="var(--c-line)" strokeWidth="1.2" />)}
        <g className={`fv3-bacenter ${streaming ? "live" : ""}`}>
          <circle cx={CX} cy={CY} r={BR} />
          <text x={CX} y={CY - 4} textAnchor="middle" className="fv3-bactitle">🧠 主大脑</text>
          <text x={CX} y={CY + 13} textAnchor="middle" className="fv3-bacsub">{total} 个产物</text>
        </g>
        {nodes.map((nd) => (
          <g key={nd.id} className="fv3-banode" style={{ ["--bac" as string]: nd.color }}>
            <rect x={nd.x - NW / 2} y={nd.y - NH / 2} width={NW} height={NH} rx="9" />
            <text x={nd.x} y={nd.y - 4} textAnchor="middle" className="fv3-bant">{nd.label.length > 12 ? nd.label.slice(0, 11) + "…" : nd.label}</text>
            <text x={nd.x} y={nd.y + 9} textAnchor="middle" className="fv3-bans">{nd.sub}</text>
          </g>
        ))}
      </svg>
      <div className="fv3-balegend">{groups.map((g) => <div key={g.key}><span className="fv3-badot" style={{ background: g.color }} />{g.label}({g.items.length})</div>)}</div>
    </div>
  );
}

// Harness plane (kind-1 agents): the main factory brain + the sub-agents it
// spawns — each its OWN harness (independent thinking + tools, can plan/spawn).
// Deliberately SEPARATE from the product event graph: these BUILD the product,
// they are NOT the deliverable. Mirrors lib/agent-harness AgentKind harness/builder.
function HarnessView({ goal, domain, blocks, toolCounts, agentsBuilt, lastBudget, streaming }: {
  goal: string; domain: string; blocks: Block[]; toolCounts: Map<string, number>; agentsBuilt: number;
  lastBudget: { turn: number; maxTurns: number } | null; streaming: boolean;
}) {
  const [open, setOpen] = React.useState<string | null>("log");
  const subagents = blocks.filter((b): b is Extract<Block, { kind: "subagent" }> => b.kind === "subagent");
  const skills = blocks.filter((b): b is Extract<Block, { kind: "skill" }> => b.kind === "skill");
  const newTools = blocks.filter((b): b is Extract<Block, { kind: "toolnew" }> => b.kind === "toolnew");
  const harnessTools = [...toolCounts.entries()];
  // the brain's REAL execution this run — its ordered tool-call sequence (= what it
  // actually ran). The closest thing to "the code that ran" for an autonomous brain.
  const toolSeq = blocks.filter((b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool").map((b) => b.name);
  const tog = (k: string) => setOpen(open === k ? null : k);
  return (
    <div className="fv3-harness">
      <div className="fv3-ititle">幕后大脑{streaming && <span className="fv3-live">● live</span>}<span className="fv3-sub" style={{ marginLeft: "auto" }}>非交付物 · 负责造业务智能体的智能</span></div>
      <div className="fv3-hnode root">
        <div className="fv3-hhead" title={goal ? "目标：" + goal : undefined}><span className="fv3-havatar brain">{Ic.brain({ width: 15, height: 15 })}</span>主大脑 <span className="fv3-hbadge">自带思考 + 工具</span></div>
        <div className="fv3-hmeta">{domain} · {lastBudget ? `${lastBudget.turn}/${lastBudget.maxTurns} 轮` : "—"} · 生成 {agentsBuilt} 个业务智能体 · 派生 {subagents.length} 个子大脑</div>
        {harnessTools.length > 0 && (
          <div className="fv3-htools">
            {harnessTools.map(([t, n]) => <span key={t} className="fv3-htool">{TOOL_LABEL[t] ?? t}{n > 1 ? <i> ×{n}</i> : null}</span>)}
          </div>
        )}
        {(skills.length > 0 || newTools.length > 0) && (
          <div className="fv3-hcaps">
            {skills.map((s, i) => <span key={"s" + i} className="fv3-hcap skill" title={s.purpose}>✦ 造技能：{s.name}</span>)}
            {newTools.map((t, i) => <span key={"t" + i} className="fv3-hcap tool" title={t.description}>🔧 造工具：{t.name}</span>)}
          </div>
        )}
        <div className="fv3-hviewbar">
          <button className={`fv3-hview ${open === "log" ? "on" : ""}`} onClick={() => tog("log")}>活动日志</button>
          <button className={`fv3-hview ${open === "activity" ? "on" : ""}`} onClick={() => tog("activity")}>活动图</button>
          <button className={`fv3-hview ${open === "loop" ? "on" : ""}`} onClick={() => tog("loop")}>工作循环图</button>
          <button className={`fv3-hview ${open === "trace" ? "on" : ""}`} onClick={() => tog("trace")}>运行轨迹（{toolSeq.length}）</button>
          <button className={`fv3-hview ${open === "code" ? "on" : ""}`} onClick={() => tog("code")}>实现代码</button>
        </div>
        {open === "log" && <BrainActivityLog blocks={blocks} streaming={streaming} />}
        {open === "activity" && <BrainActivityGraph blocks={blocks} streaming={streaming} />}
        {open === "loop" && <HarnessLoopSvg toolCounts={toolCounts} />}
        {open === "trace" && (
          <div className="fv3-htrace">
            {toolSeq.length === 0 ? <div className="fv3-empty">运行后这里按顺序列出大脑每一步调的工具。</div> : toolSeq.map((t, i) => (
              <div key={i} className="fv3-htracerow"><span className="fv3-htracei">{i + 1}</span>{TOOL_LABEL[t] ?? t}</div>
            ))}
          </div>
        )}
        {open === "code" && <pre className="fv3-hcode">{HARNESS_CODE_MAIN}</pre>}
      </div>
      {open !== "log" && subagents.map((s, i) => (
        <div key={i} className="fv3-hnode child">
          <span className="fv3-hconn" />
          <div className="fv3-hhead"><span className="fv3-havatar sub">{Ic.branch({ width: 13, height: 13 })}</span>子大脑 #{i + 1} <span className="fv3-hbadge sub">独立 · 只查不改</span>{!s.summary && streaming && <span className="fv3-live">● 运行中</span>}</div>
          <div className="fv3-hgoal">任务：{s.task}</div>
          {s.summary && <div className="fv3-hsummary">结论：{s.summary}</div>}
          <div className="fv3-hviewbar"><button className={`fv3-hview ${open === `sub${i}` ? "on" : ""}`} onClick={() => tog(`sub${i}`)}>实现代码</button></div>
          {open === `sub${i}` && <pre className="fv3-hcode">{HARNESS_CODE_SUB}</pre>}
        </div>
      ))}
      {open !== "log" && subagents.length === 0 && <div className="fv3-empty" style={{ marginTop: 8 }}>主大脑可按需派生独立的「只查不改」研究子大脑（各自独立思考、不干扰主流程、不能部署）。本次运行还没派生。</div>}
    </div>
  );
}

// Feature 2 — the verification I/O panel. Shows the use cases that were fired into
// the sandbox and, for each agent that ran, its REAL input→tools→output captured
// from the archive (real runId + real payloads). This is the "证明沙箱真跑通" proof.
function SandboxIOPanel({ sandbox, domain }: { sandbox?: Extract<Block, { kind: "sandbox" }>; domain: string }) {
  if (!sandbox) return <div className="fv3-empty">试运行后这里展示<strong>喂进沙箱的测试用例</strong>和<strong>每个智能体真实的输入 / 输出</strong>——用真实的运行 ID 和 payload 证明沙箱里真的跑通了。</div>;
  const strip = (e?: string | null) => (e ? e.replace(`${domain}/`, "") : "");
  const cases = sandbox.cases ?? [];
  const runs = sandbox.agentRuns ?? [];
  const caseResults = sandbox.caseResults ?? [];
  return (
    <div className="fv3-iopanel">
      {caseResults.length > 0 && (
        <>
          <div className="fv3-ititle">用例预期匹配（{caseResults.filter((r) => r.ok).length}/{caseResults.length}）<span className="fv3-sub" style={{ marginLeft: "auto" }}>判对了吗</span></div>
          {caseResults.map((r, i) => (
            <div key={i} className={`fv3-caserow ${r.ok ? "ok" : "bad"}`}>
              <span className={`fv3-casemark ${r.ok ? "ok" : "bad"}`}>{r.ok ? "✓" : "✗"}</span>
              <div className="fv3-casebody">
                <div className="fv3-casename">{r.name}<span className={`fv3-casekind ${r.kind}`}>{r.kind === "pass" ? "应通过" : r.kind === "reject" ? "应拒绝" : "边界"}</span></div>
                <div className="fv3-casedetail">{r.detail}</div>
              </div>
            </div>
          ))}
        </>
      )}
      {cases.length > 0 && (
        <>
          <div className="fv3-ititle">测试用例（{cases.length}）<span className="fv3-sub" style={{ marginLeft: "auto" }}>已喂进沙箱</span></div>
          {cases.map((c, i) => (
            <div key={i} className="fv3-iocase">
              <div className="fv3-iocasehd"><b>{c.name}</b> · 入口 <code>{strip(c.entryEvent)}</code></div>
              <pre className="fv3-iopre">{JSON.stringify(c.payload, null, 2)}</pre>
            </div>
          ))}
        </>
      )}
      <div className="fv3-ititle" style={{ marginTop: cases.length ? 14 : 0 }}>逐智能体输入 / 输出（{runs.length}）</div>
      {runs.length === 0 ? (
        <div className="fv3-empty">这次没采集到逐智能体的运行明细（可能未跑或归档延迟，稍等再看）。</div>
      ) : runs.map((r) => (
        <div key={r.runId} className={`fv3-iocard ${r.degraded ? "degraded" : r.status === "Completed" ? "ok" : "warn"}`}>
          <div className="fv3-iohd">
            <span className="fv3-ioname">{r.agentShort}</span>
            <span className={`fv3-iostatus ${r.degraded ? "degraded" : r.status === "Completed" ? "ok" : "warn"}`}>{r.degraded ? "⚠ 降级" : r.status === "Completed" ? "✓ 跑通" : r.status}</span>
            <a className="fv3-iolink" href={r.url} target="_blank" rel="noreferrer" title="打开运行平台上的真实运行">run ↗</a>
          </div>
          <div className="fv3-iorow"><span className="fv3-iolbl">输入</span><code className="ev in">{strip(r.triggerEvent) || "(入口)"}</code>{r.inputPayload && <span className="fv3-iopay">{compactPayload(r.inputPayload)}</span>}</div>
          {r.tools.length > 0 && <div className="fv3-iorow"><span className="fv3-iolbl">工具</span><span className="fv3-iotools">{r.tools.join(" → ")}</span></div>}
          {r.reasoning && <div className="fv3-iorow"><span className="fv3-iolbl">判断</span><span className="fv3-ioreason">{r.reasoning.slice(0, 160)}</span></div>}
          <div className="fv3-iorow"><span className="fv3-iolbl">输出</span><code className="ev out">{strip(r.outputEvent) || "(无)"}</code>{r.outputPayload && <span className="fv3-iopay">{compactPayload(r.outputPayload)}</span>}</div>
        </div>
      ))}
    </div>
  );
}

// Compact one-line JSON for an I/O payload chip (drop noise keys, cap length).
function compactPayload(o: Record<string, unknown>): string {
  const clone: Record<string, unknown> = { ...o };
  delete clone._runId; delete clone._demo; delete clone.source;
  const s = Object.entries(clone).slice(0, 6).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ");
  return s.length > 160 ? s.slice(0, 159) + "…" : s;
}

function EvalLine({ ok, label, detail }: { ok?: boolean; label: string; detail?: string }) {
  const cls = ok === undefined ? "idle" : ok ? "ok" : "err";
  return <div className="fv3-eval"><span className={`fv3-evmark ${cls}`}>{ok === undefined ? "·" : ok ? "✓" : "✗"}</span><div><div className="fv3-evlabel">{label}</div>{detail && <div className="fv3-evdetail">{detail}</div>}</div></div>;
}

function DSec({ label, body }: { label: string; body: string }) {
  return (
    <div className="fv3-dsec">
      <span className="fv3-dlabel">{label}</span>
      <div className="fv3-dbody">{body}</div>
    </div>
  );
}

// Per-card mini event-flow: this agent's own trigger(s) → it → emit(s), with
// failure branches in red and the success leaf in green. The card IS the agent,
// so the middle node is just a dot. Gives every product agent its own little
// graph without leaving the 智能体 tab.
function MiniFlowSvg({ trigger, emit }: { trigger: string[]; emit: string[] }) {
  const isFail = (e: string) => /FAIL|REJECT|ERROR|CONFLICT|MISSING|DENIED/i.test(e);
  const trigs = (trigger.length ? trigger : ["（入口）"]).slice(0, 3);
  const outs = (emit.filter((e) => e && e !== "—").length ? emit.filter((e) => e && e !== "—") : ["（终态）"]).slice(0, 4);
  const rows = Math.max(trigs.length, outs.length);
  const RH = 22, PADY = 6, EW = 118, AX = 150, H = PADY * 2 + rows * RH, midY = H / 2;
  const short = (e: string) => (e.length > 15 ? e.slice(0, 14) + "…" : e);
  const yOf = (i: number, n: number) => PADY + ((i + 0.5) / n) * (rows * RH);
  return (
    <svg className="fv3-miniflow" viewBox={`0 0 300 ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="该智能体的事件流">
      <defs><marker id="mfarrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L5,3 L0,6 Z" fill="var(--c-ink-3)" /></marker></defs>
      {trigs.map((t, i) => <path key={"t" + i} d={`M ${8 + EW} ${yOf(i, trigs.length)} C 130 ${yOf(i, trigs.length)}, 130 ${midY}, ${AX - 7} ${midY}`} fill="none" stroke="var(--c-line)" strokeWidth="1.2" markerEnd="url(#mfarrow)" />)}
      {outs.map((e, i) => <path key={"e" + i} d={`M ${AX + 7} ${midY} C 175 ${midY}, 175 ${yOf(i, outs.length)}, ${300 - EW - 8} ${yOf(i, outs.length)}`} fill="none" stroke={isFail(e) ? "var(--c-bad,#ff7a8a)" : "var(--c-line)"} strokeWidth="1.2" markerEnd="url(#mfarrow)" />)}
      {trigs.map((t, i) => <g key={"tp" + i} className="fv3-mfev"><rect x={8} y={yOf(i, trigs.length) - 9} width={EW} height={18} rx="9" /><text x={8 + EW / 2} y={yOf(i, trigs.length)} textAnchor="middle" dominantBaseline="central">{short(t)}</text></g>)}
      <circle cx={AX} cy={midY} r="7" className="fv3-mfdot" />
      {outs.map((e, i) => <g key={"ep" + i} className={`fv3-mfev ${isFail(e) ? "fail" : "ok"}`}><rect x={300 - EW - 8} y={yOf(i, outs.length) - 9} width={EW} height={18} rx="9" /><text x={300 - 8 - EW / 2} y={yOf(i, outs.length)} textAnchor="middle" dominantBaseline="central">{short(e)}</text></g>)}
    </svg>
  );
}

// One generated agent in the 智能体 tab — name + event flow + tools, and one
// click reveals its full Prompt or its readable .ts code (with copy).
type AgentView = null | "prompt" | "code" | "logic";
function AgentDetailCard({ a, canAct, onAct, status, onFull, toolTitle }: { a: Extract<Block, { kind: "agent" }>; canAct?: boolean; onAct?: (action: "accept" | "regen", hint?: string) => void; status?: "ran" | "degraded" | "missed" | "draft"; onFull?: (v: { title: string; body: React.ReactNode }) => void; toolTitle?: Record<string, string> }) {
  const [view, setView] = React.useState<AgentView>(null);
  const d = a.design;
  const toggle = (v: Exclude<AgentView, null>) => setView(view === v ? null : v);
  // P2 observability: live per-slot status badge (replaces the static 草稿).
  const badge = status === "ran" ? { t: "✓ 跑通", c: "var(--c-ok, #43d39e)" }
    : status === "degraded" ? { t: "⚠ 降级", c: "var(--c-warn, #f5b556)" }
    : status === "missed" ? { t: "○ 未触发", c: "var(--c-warn, #f5b556)" }
    : { t: "草稿", c: "var(--c-ink-3, #6b7f96)" };
  return (
    <div className="fv3-acard">
      <div className="fv3-ahead">
        <span className="fv3-aname">{a.spec.nameZh}</span>
        <span className="fv3-badge" style={{ color: badge.c, borderColor: badge.c }} title={status === "missed" ? "试运行里这个智能体没被触发——事件链可能断在它上游" : status === "degraded" ? "试运行里走了降级兜底(模型/工具异常)，不算真跑通" : status === "ran" ? "试运行里真跑起来了" : "尚未试运行验证"}>{badge.t}</span>
        {/* F1: per-agent human gate — accept this agent or have the AI rethink it.
            Routes through the live-run HITL mailbox (only actionable while running). */}
        {canAct && onAct && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="fv3-cardact acc" title="采纳这个智能体" onClick={() => onAct("accept")}>✓ 采纳</button>
            <button className="fv3-cardact re" title="让 AI 重新设计这一个(可附提示)" onClick={() => { const h = window.prompt("重想这个智能体 — 想让它怎么改?(可留空)") ?? undefined; onAct("regen", h || undefined); }}>↻ 重想</button>
          </span>
        )}
      </div>
      <MiniFlowSvg trigger={a.spec.trigger} emit={a.spec.emit} />
      {a.spec.tools.length > 0 && <div className="fv3-atools">{a.spec.tools.map((t) => <span key={t} className="fv3-tool" title={t}>{toolTitle?.[t] ?? t}</span>)}</div>}
      {a.spec.unresolved && a.spec.unresolved.length > 0 && (
        <div className="fv3-aunres">待人工实现：{a.spec.unresolved.join("、")}</div>
      )}
      <div className="fv3-aactions">
        {d?.systemPrompt && <button className={`fv3-aview ${view === "prompt" ? "on" : ""}`} onClick={() => toggle("prompt")}>指令</button>}
        {d?.code && <button className={`fv3-aview ${view === "code" ? "on" : ""}`} onClick={() => toggle("code")}>代码{d.codeSource === "ai" ? " ✦AI亲写" : ""}</button>}
        {d?.decisionLogic && <button className={`fv3-aview ${view === "logic" ? "on" : ""}`} onClick={() => toggle("logic")}>决策逻辑</button>}
      </div>
      {view === "prompt" && d?.systemPrompt && <ViewPane title={`${a.spec.nameZh} · 指令`} text={d.systemPrompt} onFull={onFull} />}
      {view === "logic" && d?.decisionLogic && <ViewPane title={`${a.spec.nameZh} · 决策逻辑`} text={d.decisionLogic} onFull={onFull} />}
      {view === "code" && d?.code && <ViewPane title={`${a.spec.nameZh} · 代码`} text={d.code} code onFull={onFull} />}
    </div>
  );
}

// Fullscreen tools-library view — every bindable tool with its full signature, side
// effect, and namespace, in a readable grid (incl. AI-created persisted tools).
function ToolsFull({ catalog }: { catalog: ToolCardLite[] }) {
  return (
    <div className="fv3-toolsfull">
      {catalog.map((t) => (
        <div key={t.name} className="fv3-toolfullcard">
          <div className="fv3-toolfullhead"><span className={`fv3-se ${t.sideEffect}`}>{t.sideEffect === "read" ? "读" : t.sideEffect === "write" ? "写" : "双写"}</span><span className="fv3-toolfullname">{t.title}</span><span className="fv3-toolfullid">{t.name}</span></div>
          {t.description && <div className="fv3-toolfulldesc">{t.description}</div>}
          {t.signature && <div className="fv3-toolfullsig">{t.signature}</div>}
        </div>
      ))}
      {catalog.length === 0 && <div className="fv3-empty">运行 read_ontology 后这里列出本域可绑定的工具库。</div>}
    </div>
  );
}

// A prompt / code / logic panel with 全屏 + 复制. Fullscreen routes through the
// shared FullModal so long prompts and wide .ts read comfortably.
function ViewPane({ title, text, code, onFull }: { title: string; text: string; code?: boolean; onFull?: (v: { title: string; body: React.ReactNode }) => void }) {
  return (
    <div className="fv3-viewpane">
      <div className="fv3-panebar">
        {onFull && <button className="fv3-fullbtn sm" title="全屏查看" onClick={() => onFull({ title, body: <pre className={code ? "fv3-fullpre code" : "fv3-fullpre"}>{text}</pre> })}>⛶ 全屏</button>}
        <button className="fv3-fullbtn sm" title="复制" onClick={() => navigator.clipboard?.writeText(text)}>复制</button>
      </div>
      <pre className={code ? "fv3-dcode" : "fv3-aprompt"}>{text}</pre>
    </div>
  );
}

function BlockView({ b, streaming, onTestDecision, onBoundaryDecision, onAnswer }: { b: Block; streaming: boolean; onTestDecision?: (d: "approve" | "regenerate", note?: string) => void; onBoundaryDecision?: (events: BoundaryEvent[]) => void; onAnswer?: (answer: string) => void }) {
  const [open, setOpen] = React.useState(false);
  switch (b.kind) {
    case "think": return <div className={`fv3-think ${streaming ? "streaming" : ""}`}>{b.text}</div>;
    case "tool": return (
      <div className="fv3-toolcard">
        <button className="fv3-toolhead" onClick={() => setOpen(!open)}>
          <span className={`fv3-pill t-${b.name}`}>{TOOL_LABEL[b.name] ?? b.name}</span>
          <span className="fv3-toolreason">{b.reasoning}</span>
          {b.model && <span title="本步使用的模型" style={{ fontSize: 9.5, opacity: 0.55, fontFamily: "monospace", whiteSpace: "nowrap" }}>🧠 {b.model.split("/").pop()}</span>}
          {b.result ? <span className={`fv3-toolstatus ${b.result.ok ? "ok" : "warn"}`}>{b.result.ok ? "✓" : "✗"}</span> : <span className="fv3-toolstatus run">●</span>}
        </button>
        {b.result && <div className="fv3-toolresult">{b.result.summary}</div>}
        {open && <pre className="fv3-toolinput">{JSON.stringify(b.input, null, 2)}</pre>}
        {/* #5: the COMPLETE tool output, not just the summary. */}
        {open && b.result?.output && <><div className="fv3-toolresult" style={{ opacity: 0.7, marginTop: 4 }}>完整输出</div><pre className="fv3-toolinput">{b.result.output}</pre></>}
      </div>
    );
    case "agent": return (
      <div className="fv3-agentcard">
        <div className="fv3-achead">🤖 {b.spec.nameZh} <span className="fv3-badge draft">DRAFT</span> <code>{b.spec.short}</code></div>
        <div className="fv3-acmeta">{b.spec.trigger.join(", ") || "(入口)"} → {b.spec.emit.join(" / ") || "(终态)"}</div>
        {b.spec.tools.length > 0 && <div className="fv3-gtools">{b.spec.tools.map((t) => <span key={t} className="fv3-tool">{t}</span>)}</div>}
        {b.spec.unresolved && b.spec.unresolved.length > 0 && (
          <div className="fv3-missing">⚠ 待人工实现（工具库缺）：{b.spec.unresolved.map((t) => <span key={t} className="fv3-misstool">{t}</span>)}</div>
        )}
        {b.design && (b.design.systemPrompt || b.design.decisionLogic || b.design.toolRationale || b.design.reasoning) && (
          <>
            <button className="fv3-designtoggle" onClick={() => setOpen(!open)}>{open ? "▾ 收起设计" : "▸ 查看它的设计（system prompt · 决策逻辑 · 代码）"}</button>
            {open && (
              <div className="fv3-design">
                {b.design.reasoning && <DSec label="设计思路" body={b.design.reasoning} />}
                {b.design.toolRationale && <DSec label="选工具理由" body={b.design.toolRationale} />}
                {b.design.decisionLogic && <DSec label="分支决策逻辑" body={b.design.decisionLogic} />}
                {b.design.systemPrompt && (
                  <div className="fv3-dsec"><span className="fv3-dlabel">它写的 system prompt</span><pre className="fv3-dprompt">{b.design.systemPrompt}</pre></div>
                )}
                {b.design.code && (
                  <div className="fv3-dsec">
                    <span className="fv3-dlabel">
                      生成的 agent 代码（.ts）
                      <button className="fv3-copycode" onClick={() => navigator.clipboard?.writeText(b.design!.code!)}>复制</button>
                    </span>
                    <pre className="fv3-dcode">{b.design.code}</pre>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
    case "validation": return <div className={`fv3-valid ${b.ok ? "ok" : "warn"}`}>{b.ok ? "✓ 事件图闭合" : `⚠ 校验：${b.issues.slice(0, 2).join("；")}`}</div>;
    case "sandbox": return (
      <div className={`fv3-sandboxcard ${b.deployFailed ? "err" : b.reachedTerminal ? "ok" : "warn"}`}>
        {b.deployFailed ? (
          <div>⚠ <b>部署未生效</b>：运行平台上实际注册了 <b>0</b> 个智能体。检查运行平台服务可达性后重试。</div>
        ) : (
          <>
            <div><span className="fv3-cardico ok">{Ic.bolt({ width: 14, height: 14 })}</span><b>真实部署上线</b>：<code className="fv3-app">{b.appId ?? "agentic-operator"}</code> · 注册 <b>{b.functionsRegistered ?? b.ran}</b> 个智能体 · {b.ran} 个跑起来 · 事件链 {b.events.length} 个 · {b.reachedTerminal ? "到达终态 ✓" : "未到终态"}</div>
            {b.runUrls && b.runUrls.length > 0 && (
              <div className="fv3-runlinks">
                {b.runUrls.map((r) => (
                  <a key={r.runId} className={`fv3-runlink ${/complete/i.test(r.status) ? "ok" : /fail|cancel/i.test(r.status) ? "err" : ""}`} href={r.url} target="_blank" rel="noreferrer" title={`${r.fn} · ${r.status}`}>
                    {/complete/i.test(r.status) ? "✓" : /fail|cancel/i.test(r.status) ? "✗" : "•"} {r.fn}
                  </a>
                ))}
                <span className="fv3-runhint">↗ 点开看 Inngest 上的真实运行</span>
              </div>
            )}
          </>
        )}
      </div>
    );
    case "web": return (
      <div className="fv3-webcard">
        <div className="fv3-webhead">🔎 联网搜索「{b.query}」· {b.results.length} 条</div>
        {b.results.slice(0, 3).map((r, i) => (
          <div key={i} className="fv3-webrow"><a href={r.url} target="_blank" rel="noreferrer">{r.title}</a><span>{r.snippet.slice(0, 110)}</span></div>
        ))}
      </div>
    );
    case "skill": return <div className="fv3-makecard">✨ <b>创造技能</b>「{b.name}」<span className="fv3-badge draft">DRAFT</span> — {b.purpose}</div>;
    case "toolnew": return <div className="fv3-makecard">🔧 <b>创造工具</b>「{b.name}」<span className="fv3-badge draft">DRAFT</span> — {b.description}</div>;
    case "subagent": return <div className="fv3-subcard"><span className="fv3-cardico sub">{Ic.branch({ width: 13, height: 13 })}</span><b>子大脑</b>：{b.task}{b.summary ? <div className="fv3-submeta">↳ {b.summary}</div> : <span className="fv3-toolstatus run"> ●</span>}</div>;
    case "plan": return (
      <div className="fv3-plancard">
        <div className="fv3-planhead">📋 <b>构建计划 v{b.version}</b><span className="fv3-badge draft">PLAN</span></div>
        <div className="fv3-plansum">{b.summary}</div>
        <div className="fv3-planlist">
          {b.planAgents.slice(0, 8).map((a, i) => (
            <div key={i} className="fv3-planrow">{i + 1}. <b>{a.actionName}</b> — {a.role}</div>
          ))}
          {b.planAgents.length > 8 && <div className="fv3-planmore">…+{b.planAgents.length - 8}</div>}
        </div>
      </div>
    );
    case "refine": return (
      <div className="fv3-refinecard">
        <div>🔁 <b>修订 #{b.attemptNumber}</b>「{b.actionName}」<span className="fv3-refinemeta">— {b.critique.slice(0, 160)}</span></div>
        {b.diff && (
          <div className="fv3-kldiff" style={{ marginTop: 5 }}>
            {b.diff.systemPromptChanged && <span className="fv3-dchip">prompt ✎</span>}
            {b.diff.decisionLogicChanged && <span className="fv3-dchip">决策 ✎</span>}
            {b.diff.toolsAdded.map((t) => <span key={"a" + t} className="fv3-dchip add">+{t}</span>)}
            {b.diff.toolsRemoved.map((t) => <span key={"r" + t} className="fv3-dchip rem">−{t}</span>)}
            {!b.diff.systemPromptChanged && !b.diff.decisionLogicChanged && b.diff.toolsAdded.length === 0 && b.diff.toolsRemoved.length === 0 && <span className="fv3-refinemeta">无显著差异</span>}
          </div>
        )}
      </div>
    );
    case "inspect": return (
      <div className={`fv3-inspectcard ${b.status === "Completed" && !b.degraded ? "ok" : "warn"}`}>
        🔍 <b>{b.agentSlug}</b> <span className="mono">{b.status}</span>{b.degraded && <span className="fv3-badge warn"> degraded</span>}{b.error && <div className="fv3-inspecterr">↳ {b.error.slice(0, 220)}</div>}
      </div>
    );
    case "reflect": return (
      <div className="fv3-reflectcard">
        💡 <b>反思 ({b.kind2})</b> — {b.lesson} <span className="fv3-reflectmeta">（已写入 FailureReflection，下次为该域生成时会自动注入）</span>
      </div>
    );
    case "sandboxProgress": return (
      <div className={`fv3-sboxprog ${b.phase}`}>
        <span className="fv3-sboxphase">{b.phase}</span> <span className="fv3-sboxdetail">{b.detail || ""}</span>{(typeof b.runsSoFar === "number" || typeof b.eventsSoFar === "number") && <span className="fv3-sboxnums"> · runs={b.runsSoFar ?? 0} · events={b.eventsSoFar ?? 0}</span>}{b.phase !== "settled" && streaming && <span className="fv3-toolstatus run"> ●</span>}
      </div>
    );
    case "testcases": return (
      <div className={`fv3-tccard ${b.awaitingApproval ? "pending" : ""}`}>
        <div className="fv3-tchead"><span className="fv3-tcicon">{Ic.flask({ width: 14, height: 14 })}</span><b>全流程测试用例</b> · {b.cases.length} 个{b.awaitingApproval ? "（待你确认是否喂进沙箱）" : b.decided === "approve" ? "（已执行）" : b.decided === "regenerate" ? "（已要求重做）" : ""}</div>
        <div className="fv3-tclist">
          {b.cases.map((c) => (
            <div key={c.id} className="fv3-tcrow">
              <span className={`fv3-tckind ${c.kind}`}>{c.kind === "pass" ? "通过" : c.kind === "reject" ? "不符" : "缺字段"}</span>
              <div className="fv3-tcbody">
                <div className="fv3-tcname">{c.name}</div>
                {c.scenario && <div className="fv3-tcscn">{c.scenario}</div>}
                <div className="fv3-tcio"><span className="fv3-tcio-lbl">入口</span><code>{c.entryEvent}</code>{c.expectedOutcome ? <> · <span className="fv3-tcio-lbl">预期</span>{c.expectedOutcome}</> : null}</div>
                <details className="fv3-tcpayload"><summary>输入 payload</summary><pre>{JSON.stringify(c.payload, null, 2)}</pre></details>
              </div>
            </div>
          ))}
        </div>
        {b.awaitingApproval && onTestDecision && (
          <div className="fv3-tcacts">
            <button className="fv3-tcbtn run" onClick={() => onTestDecision("approve")}>{Ic.play({ width: 13, height: 13 })} 执行试运行</button>
            <button className="fv3-tcbtn re" onClick={() => { const h = window.prompt("想怎么调整测试用例？(可留空)") ?? undefined; onTestDecision("regenerate", h || undefined); }}>{Ic.refresh({ width: 13, height: 13 })} 重新生成</button>
          </div>
        )}
        {b.awaitingApproval && <div className="fv3-tcwait">大脑已暂停，等你决定——这期间任务在后台保持着。</div>}
      </div>
    );
    case "boundarycases": return <BoundaryCard proposals={b.proposals} awaiting={b.awaitingDecision} onSubmit={onBoundaryDecision} />;
    case "boundarydecided": return (
      <div className="fv3-bdcard">
        <div className="fv3-tchead"><span className="fv3-cardico ok">{Ic.link({ width: 13, height: 13 })}</span><b>边界事件已确认</b></div>
        {b.events.map((e, i) => (
          <div key={i} className="fv3-bdrow">
            <span className={`fv3-bdkind ${e.kind}`}>{e.kind === "external" ? "外部交接" : e.kind === "terminal" ? "终态" : "待修断点"}</span>
            <div className="fv3-bdbody">
              <div className="fv3-bdname"><code>{e.event}</code>{e.consumer ? <span className="fv3-bdconsumer"> → {e.consumer}</span> : null}</div>
              {e.kind === "external" && e.payloadContract && <div className="fv3-bdcontract">契约：{e.payloadContract}</div>}
            </div>
          </div>
        ))}
      </div>
    );
    case "compaction": return (
      // #2d: auto-compaction made visible — one-line notice + an expand toggle for the folded snapshot.
      <div className="fv3-toolcard" style={{ borderStyle: "dashed", opacity: 0.92 }}>
        <button className="fv3-toolhead" onClick={() => setOpen(!open)}>
          <span className="fv3-pill">🗜 上下文压缩</span>
          <span className="fv3-toolreason">{b.summary}</span>
          <span className="fv3-toolstatus">{open ? "收起" : "看折叠内容"}</span>
        </button>
        {open && <pre className="fv3-toolinput">{b.state}</pre>}
      </div>
    );
    case "askuser": return (
      // #4: the brain proactively asks the user a question (with options) mid-run and parks.
      <div className="fv3-toolcard" style={{ borderColor: b.awaiting ? "var(--c-accent,#7aa2ff)" : undefined }}>
        <div className="fv3-toolhead" style={{ cursor: "default" }}>
          <span className="fv3-pill">🙋 需要你</span>
          <span className="fv3-toolreason" style={{ fontWeight: 600 }}>{b.question}</span>
          {!b.awaiting && <span className="fv3-toolstatus ok">✓ 已回答</span>}
        </div>
        {b.context && <div className="fv3-toolresult" style={{ opacity: 0.75 }}>{b.context}</div>}
        {b.awaiting && b.options && b.options.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {b.options.map((o, i) => (
              <button key={i} className="fv3-btn" onClick={() => onAnswer?.(o.value || o.label)} style={{ fontSize: 12, padding: "4px 10px" }}>{o.label}</button>
            ))}
          </div>
        )}
        {b.awaiting && <div className="fv3-toolresult" style={{ opacity: 0.6, marginTop: 6 }}>{b.options?.length ? "点选项，或在下方输入框直接回答" : "在下方输入框回答即可"}</div>}
      </div>
    );
    case "message": return <div className="fv3-assistant"><Markdown>{b.text}</Markdown></div>;
    case "error": return <div className="fv3-errcard">⚠ {b.message}</div>;
  }
}

// The boundary-event decision card (option A): the AI proposes a classification for
// each dangling event; the user confirms / adjusts the kind (external handoff / terminal
// / real break) and supplements the external contract. Submit posts the decision through
// the HITL mailbox to the parked conductor.
function BoundaryCard({ proposals, awaiting, onSubmit }: { proposals: BoundaryProposal[]; awaiting: boolean; onSubmit?: (events: BoundaryEvent[]) => void }) {
  const [rows, setRows] = React.useState<BoundaryEvent[]>(() =>
    proposals.map((p) => ({ event: p.event, kind: p.suggestedKind, consumer: p.consumer ?? "", payloadContract: p.payloadContract ?? "" })),
  );
  const [sent, setSent] = React.useState(false);
  const set = (i: number, patch: Partial<BoundaryEvent>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const submit = () => { if (!onSubmit) return; setSent(true); onSubmit(rows); };
  const pending = awaiting && !sent;
  return (
    <div className={`fv3-tccard ${pending ? "pending" : ""}`}>
      <div className="fv3-tchead"><span className="fv3-cardico">{Ic.branch({ width: 13, height: 13 })}</span><b>这些事件没有内部消费者</b> · 你来判断{pending ? "" : "（已提交）"}</div>
      <div className="fv3-bdlist">
        {proposals.map((p, i) => (
          <div key={p.event} className="fv3-bditem">
            <div className="fv3-bdhd"><code>{p.event}</code>{p.producers.length ? <span className="fv3-bdfrom">来自 {p.producers.join("、")}</span> : null}</div>
            {p.why && <div className="fv3-bdwhy">{p.why}</div>}
            <div className="fv3-bdseg">
              {(["external", "terminal", "break"] as const).map((k) => (
                <button key={k} disabled={!pending} className={`fv3-bdseg-btn ${rows[i].kind === k ? "on" : ""} ${k}`} onClick={() => set(i, { kind: k })}>
                  {k === "external" ? "外部交接" : k === "terminal" ? "终态" : "真断点"}
                </button>
              ))}
            </div>
            {rows[i].kind === "external" && (
              <div className="fv3-bdext">
                <input className="fv3-bdinput" disabled={!pending} placeholder="外部消费方（平台/服务/团队）" value={rows[i].consumer ?? ""} onChange={(e) => set(i, { consumer: e.target.value })} />
                <input className="fv3-bdinput" disabled={!pending} placeholder="payload 契约（外部方会拿到哪些字段）" value={rows[i].payloadContract ?? ""} onChange={(e) => set(i, { payloadContract: e.target.value })} />
              </div>
            )}
          </div>
        ))}
      </div>
      {pending && onSubmit && (
        <div className="fv3-tcacts"><button className="fv3-tcbtn run" onClick={submit}>{Ic.check({ width: 13, height: 13 })} 确认分类</button></div>
      )}
      {pending && <div className="fv3-tcwait">确认后：外部交接/终态不再算断点，AI 会把外部交接总结成对外契约；真断点会去修。</div>}
    </div>
  );
}

const FV3_CSS = `
.fv3-root{--soft:color-mix(in oklch,var(--c-ink-3) 14%,transparent);display:grid;grid-template-columns:244px 1fr 360px;height:100%;min-height:0;overflow:hidden;background:var(--c-bg);color:var(--c-ink-1);font-size:13.5px;-webkit-font-smoothing:antialiased}
.fv3-root *{box-sizing:border-box}
.fv3-left{background:color-mix(in oklch,var(--c-surface) 45%,var(--c-bg));border-right:1px solid var(--c-line);padding:18px 13px;overflow-y:auto}
.fv3-brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.fv3-logo{width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,var(--c-accent),var(--c-ok));display:grid;place-items:center;font-weight:800;font-size:12px;color:#08121f;box-shadow:0 2px 8px color-mix(in oklch,var(--c-accent) 30%,transparent)}
.fv3-brand b{font-size:14px;letter-spacing:-.01em}.fv3-brand small{display:block;color:var(--c-ink-3);font-size:10.5px;margin-top:1px}
.fv3-grp{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--c-ink-3);margin:18px 6px 7px;font-weight:600}
.fv3-sess{display:flex;align-items:center;width:100%;text-align:left;gap:7px;color:var(--c-ink-2);font-size:13px;padding:8px 11px;border-radius:9px;border:1px solid transparent;background:none;cursor:pointer;margin-bottom:2px;transition:background .12s}
.fv3-sess:hover{background:var(--c-surface)}.fv3-sess:disabled{opacity:.45;cursor:default}
.fv3-sess.on{background:var(--c-surface);color:var(--c-ink-1);font-weight:500;box-shadow:inset 2px 0 0 var(--c-accent)}
.fv3-domtag{margin-left:auto;font-size:9.5px;color:var(--c-ink-3);font-family:ui-monospace,Menlo,monospace}
.fv3-sess.on .fv3-domtag{color:var(--c-ok)}
.fv3-mini{font-size:12px;color:var(--c-ink-2);padding:0 11px}
.fv3-step{padding:3px 0}
.fv3-newsess{display:block;width:calc(100% - 16px);margin:6px 8px 2px;background:var(--c-accent-bg);color:var(--c-accent);border:1px solid var(--soft);border-radius:9px;padding:7px 10px;font-weight:600;font-size:12px;cursor:pointer;text-align:left;transition:background .12s}
.fv3-newsess:hover:not(:disabled){background:var(--c-line)}
.fv3-newsess:disabled{opacity:.5;cursor:default}
.fv3-activity{display:flex;align-items:center;gap:2px;color:var(--c-ink-2);font-size:13px;margin:8px 0;padding:8px 12px;background:var(--c-surface);border:1px solid var(--soft);border-radius:11px;font-style:italic;max-width:80%}
.fv3-feedhint{color:var(--c-ink-3,var(--c-ink-2));font-size:12px;margin:12px 0 4px;opacity:.7}
.fv3-draft{display:flex;align-items:center;gap:7px;padding:7px 11px;border-radius:9px;background:var(--c-surface);border:1px solid var(--soft);margin-bottom:4px}
.fv3-draftname{font-size:12.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fv3-empty{font-size:12px;color:var(--c-ink-3);padding:6px 11px;line-height:1.6}
.fv3-hist{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 11px;border-radius:9px;border:1px solid transparent;background:none;cursor:pointer;margin-bottom:2px;transition:background .12s}
.fv3-hist:hover{background:var(--c-surface)}.fv3-hist:disabled{opacity:.45;cursor:default}
.fv3-hist.on{background:var(--c-surface);box-shadow:inset 2px 0 0 var(--c-accent)}
.fv3-histdot{width:7px;height:7px;border-radius:999px;flex:none;background:var(--c-ink-3)}
.fv3-histdot.ok{background:var(--c-ok)}.fv3-histdot.err{background:#e5484d}.fv3-histdot.run{background:var(--c-accent);animation:fv3pulse 1.2s infinite}.fv3-histdot.warn{background:oklch(0.72 0.15 75)}
.fv3-histmeta{display:flex;flex-direction:column;font-size:12px;color:var(--c-ink-2);line-height:1.35;min-width:0}
.fv3-histmeta small{font-size:10.5px;color:var(--c-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@keyframes fv3pulse{0%,100%{opacity:1}50%{opacity:.35}}
.fv3-chip.viewing{display:inline-flex;align-items:center;gap:8px;color:var(--c-accent);border-color:var(--c-accent)}
.fv3-exitview{background:var(--c-accent);color:#08121f;border:none;border-radius:999px;padding:2px 10px;font-size:11px;cursor:pointer;font-weight:600}
.fv3-regen{background:var(--c-surface);color:var(--c-ink-1);border:1px solid var(--soft);border-radius:13px;padding:11px 16px;font-weight:500;font-size:13px;cursor:pointer;transition:background .12s}
.fv3-regen:hover{background:var(--c-line)}
.fv3-center{display:flex;flex-direction:column;min-width:0;min-height:0;position:relative;background:var(--c-bg)}
.fv3-head{display:flex;align-items:center;gap:9px;padding:15px 26px;border-bottom:1px solid var(--c-line)}
.fv3-crumb{font-size:13px;color:var(--c-ink-2);font-weight:500}
.fv3-chip{margin-left:auto;font-size:11.5px;color:var(--c-ink-2);background:var(--c-surface);border:1px solid var(--soft);border-radius:999px;padding:4px 13px}
.fv3-feed{flex:1;overflow-y:auto;padding:28px 30px 44px;display:flex;flex-direction:column;gap:15px;max-width:768px;width:100%;margin:0 auto}
.fv3-userbubble{align-self:flex-end;background:var(--c-accent);color:#08121f;border-radius:17px 17px 5px 17px;padding:11px 17px;font-size:13.5px;font-weight:500;max-width:82%;line-height:1.55}
.fv3-hint{color:var(--c-ink-2);font-size:13.5px;line-height:1.8;background:var(--c-surface);border:1px solid var(--soft);border-radius:16px;padding:18px 20px}
/* Empty/ready-state hero — vertically centered; replaces the old fake-sent goal
   bubble + one-line hint so the first impression is a real landing, not a stalled
   conversation. Example goals fill the composer on click. */
.fv3-hero{margin:auto;display:flex;flex-direction:column;align-items:center;text-align:center;gap:13px;max-width:540px;padding:32px 20px;animation:fv3rise .4s cubic-bezier(.22,1,.36,1) both}
.fv3-herologo{width:54px;height:54px;border-radius:16px;background:linear-gradient(135deg,var(--c-accent),var(--c-ok));display:grid;place-items:center;font-size:25px;box-shadow:0 8px 26px color-mix(in oklch,var(--c-accent) 32%,transparent)}
.fv3-herotitle{font-size:22px;font-weight:600;letter-spacing:-.015em;margin:2px 0 0;color:var(--c-ink-1)}
.fv3-herosub{font-size:13.5px;color:var(--c-ink-2);line-height:1.75;margin:0}.fv3-herosub strong{color:var(--c-ink-1);font-weight:600}
.fv3-pipeline{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:center;margin:4px 0 2px}
.fv3-pipestep{font-size:11.5px;color:var(--c-ink-2);background:var(--c-surface);border:1px solid var(--soft);border-radius:999px;padding:4px 12px;white-space:nowrap}
.fv3-pipearrow{color:var(--c-ink-4);font-size:11px}
.fv3-egwrap2{display:flex;flex-direction:column;gap:8px;margin-top:12px;width:100%}
.fv3-eglabel2{font-size:10.5px;color:var(--c-ink-3);text-transform:uppercase;letter-spacing:.08em;font-weight:600;text-align:left}
.fv3-egchip{text-align:left;font-size:13px;color:var(--c-ink-1);background:var(--c-surface);border:1px solid var(--soft);border-radius:12px;padding:11px 14px;cursor:pointer;transition:border-color .14s,background .14s,transform .1s;line-height:1.5}
.fv3-egchip:hover{border-color:color-mix(in oklch,var(--c-accent) 45%,transparent);background:var(--c-accent-bg)}
.fv3-egchip:active{transform:translateY(1px)}
.fv3-think{color:var(--c-ink-2);font-size:13.5px;line-height:1.8;white-space:pre-wrap;padding:3px 0 3px 18px;border-left:2px solid color-mix(in oklch,var(--c-accent) 40%,var(--c-line))}
.fv3-think.streaming{color:var(--c-ink-1)}
.fv3-cursor{color:var(--c-accent);animation:fv3blink 1.1s steps(1) infinite;font-weight:700;margin-left:18px;font-size:15px}
@keyframes fv3blink{50%{opacity:0}}
.fv3-toolcard{border:1px solid var(--soft);border-radius:13px;background:var(--c-surface);overflow:hidden;transition:border-color .15s}
.fv3-toolcard:hover{border-color:color-mix(in oklch,var(--c-ink-3) 24%,transparent)}
.fv3-toolhead{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:12px 15px;background:none;border:none;cursor:pointer}
.fv3-toolreason{flex:1;font-size:13.5px;color:var(--c-ink-1);line-height:1.5}
.fv3-toolstatus{font-size:14px;color:var(--c-ok);flex:none}.fv3-toolstatus.warn{color:var(--c-warn)}.fv3-toolstatus.run{color:var(--c-accent);animation:fv3pulse 1.2s infinite}
.fv3-toolresult{padding:10px 15px;font-size:12.5px;color:var(--c-ink-2);border-top:1px solid var(--soft);line-height:1.55}
.fv3-toolinput{margin:0;padding:11px 15px;background:var(--c-bg);border-top:1px solid var(--soft);font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--c-ink-3);white-space:pre-wrap;max-height:220px;overflow:auto;line-height:1.5}
.fv3-egwrap{display:flex;flex-direction:column;gap:8px}
.fv3-eg{width:100%;height:auto;background:var(--c-bg);border:1px solid var(--soft);border-radius:12px;padding:6px}
.fv3-egnode rect{fill:color-mix(in oklch,var(--c-ok) 12%,var(--c-surface));stroke:color-mix(in oklch,var(--c-ok) 50%,transparent);stroke-width:1.4}
.fv3-egnode.ghost rect{fill:var(--c-surface);stroke:var(--c-line);stroke-dasharray:4 3}
.fv3-egnode .fv3-egnodetext{font-size:12px;font-weight:600;fill:var(--c-ink-1)}
.fv3-egnode.ghost .fv3-egnodetext{fill:var(--c-ink-2)}
.fv3-egnode.built{animation:fv3pop .35s ease}
@keyframes fv3pop{from{opacity:.3}to{opacity:1}}
.fv3-eglabel{font-size:9.5px;fill:var(--c-ink-2);font-family:ui-monospace,Menlo,monospace}
.fv3-eglegend{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--c-ink-2)}
.fv3-eglegend>div{display:flex;align-items:center;gap:6px}
.fv3-egdot{width:8px;height:8px;border-radius:3px;flex-shrink:0}
.fv3-egdot.entry{background:var(--c-accent)}.fv3-egdot.term{background:var(--c-bad,#ff7a8a)}.fv3-egdot.ghost{background:transparent;border:1.5px dashed var(--c-line);border-radius:2px}
.fv3-egdot.agent{background:color-mix(in oklch,var(--c-accent) 55%,transparent);border:1px solid var(--c-accent)}.fv3-egdot.event{background:var(--c-surface);border:1px solid var(--c-soft)}
/* enhanced event graph — agents + events + terminals as distinct nodes */
.fv3-egwrap.full{height:100%}
.fv3-cgagent rect{fill:color-mix(in oklch,var(--c-accent) 13%,var(--c-surface));stroke:color-mix(in oklch,var(--c-accent) 55%,transparent);stroke-width:1.5}
.fv3-cgagent.ghost rect{fill:var(--c-surface);stroke:var(--c-line);stroke-dasharray:4 3}
.fv3-cgagent.built{animation:fv3pop .35s ease}
.fv3-cgatitle{font-size:12px;font-weight:700;fill:var(--c-ink-1)}
.fv3-cgasub{font-size:8.5px;fill:var(--c-ink-3);font-family:ui-monospace,Menlo,monospace}
.fv3-cgevent rect{fill:var(--c-surface);stroke:var(--c-line);stroke-width:1.2}
.fv3-cgevent.entry rect{fill:color-mix(in oklch,var(--c-ink-3) 8%,var(--c-surface));stroke:var(--c-soft)}
.fv3-cgevent.fail rect,.fv3-cgevent.term rect{fill:color-mix(in oklch,var(--c-bad,#ff7a8a) 11%,var(--c-surface));stroke:color-mix(in oklch,var(--c-bad,#ff7a8a) 55%,transparent)}
.fv3-cgetext{font-size:9.5px;fill:var(--c-ink-2);font-family:ui-monospace,Menlo,monospace;font-weight:600}
.fv3-cgevent.fail .fv3-cgetext,.fv3-cgevent.term .fv3-cgetext{fill:var(--c-bad,#ff7a8a)}
/* success terminal = green (happy-path end), distinct from failure branches */
.fv3-cgevent.success rect{fill:color-mix(in oklch,var(--c-ok) 12%,var(--c-surface));stroke:color-mix(in oklch,var(--c-ok) 52%,transparent)}
.fv3-cgevent.success .fv3-cgetext{fill:color-mix(in oklch,var(--c-ok) 78%,var(--c-ink-1))}
/* orphan = validator-flagged 悬空 emit (produced, no consumer, not a known terminal) */
.fv3-cgevent.orphan rect{fill:color-mix(in oklch,var(--c-bad,#ff7a8a) 9%,var(--c-surface));stroke:var(--c-bad,#ff7a8a);stroke-dasharray:4 3}
.fv3-cgevent.orphan .fv3-cgetext{fill:var(--c-bad,#ff7a8a)}
/* payload gap — event is structurally fine but a consumer needs a field no producer writes */
.fv3-cgevent.gap rect{fill:color-mix(in oklch,var(--c-warn,#f5b556) 12%,var(--c-surface));stroke:var(--c-warn,#f5b556);stroke-width:1.6;stroke-dasharray:none}
.fv3-cgevent.gap .fv3-cgetext{fill:color-mix(in oklch,var(--c-warn,#f5b556) 80%,var(--c-ink-1))}
.fv3-egdot.success{background:color-mix(in oklch,var(--c-ok) 55%,transparent);border:1px solid var(--c-ok)}
.fv3-egdot.orphan{background:transparent;border:1.5px dashed var(--c-bad,#ff7a8a)}
.fv3-egdot.gap{background:color-mix(in oklch,var(--c-warn,#f5b556) 50%,transparent);border:1px solid var(--c-warn,#f5b556)}
.fv3-egcontract{font-size:11.5px;color:var(--c-bad,#ff7a8a);background:color-mix(in oklch,var(--c-bad,#ff7a8a) 7%,transparent);border:1px solid color-mix(in oklch,var(--c-bad,#ff7a8a) 25%,transparent);border-radius:8px;padding:7px 10px;line-height:1.5;margin-top:2px}
.fv3-egcontracthint{color:var(--c-ink-3);font-size:10.5px}
/* harness plane — main brain + the sub-agent tree it spawns (kind-1 agents) */
.fv3-harness{display:flex;flex-direction:column;gap:10px}
.fv3-hnode{border:1px solid var(--c-line);border-radius:12px;padding:12px 14px;background:var(--c-surface);position:relative}
.fv3-hnode.root{border-color:color-mix(in oklch,var(--c-accent) 40%,var(--c-line));background:color-mix(in oklch,var(--c-accent) 5%,var(--c-surface))}
.fv3-hnode.child{margin-left:24px}
.fv3-hconn{position:absolute;left:-16px;top:-8px;width:14px;height:28px;border-left:1.5px solid var(--c-line);border-bottom:1.5px solid var(--c-line);border-bottom-left-radius:8px}
.fv3-hhead{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:var(--c-ink-1);flex-wrap:wrap}
.fv3-hbadge{font-size:10px;font-weight:600;color:var(--c-accent);background:color-mix(in oklch,var(--c-accent) 12%,transparent);border:1px solid color-mix(in oklch,var(--c-accent) 30%,transparent);border-radius:6px;padding:1px 7px}
.fv3-hbadge.sub{color:var(--c-ink-2);background:color-mix(in oklch,var(--c-ink-3) 10%,transparent);border-color:var(--c-line)}
.fv3-hmeta{font-size:11.5px;color:var(--c-ink-3);margin-top:5px;font-family:ui-monospace,Menlo,monospace}
.fv3-hgoal{font-size:12.5px;color:var(--c-ink-2);margin-top:6px;line-height:1.5}
.fv3-hsummary{font-size:12px;color:var(--c-ink-2);margin-top:6px;line-height:1.5;border-left:2px solid var(--c-line);padding-left:8px}
.fv3-htools{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.fv3-htool{font-size:10.5px;color:var(--c-ink-2);background:var(--c-bg);border:1px solid var(--c-line);border-radius:6px;padding:2px 7px;font-family:ui-monospace,Menlo,monospace}
.fv3-htool i{color:var(--c-ink-3);font-style:normal}
.fv3-hcaps{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.fv3-hcap{font-size:11px;border-radius:6px;padding:2px 8px;border:1px solid}
.fv3-hcap.skill{color:oklch(.74 .13 250);background:color-mix(in oklch,oklch(.74 .13 250) 9%,transparent);border-color:color-mix(in oklch,oklch(.74 .13 250) 28%,transparent)}
.fv3-hcap.tool{color:var(--c-ok);background:color-mix(in oklch,var(--c-ok) 9%,transparent);border-color:color-mix(in oklch,var(--c-ok) 28%,transparent)}
/* internal-agent viz: work-loop SVG + run trace + implementation code */
.fv3-hviewbar{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.fv3-hview{font-size:11.5px;color:var(--c-ink-2);background:var(--c-bg);border:1px solid var(--c-line);border-radius:7px;padding:3px 10px;cursor:pointer;transition:color .12s}
.fv3-hview:hover{color:var(--c-ink-1);border-color:var(--c-soft)}
.fv3-hview.on{color:var(--c-accent);border-color:color-mix(in oklch,var(--c-accent) 45%,transparent);background:color-mix(in oklch,var(--c-accent) 8%,transparent)}
.fv3-hloop{width:100%;height:auto;margin-top:10px;background:var(--c-bg);border:1px solid var(--soft);border-radius:10px;padding:4px}
.fv3-hlstage rect{fill:color-mix(in oklch,var(--c-accent) 12%,var(--c-surface));stroke:color-mix(in oklch,var(--c-accent) 45%,transparent);stroke-width:1.3}
.fv3-hlstage.off rect{fill:var(--c-surface);stroke:var(--c-line);stroke-dasharray:3 3}
.fv3-hltext{font-size:11px;font-weight:600;fill:var(--c-ink-1)}
.fv3-hlsub{font-size:8.5px;fill:var(--c-ink-3);font-family:ui-monospace,Menlo,monospace}
.fv3-hlstage.off .fv3-hltext{fill:var(--c-ink-3)}
.fv3-hlooplbl{font-size:9px;fill:var(--c-warn,#f5b556);font-weight:600}
.fv3-htrace{margin-top:10px;display:flex;flex-direction:column;gap:3px;max-height:320px;overflow-y:auto}
.fv3-htracerow{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--c-ink-2)}
.fv3-htracei{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;background:color-mix(in oklch,var(--c-accent) 12%,transparent);color:var(--c-accent);font-size:10px;font-weight:600;flex-shrink:0}
.fv3-hcode{margin-top:10px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.55;color:var(--c-ink-1);background:var(--c-bg);border:1px solid var(--c-line);border-radius:10px;padding:12px;white-space:pre;overflow-x:auto}
/* live brain-activity radial graph (concern 4) */
.fv3-bawrap{display:flex;flex-direction:column;gap:8px}
.fv3-bawrap.full{height:100%}
.fv3-ba{width:100%;height:auto;background:var(--c-bg);border:1px solid var(--soft);border-radius:12px;padding:4px}
.fv3-bacenter circle{fill:color-mix(in oklch,var(--c-accent) 16%,var(--c-surface));stroke:var(--c-accent);stroke-width:2}
.fv3-bacenter.live circle{animation:fv3baPulse 1.8s ease-in-out infinite}
@keyframes fv3baPulse{0%,100%{stroke-width:2}50%{stroke-width:4.5}}
.fv3-bactitle{font-size:14px;font-weight:700;fill:var(--c-ink-1)}
.fv3-bacsub{font-size:10px;fill:var(--c-ink-3)}
.fv3-banode{animation:fv3baPop .42s cubic-bezier(.2,1.3,.5,1) both;transform-box:fill-box;transform-origin:center}
@keyframes fv3baPop{from{opacity:0;transform:scale(.35)}to{opacity:1;transform:scale(1)}}
.fv3-banode rect{fill:color-mix(in oklch,var(--bac) 13%,var(--c-surface));stroke:var(--bac);stroke-width:1.5}
.fv3-bant{font-size:11px;font-weight:600;fill:var(--c-ink-1)}
.fv3-bans{font-size:8px;fill:var(--c-ink-3);font-family:ui-monospace,Menlo,monospace}
.fv3-balegend{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--c-ink-2)}
.fv3-balegend>div{display:flex;align-items:center;gap:5px}
.fv3-badot{width:9px;height:9px;border-radius:3px;flex-shrink:0;display:inline-block}
/* fullscreen overlay */
.fv3-full{position:fixed;inset:0;z-index:1000;background:rgba(12,16,26,.62);display:flex;align-items:center;justify-content:center;padding:24px;animation:fv3fade .15s ease}
@keyframes fv3fade{from{opacity:0}to{opacity:1}}
.fv3-fullinner{background:var(--c-bg);border:1px solid var(--c-line);border-radius:16px;width:min(1200px,96vw);height:min(900px,94vh);display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,.45)}
.fv3-fullhead{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--c-line)}
.fv3-fulltitle{font-size:15px;font-weight:600;color:var(--c-ink-1)}
.fv3-fullx{margin-left:auto;border:1px solid var(--c-line);background:var(--c-surface);color:var(--c-ink-2);border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:13px}
.fv3-fullx:hover{color:var(--c-ink-1);border-color:var(--c-soft)}
.fv3-fullbody{flex:1;overflow:auto;padding:20px}
.fv3-fullbody .fv3-eg{max-height:none}
.fv3-fullpre{white-space:pre-wrap;word-break:break-word;font-size:14.5px;line-height:1.75;color:var(--c-ink-1);font-family:-apple-system,system-ui,"PingFang SC",sans-serif;margin:0}
.fv3-fullpre.code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;white-space:pre;background:var(--c-surface);border:1px solid var(--c-line);border-radius:10px;padding:16px;line-height:1.6}
.fv3-fullbar{display:flex;justify-content:flex-end;margin-bottom:6px}
.fv3-fullbtn{font-size:11.5px;color:var(--c-ink-2);background:var(--c-surface);border:1px solid var(--c-line);border-radius:7px;padding:4px 10px;cursor:pointer;transition:color .12s}
.fv3-fullbtn:hover{color:var(--c-ink-1);border-color:var(--c-soft)}
.fv3-fullbtn.sm{padding:2px 8px;font-size:11px}
.fv3-viewpane{display:flex;flex-direction:column;gap:5px;margin-top:6px}
.fv3-panebar{display:flex;gap:6px;justify-content:flex-end}
.fv3-toolsfull{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}
.fv3-toolfullcard{border:1px solid var(--c-line);border-radius:11px;padding:12px 14px;background:var(--c-surface)}
.fv3-toolfullhead{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.fv3-toolfullname{font-size:13.5px;font-weight:600;color:var(--c-ink-1)}
.fv3-toolfullid{font-size:11px;color:var(--c-ink-3);font-family:ui-monospace,Menlo,monospace;margin-left:auto}
.fv3-toolfulldesc{font-size:12.5px;color:var(--c-ink-2);line-height:1.5;margin-bottom:5px}
.fv3-toolfullsig{font-size:11px;color:var(--c-ink-3);font-family:ui-monospace,Menlo,monospace}
.fv3-pill{font-size:10px;font-weight:700;color:#08121f;background:var(--c-accent);border-radius:6px;padding:3px 8px;white-space:nowrap;letter-spacing:.01em}
.fv3-pill.t-validate_graph,.fv3-pill.t-validate,.fv3-pill.t-design_agent{background:var(--c-ok)}.fv3-pill.t-sandbox_run{background:oklch(.7 .14 300)}.fv3-pill.t-finish{background:var(--c-ink-3)}.fv3-pill.t-create_skill,.fv3-pill.t-create_tool{background:oklch(.74 .13 250)}.fv3-pill.t-web_search{background:oklch(.72 .12 200)}
.fv3-agentcard{border:1px solid color-mix(in oklch,var(--c-ok) 24%,transparent);border-radius:13px;background:color-mix(in oklch,var(--c-ok) 7%,var(--c-surface));padding:13px 16px}
.fv3-achead{font-size:14.5px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.fv3-achead code{font-size:10px;color:var(--c-ink-3);font-family:ui-monospace,Menlo,monospace}
.fv3-acmeta{font-size:11px;color:var(--c-ink-3);margin:5px 0 8px;font-family:ui-monospace,Menlo,monospace}
.fv3-gtools{display:flex;flex-wrap:wrap;gap:5px}
.fv3-missing{margin-top:7px;font-size:11px;color:var(--c-warn);display:flex;flex-wrap:wrap;gap:5px;align-items:center;line-height:1.5}
.fv3-misstool{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--c-warn);background:color-mix(in oklch,var(--c-warn) 14%,transparent);border:1px solid color-mix(in oklch,var(--c-warn) 30%,transparent);border-radius:6px;padding:1px 6px}
.fv3-designtoggle{margin-top:9px;font-size:11px;color:var(--c-accent);background:none;border:none;cursor:pointer;padding:0;text-align:left}
.fv3-design{margin-top:8px;border-top:1px dashed var(--soft);padding-top:9px;display:flex;flex-direction:column;gap:9px}
.fv3-dsec{display:flex;flex-direction:column;gap:3px}
.fv3-dlabel{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--c-ink-3);font-weight:600}
.fv3-dbody{font-size:12px;color:var(--c-ink-2);line-height:1.65;white-space:pre-wrap}
.fv3-dprompt{font-size:11px;color:var(--c-ink-2);background:var(--c-bg);border:1px solid var(--soft);border-radius:8px;padding:9px 11px;white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;line-height:1.55;max-height:240px;overflow:auto;margin:0}
.fv3-dcode{font-size:11px;color:var(--c-ink-1);background:#0d1117;border:1px solid var(--soft);border-radius:8px;padding:11px 13px;white-space:pre;font-family:ui-monospace,Menlo,monospace;line-height:1.5;max-height:380px;overflow:auto;margin:0}
[data-theme="light"] .fv3-dcode{background:#1b1f23;color:#e6edf3}
.fv3-copycode{margin-left:8px;font-size:10px;text-transform:none;letter-spacing:0;color:var(--c-accent);background:none;border:1px solid var(--soft);border-radius:5px;padding:1px 7px;cursor:pointer}
.fv3-tool{font-size:10px;font-family:ui-monospace,Menlo,monospace;color:var(--c-accent);background:var(--c-bg);border:1px solid var(--soft);border-radius:6px;padding:2px 6px}
.fv3-valid{font-size:13px;border-radius:11px;padding:9px 14px}
.fv3-valid.ok{color:var(--c-ok);background:color-mix(in oklch,var(--c-ok) 11%,transparent)}
.fv3-valid.warn{color:var(--c-warn);background:color-mix(in oklch,var(--c-warn) 11%,transparent)}
.fv3-sandboxcard{font-size:13.5px;border-radius:13px;padding:13px 16px;border:1px solid var(--soft);line-height:1.5}
.fv3-plancard{border:1px solid var(--soft);border-radius:13px;padding:13px 16px;background:color-mix(in oklch,var(--c-accent) 7%,var(--c-bg))}
.fv3-planhead{display:flex;align-items:center;gap:8px;font-size:14px}
.fv3-plansum{font-size:13px;color:var(--c-ink-2);margin-top:6px;line-height:1.6}
.fv3-planlist{margin-top:10px;display:flex;flex-direction:column;gap:4px}
.fv3-planrow{font-size:12px;color:var(--c-ink-2);line-height:1.55}
.fv3-planmore{font-size:11px;color:var(--c-ink-3)}
.fv3-refinecard{font-size:13px;border-radius:11px;padding:9px 14px;border:1px solid color-mix(in oklch,var(--c-warn) 26%,transparent);background:color-mix(in oklch,var(--c-warn) 7%,var(--c-bg));line-height:1.55}
.fv3-refinemeta{color:var(--c-ink-3);font-size:11.5px}
.fv3-inspectcard{font-size:13px;border-radius:11px;padding:9px 14px;border:1px solid var(--soft);background:var(--c-bg);line-height:1.55;font-family:ui-monospace,Menlo,monospace}
.fv3-inspectcard.warn{border-color:color-mix(in oklch,var(--c-warn) 35%,transparent);background:color-mix(in oklch,var(--c-warn) 8%,var(--c-bg))}
.fv3-inspecterr{font-size:11px;color:var(--c-warn);margin-top:4px;white-space:pre-wrap;line-height:1.5}
.fv3-reflectcard{font-size:13px;border-radius:11px;padding:9px 14px;border:1px solid color-mix(in oklch,var(--c-ok) 30%,transparent);background:color-mix(in oklch,var(--c-ok) 7%,var(--c-bg));line-height:1.55}
.fv3-reflectmeta{color:var(--c-ink-3);font-size:11px}
.fv3-badge.warn{color:var(--c-warn);background:color-mix(in oklch,var(--c-warn) 14%,transparent);border-color:color-mix(in oklch,var(--c-warn) 30%,transparent)}
.fv3-sboxprog{font-size:12px;font-family:ui-monospace,Menlo,monospace;color:var(--c-ink-2);border-radius:9px;padding:6px 12px;border:1px dashed var(--soft);background:color-mix(in oklch,var(--c-accent) 5%,var(--c-bg));display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
.fv3-sboxprog.settled{border-style:solid;background:color-mix(in oklch,var(--c-ok) 7%,var(--c-bg));color:var(--c-ok)}
.fv3-sboxphase{font-weight:700;color:var(--c-accent);text-transform:uppercase;letter-spacing:.07em;font-size:10px}
.fv3-sboxprog.settled .fv3-sboxphase{color:var(--c-ok)}
.fv3-sboxdetail{color:var(--c-ink-2)}
.fv3-sboxnums{color:var(--c-ink-3);font-size:11px;margin-left:auto}

/* Knowledge Ledger (R2-7) */
.fv3-budgetbar{padding:9px 11px;border:1px solid var(--soft);border-radius:9px;background:var(--c-bg);display:flex;flex-direction:column;gap:6px}
.fv3-budgetrow{display:flex;justify-content:space-between;font-size:11.5px;color:var(--c-ink-2)}
.fv3-bar{height:4px;background:var(--soft);border-radius:3px;overflow:hidden}
.fv3-bar-fg{display:block;height:100%;background:var(--c-accent);border-radius:3px;transition:width 200ms}
.fv3-bar-fg.elevated{background:var(--c-warn,#f5b556)}.fv3-bar-fg.high{background:var(--c-bad,#ff7a8a)}
.fv3-costchip{font-size:10px;font-weight:600;border-radius:6px;padding:1px 7px;margin-left:8px}
.fv3-costchip.elevated{color:var(--c-warn,#f5b556);background:color-mix(in oklch,var(--c-warn,#f5b556) 12%,transparent);border:1px solid color-mix(in oklch,var(--c-warn,#f5b556) 30%,transparent)}
.fv3-costchip.high{color:var(--c-bad,#ff7a8a);background:color-mix(in oklch,var(--c-bad,#ff7a8a) 12%,transparent);border:1px solid color-mix(in oklch,var(--c-bad,#ff7a8a) 30%,transparent)}
.fv3-costnote{font-size:11.5px;color:var(--c-warn,#f5b556);line-height:1.5;margin-top:2px}
.fv3-kledger{border:1px solid var(--soft);border-radius:9px;background:var(--c-bg);padding:8px 12px;margin-top:6px}
.fv3-klhead{font-size:12.5px;color:var(--c-ink-1);display:flex;gap:8px;align-items:baseline}
.fv3-klmeta{font-size:10px;color:var(--c-ink-3);font-family:ui-monospace,Menlo,monospace}
.fv3-klbody{font-size:11.5px;color:var(--c-ink-2);margin-top:3px;line-height:1.5}
.fv3-kldiff{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.fv3-dchip{font-family:ui-monospace,Menlo,monospace;font-size:10px;padding:1px 5px;border-radius:5px;background:color-mix(in oklch,var(--c-ink-3) 12%,transparent);color:var(--c-ink-2);border:1px solid var(--soft)}
.fv3-dchip.add{color:var(--c-ok);background:color-mix(in oklch,var(--c-ok) 12%,transparent);border-color:color-mix(in oklch,var(--c-ok) 28%,transparent)}
.fv3-dchip.rem{color:var(--c-warn);background:color-mix(in oklch,var(--c-warn) 12%,transparent);border-color:color-mix(in oklch,var(--c-warn) 28%,transparent)}
.fv3-rkind{font-family:ui-monospace,Menlo,monospace;font-size:10px;padding:1px 5px;border-radius:5px;background:var(--soft);color:var(--c-ink-2)}
.fv3-rkind.success{color:var(--c-ok);background:color-mix(in oklch,var(--c-ok) 12%,transparent)}
.fv3-rkind.failure{color:var(--c-warn);background:color-mix(in oklch,var(--c-warn) 14%,transparent)}
.fv3-rkind.caveat{color:var(--c-accent);background:var(--c-accent-bg)}
.fv3-sandboxcard.ok{color:var(--c-ok);background:color-mix(in oklch,var(--c-ok) 13%,transparent);border-color:color-mix(in oklch,var(--c-ok) 28%,transparent)}
.fv3-sandboxcard.warn{color:var(--c-warn);background:color-mix(in oklch,var(--c-warn) 11%,transparent)}
.fv3-sandboxcard.err{color:#e5484d;background:color-mix(in oklch,#e5484d 11%,transparent);border-color:color-mix(in oklch,#e5484d 28%,transparent)}
.fv3-app{font-size:11px;font-family:ui-monospace,Menlo,monospace;background:var(--c-bg);border:1px solid var(--soft);border-radius:5px;padding:1px 5px;color:var(--c-ink-2)}
.fv3-runlinks{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px;align-items:center}
.fv3-runlink{font-size:10.5px;font-family:ui-monospace,Menlo,monospace;color:var(--c-ink-2);background:var(--c-bg);border:1px solid var(--soft);border-radius:6px;padding:2px 7px;text-decoration:none;transition:border-color .12s}
.fv3-runlink:hover{border-color:var(--c-accent);color:var(--c-ink-1)}
.fv3-runlink.ok{color:var(--c-ok)}.fv3-runlink.err{color:#e5484d}
.fv3-runhint{font-size:10px;color:var(--c-ink-3)}
.fv3-webcard{border:1px solid var(--soft);border-radius:13px;background:var(--c-surface);padding:12px 15px}
.fv3-webhead{font-size:13px;color:var(--c-ink-2);margin-bottom:8px;font-weight:500}
.fv3-webrow{font-size:12px;margin:6px 0;display:flex;flex-direction:column;gap:2px}
.fv3-webrow a{color:var(--c-accent);font-weight:500}.fv3-webrow span{color:var(--c-ink-3);line-height:1.5}
.fv3-makecard{font-size:13.5px;border-radius:13px;padding:12px 15px;border:1px solid color-mix(in oklch,var(--c-accent) 22%,transparent);background:color-mix(in oklch,var(--c-accent) 8%,var(--c-surface));line-height:1.5}
.fv3-subcard{font-size:13.5px;border-radius:13px;padding:12px 15px;border:1px solid var(--soft);border-left:3px solid oklch(.7 .14 300);background:var(--c-surface);line-height:1.5}
.fv3-submeta{font-size:12px;color:var(--c-ink-3);margin-top:5px;line-height:1.55}
.fv3-assistant{font-size:14.5px;line-height:1.75;color:var(--c-ink-1);background:var(--c-surface);border:1px solid var(--soft);border-radius:15px;padding:15px 18px}
.fv3-md{white-space:normal}
.fv3-md > :first-child{margin-top:0}
.fv3-md > :last-child{margin-bottom:0}
.fv3-md p{margin:0 0 10px}
.fv3-md h1,.fv3-md h2,.fv3-md h3,.fv3-md h4{margin:15px 0 8px;font-weight:650;line-height:1.35;color:var(--c-ink-1)}
.fv3-md h1{font-size:18px}.fv3-md h2{font-size:16px}.fv3-md h3{font-size:14.5px}.fv3-md h4{font-size:13.5px}
.fv3-md ul,.fv3-md ol{margin:0 0 10px;padding-left:22px}
.fv3-md li{margin:3px 0;line-height:1.7}
.fv3-md li>ul,.fv3-md li>ol{margin:3px 0}
.fv3-md a{color:var(--c-accent);text-decoration:underline}
.fv3-md strong{font-weight:650;color:var(--c-ink-1)}
.fv3-md em{font-style:italic}
.fv3-md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;background:var(--soft);padding:1.5px 5px;border-radius:5px}
.fv3-md pre{background:var(--c-bg);border:1px solid var(--soft);border-radius:9px;padding:11px 13px;overflow-x:auto;margin:0 0 10px}
.fv3-md pre code{background:none;padding:0;font-size:12.5px;line-height:1.6;display:block}
.fv3-md blockquote{margin:0 0 10px;padding:2px 0 2px 12px;border-left:3px solid var(--soft);color:var(--c-ink-2)}
.fv3-md table{border-collapse:collapse;margin:0 0 10px;font-size:13px;display:block;overflow-x:auto}
.fv3-md th,.fv3-md td{border:1px solid var(--soft);padding:5px 9px;text-align:left}
.fv3-md th{background:var(--soft);font-weight:600}
.fv3-md hr{border:none;border-top:1px solid var(--soft);margin:12px 0}
.fv3-errcard{color:var(--c-err);background:color-mix(in oklch,var(--c-err) 11%,transparent);border:1px solid color-mix(in oklch,var(--c-err) 28%,transparent);border-radius:11px;padding:10px 14px;font-size:13px}
.fv3-composer{border-top:1px solid var(--c-line);padding:15px 30px 20px;display:flex;gap:10px;max-width:768px;width:100%;margin:0 auto}
.fv3-jump{position:absolute;left:50%;transform:translateX(-50%);bottom:82px;z-index:6;display:inline-flex;align-items:center;gap:6px;background:var(--c-surface);color:var(--c-ink-1);border:1px solid var(--soft);border-radius:999px;padding:6px 15px;font-size:12px;font-weight:500;cursor:pointer;box-shadow:0 6px 18px color-mix(in oklch,var(--c-ink-1) 16%,transparent);transition:background .12s,transform .12s}
.fv3-jump:hover{background:var(--c-line);transform:translateX(-50%) translateY(-1px)}
.fv3-input{flex:1;background:var(--c-surface);border:1px solid var(--soft);border-radius:13px;padding:11px 16px;color:var(--c-ink-1);font:inherit;font-size:13.5px;outline:none;transition:border-color .12s,box-shadow .12s}
.fv3-input:focus{border-color:var(--c-accent);box-shadow:0 0 0 3px color-mix(in oklch,var(--c-accent) 18%,transparent)}
.fv3-run{background:var(--c-accent);color:#08121f;border:none;border-radius:13px;padding:11px 24px;font-weight:600;font-size:13.5px;cursor:pointer;transition:filter .12s}
.fv3-run:hover:not(:disabled){filter:brightness(1.06)}.fv3-run:disabled{opacity:.55;cursor:default}
.fv3-right{background:color-mix(in oklch,var(--c-surface) 55%,var(--c-bg));border-left:1px solid var(--c-line);display:flex;flex-direction:column;min-width:0;min-height:0}
.fv3-tabs{display:flex;gap:4px;padding:11px 12px 0;border-bottom:1px solid var(--c-line)}
.fv3-tab{flex:1;text-align:center;font-size:12.5px;color:var(--c-ink-3);padding:9px 4px;border:none;background:none;border-bottom:2px solid transparent;cursor:pointer;transition:color .12s}
.fv3-tab:hover{color:var(--c-ink-2)}.fv3-tab.on{color:var(--c-ink-1);font-weight:500;border-bottom-color:var(--c-accent)}
.fv3-tabbody{flex:1;overflow-y:auto;padding:16px 15px;display:flex;flex-direction:column;gap:8px}
.fv3-ititle{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--c-ink-3);font-weight:600;margin-bottom:1px}
.fv3-live{color:var(--c-ok);font-size:10px;margin-left:6px}
.fv3-agentrow{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--c-ink-2);padding:8px 11px;border-radius:9px;background:var(--c-bg);border:1px solid var(--soft)}
.fv3-agnm{flex:1}.fv3-agms{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--c-ink-3)}
.fv3-sub{font-size:10px;font-weight:400;color:var(--c-ink-3);margin-left:6px;text-transform:none;letter-spacing:0}
.fv3-toolrow{display:flex;align-items:center;gap:8px;padding:6px 11px;border-radius:9px;background:var(--c-bg);border:1px solid var(--soft)}
.fv3-se{font-size:9px;font-weight:700;border-radius:5px;padding:2px 5px;flex:none;line-height:1}
.fv3-se.read{color:var(--c-ink-2);background:color-mix(in oklch,var(--c-ink-3) 14%,transparent)}
.fv3-se.write{color:var(--c-warn);background:color-mix(in oklch,var(--c-warn) 16%,transparent)}
.fv3-se.dual-write{color:var(--c-accent);background:var(--c-accent-bg)}
.fv3-toolnm{flex:none;font-size:12.5px;color:var(--c-ink-1);max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fv3-toolid{flex:1;text-align:right;font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--c-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fv3-gcard{border:1px solid var(--soft);border-radius:11px;background:var(--c-bg);padding:10px 13px}
.fv3-gname{font-size:13px;font-weight:600}.fv3-gmeta{font-size:10px;color:var(--c-ink-3);margin:4px 0 6px;font-family:ui-monospace,Menlo,monospace}
/* 智能体 browser cards */
.fv3-acard{border:1px solid var(--soft);border-radius:12px;background:var(--c-bg);padding:11px 13px;margin-bottom:8px}
.fv3-ahead{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.fv3-aname{font-size:13px;font-weight:600;flex:1}
.fv3-aflow{font-size:10.5px;color:var(--c-ink-3);font-family:ui-monospace,Menlo,monospace;line-height:1.5;word-break:break-all}
.fv3-miniflow{width:100%;height:auto;margin:7px 0 2px;background:var(--c-bg);border:1px solid var(--soft);border-radius:9px;padding:2px}
.fv3-mfev rect{fill:var(--c-surface);stroke:var(--c-line);stroke-width:1}
.fv3-mfev text{font-size:8.5px;fill:var(--c-ink-2);font-family:ui-monospace,Menlo,monospace}
.fv3-mfev.fail rect{fill:color-mix(in oklch,var(--c-bad,#ff7a8a) 10%,var(--c-surface));stroke:color-mix(in oklch,var(--c-bad,#ff7a8a) 50%,transparent)}
.fv3-mfev.fail text{fill:var(--c-bad,#ff7a8a)}
.fv3-mfev.ok rect{fill:color-mix(in oklch,var(--c-ok) 10%,var(--c-surface));stroke:color-mix(in oklch,var(--c-ok) 45%,transparent)}
.fv3-mfev.ok text{fill:color-mix(in oklch,var(--c-ok) 78%,var(--c-ink-1))}
.fv3-mfdot{fill:color-mix(in oklch,var(--c-accent) 30%,var(--c-surface));stroke:var(--c-accent);stroke-width:1.5}
.fv3-atools{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}
.fv3-aunres{font-size:10.5px;color:oklch(0.62 0.16 60);margin-top:5px}
.fv3-aactions{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}
.fv3-aview{font-size:11px;color:var(--c-ink-2);background:var(--c-surface);border:1px solid var(--soft);border-radius:7px;padding:3px 10px;cursor:pointer;transition:all .12s}
.fv3-aview:hover{border-color:var(--c-accent);color:var(--c-ink-1)}
.fv3-cardact{font-size:11px;font-weight:600;border-radius:7px;padding:3px 9px;cursor:pointer;border:1px solid var(--soft);transition:all .12s}
.fv3-cardact.acc{color:var(--c-ok);border-color:color-mix(in oklch,var(--c-ok) 40%,transparent);background:color-mix(in oklch,var(--c-ok) 10%,transparent)}
.fv3-cardact.re{color:var(--c-accent);border-color:color-mix(in oklch,var(--c-accent) 38%,transparent);background:color-mix(in oklch,var(--c-accent) 9%,transparent)}
.fv3-cardact:hover{filter:brightness(1.25)}
.fv3-aview.on{background:var(--c-accent);color:#08121f;border-color:var(--c-accent);font-weight:500}
.fv3-aprompt{font-size:11px;color:var(--c-ink-2);background:var(--c-surface);border:1px solid var(--soft);border-radius:9px;padding:10px 12px;white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;line-height:1.6;max-height:300px;overflow:auto;margin:8px 0 0}
.fv3-acodewrap{position:relative;margin-top:8px}
.fv3-acodewrap .fv3-copycode{position:absolute;top:8px;right:8px;z-index:1}
.fv3-acc{margin-top:6px;border:1px solid var(--soft);border-radius:10px;background:var(--c-bg);padding:2px 0}
.fv3-acc>summary{font-size:11px;color:var(--c-ink-2);cursor:pointer;padding:8px 12px;list-style:none}
.fv3-acc>summary::-webkit-details-marker{display:none}
.fv3-acc>summary::before{content:"▸ ";color:var(--c-ink-3)}
.fv3-acc[open]>summary::before{content:"▾ "}
.fv3-accbody{padding:4px 10px 10px;display:flex;flex-direction:column;gap:5px}
.fv3-tracerow{font-size:12px;line-height:1.5}
.fv3-tracethink{color:var(--c-ink-3);font-size:11.5px;line-height:1.65;padding:4px 0}
.fv3-tracetool{color:var(--c-ink-2);display:flex;gap:7px;align-items:baseline;flex-wrap:wrap;padding:2px 0}
.fv3-traceagent{color:var(--c-ok);font-size:12px;padding:2px 0}
.fv3-traceval{font-size:11.5px;padding:3px 0}.fv3-traceval.ok{color:var(--c-ok)}.fv3-traceval.warn{color:var(--c-warn)}
/* timeline rail for the trace tab — a dot per step, colored by kind */
.fv3-timeline{position:relative;padding-left:20px;margin-top:4px}
.fv3-timeline::before{content:'';position:absolute;left:5px;top:8px;bottom:8px;width:1.5px;background:var(--c-line)}
.fv3-tlrow{position:relative;margin-bottom:9px}
.fv3-tlrow::before{content:'';position:absolute;left:-19px;top:5px;width:9px;height:9px;border-radius:50%;background:var(--c-surface);border:1.5px solid var(--c-ink-3);z-index:1}
.fv3-tlrow.d-tool::before{border-color:var(--c-accent)}
.fv3-tlrow.d-agent::before{border-color:var(--c-accent);background:var(--c-accent)}
.fv3-tlrow.d-ok::before{border-color:var(--c-ok);background:var(--c-ok)}
.fv3-tlrow.d-warn::before{border-color:var(--c-warn,#f5b556);background:var(--c-warn,#f5b556)}
.fv3-tlrow.d-err::before{border-color:var(--c-bad,#ff7a8a);background:var(--c-bad,#ff7a8a)}
.fv3-tlrow.d-think::before{border-color:var(--c-line)}
.fv3-eval{display:flex;gap:10px;align-items:flex-start;padding:6px 2px}
.fv3-evmark{font-weight:700;font-size:14px;flex:none}.fv3-evmark.ok{color:var(--c-ok)}.fv3-evmark.err{color:var(--c-err)}.fv3-evmark.idle{color:var(--c-ink-3)}
.fv3-evlabel{font-size:13px;color:var(--c-ink-1);line-height:1.45}.fv3-evdetail{font-size:11px;color:var(--c-ink-3);margin-top:2px}
.fv3-evalnote{font-size:11.5px;color:var(--c-ink-3);line-height:1.6;margin-top:10px;padding-top:10px;border-top:1px solid var(--soft)}
.fv3-badge{font-size:9px;font-weight:700;border-radius:6px;padding:2px 6px}
.fv3-badge.draft{color:oklch(.82 .12 75);background:color-mix(in oklch,var(--c-warn) 16%,transparent);border:1px solid color-mix(in oklch,var(--c-warn) 35%,transparent)}
.fv3-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--c-ink-3)}
.fv3-dot.ok{background:var(--c-ok);box-shadow:0 0 0 3px color-mix(in oklch,var(--c-ok) 18%,transparent)}.fv3-dot.idle{background:var(--c-ink-3)}
@keyframes fv3pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* ── polish: entrance + micro-interactions (subtle, reduced-motion aware) ── */
@keyframes fv3rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
/* Each feed block fades+rises in once as it streams in (key is stable, so only
   newly-arrived blocks animate — existing ones never re-animate). */
.fv3-block{animation:fv3rise .34s cubic-bezier(.22,1,.36,1) both}
.fv3-jump{animation:fv3rise .2s ease-out both}
/* Result cards lift gently on hover for depth. Safe: no position:fixed children. */
.fv3-agentcard,.fv3-plancard,.fv3-sandboxcard,.fv3-webcard,.fv3-makecard,.fv3-subcard{transition:transform .14s ease,box-shadow .16s ease,border-color .15s ease}
.fv3-agentcard:hover,.fv3-plancard:hover,.fv3-sandboxcard:hover,.fv3-webcard:hover,.fv3-makecard:hover,.fv3-subcard:hover{transform:translateY(-1px);box-shadow:0 4px 16px color-mix(in oklch,var(--c-ink-1) 9%,transparent)}
/* Button press feedback + run-button glow on hover. */
.fv3-run,.fv3-regen,.fv3-newsess,.fv3-jump,.fv3-exitview{transition:filter .12s,background .12s,transform .1s,box-shadow .12s}
.fv3-run:active:not(:disabled),.fv3-regen:active,.fv3-newsess:active:not(:disabled),.fv3-exitview:active{transform:translateY(1px)}
.fv3-jump:active{transform:translateX(-50%) translateY(1px)}
.fv3-run:not(:disabled):hover{box-shadow:0 3px 14px color-mix(in oklch,var(--c-accent) 35%,transparent)}
/* Live status chip — pulsing accent dot while the brain is reasoning. */
.fv3-chip.live{display:inline-flex;align-items:center;gap:7px;color:var(--c-accent);border-color:color-mix(in oklch,var(--c-accent) 35%,transparent)}
.fv3-livedot{width:7px;height:7px;border-radius:999px;background:var(--c-accent);box-shadow:0 0 0 3px color-mix(in oklch,var(--c-accent) 20%,transparent);animation:fv3pulse 1.2s infinite}
/* The "thinking" activity line gently breathes its border while the brain works. */
.fv3-activity{animation:fv3breathe 2.4s ease-in-out infinite}
@keyframes fv3breathe{0%,100%{border-color:var(--soft)}50%{border-color:color-mix(in oklch,var(--c-accent) 38%,var(--soft))}}
/* Thin, themed scrollbars for the panels + scrollable bodies. */
.fv3-feed,.fv3-left,.fv3-tabbody,.fv3-toolinput,.fv3-dprompt,.fv3-dcode,.fv3-aprompt{scrollbar-width:thin;scrollbar-color:color-mix(in oklch,var(--c-ink-3) 35%,transparent) transparent}
.fv3-feed::-webkit-scrollbar,.fv3-left::-webkit-scrollbar,.fv3-tabbody::-webkit-scrollbar,.fv3-toolinput::-webkit-scrollbar,.fv3-dprompt::-webkit-scrollbar,.fv3-dcode::-webkit-scrollbar,.fv3-aprompt::-webkit-scrollbar{width:10px;height:10px}
.fv3-feed::-webkit-scrollbar-thumb,.fv3-left::-webkit-scrollbar-thumb,.fv3-tabbody::-webkit-scrollbar-thumb,.fv3-toolinput::-webkit-scrollbar-thumb,.fv3-dprompt::-webkit-scrollbar-thumb,.fv3-dcode::-webkit-scrollbar-thumb,.fv3-aprompt::-webkit-scrollbar-thumb{background:color-mix(in oklch,var(--c-ink-3) 30%,transparent);border-radius:6px;border:2px solid transparent;background-clip:padding-box}
.fv3-feed::-webkit-scrollbar-thumb:hover,.fv3-left::-webkit-scrollbar-thumb:hover,.fv3-tabbody::-webkit-scrollbar-thumb:hover{background:color-mix(in oklch,var(--c-ink-3) 50%,transparent);background-clip:padding-box}
.fv3-feed::-webkit-scrollbar-track,.fv3-left::-webkit-scrollbar-track,.fv3-tabbody::-webkit-scrollbar-track{background:transparent}
/* Respect prefers-reduced-motion: drop all factory motion. */
/* ── Feature 3: background-run bar + stop button ───────────────────── */
.fv3-bgbar{display:flex;align-items:center;gap:10px;padding:7px 12px;margin:0 0 8px;border:1px solid var(--soft);border-radius:10px;background:var(--c-accent-bg)}
.fv3-bgrun{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--c-ink-2)}
.fv3-stop{margin-left:auto;font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid var(--c-bad,#ff7a8a);color:var(--c-bad,#ff7a8a);background:transparent;cursor:pointer;font-weight:500}
.fv3-stop:hover{background:color-mix(in oklab,var(--c-bad,#ff7a8a) 12%,transparent)}

/* ── Feature 1: brain activity log ─────────────────────────────────── */
.fv3-balog{display:flex;flex-direction:column;gap:0;margin-top:8px}
.fv3-baloghdr{display:flex;align-items:center;gap:8px;padding:6px 2px 8px;border-bottom:1px solid var(--soft);margin-bottom:6px}
.fv3-balogactor{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--c-ink-1)}
.fv3-balogava{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;background:var(--c-accent-bg)}
.fv3-balogava.sub{background:color-mix(in oklab,var(--c-warn,#f5b556) 20%,transparent)}
.fv3-balogmeta{margin-left:auto;font-size:11px;color:var(--c-ink-3)}
.fv3-balogsteps{display:flex;flex-direction:column;gap:3px}
.fv3-balogrow{font-size:12px;color:var(--c-ink-2);line-height:1.5}
.fv3-balogrow.milestone{display:flex;align-items:center;gap:6px;padding:2px 0}
.fv3-balogrow.milestone i{color:var(--c-ink-3);font-style:normal}
.fv3-balogtag{font-size:10px;padding:1px 6px;border-radius:5px;background:var(--soft);color:var(--c-ink-2);white-space:nowrap}
.fv3-balogtag.agent{background:var(--c-accent-bg);color:var(--c-accent)}
.fv3-balogtag.ok{background:color-mix(in oklab,var(--c-ok) 16%,transparent);color:var(--c-ok)}
.fv3-balogtag.warn,.fv3-balogtag.refine{background:color-mix(in oklab,var(--c-warn,#f5b556) 18%,transparent);color:var(--c-warn,#f5b556)}
.fv3-balogtag.tc{background:var(--c-accent-bg);color:var(--c-accent)}
.fv3-balogtool{display:flex;align-items:center;gap:7px;width:100%;text-align:left;background:none;border:none;padding:3px 4px;border-radius:6px;cursor:pointer;color:inherit}
.fv3-balogtool:hover{background:var(--soft)}
.fv3-balogdot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--c-ink-3)}
.fv3-balogdot.ok{background:var(--c-ok)}.fv3-balogdot.err{background:var(--c-bad,#ff7a8a)}.fv3-balogdot.run{background:var(--c-warn,#f5b556)}
.fv3-balogname{font-weight:500;color:var(--c-ink-1);white-space:nowrap}
.fv3-balogwhy{color:var(--c-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.fv3-balogchev{color:var(--c-ink-3);font-size:10px}
.fv3-balogio{margin:2px 0 6px 18px;border-left:2px solid var(--soft);padding-left:8px}
.fv3-balogiolbl{font-size:10px;color:var(--c-ink-3);margin:4px 0 2px}
.fv3-balogpre{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--c-bg);border:1px solid var(--soft);border-radius:6px;padding:6px 8px;margin:0;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.fv3-balogres{font-size:11.5px;color:var(--c-ink-2);background:var(--soft);border-radius:6px;padding:5px 8px;margin-top:2px}
.fv3-balogrow.sub{margin:4px 0;border:1px solid var(--soft);border-left:2px solid var(--c-warn,#f5b556);border-radius:8px;padding:6px 8px;background:color-mix(in oklab,var(--c-warn,#f5b556) 6%,transparent)}
.fv3-balogsubhd{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--c-ink-1)}
.fv3-balogsubsum{font-size:11.5px;color:var(--c-ink-2);margin-top:3px}

/* ── Feature 2: test-case confirm card ─────────────────────────────── */
.fv3-tccard{border:1px solid var(--soft);border-radius:12px;padding:11px 13px;background:var(--c-surface)}
.fv3-tccard.pending{border-color:var(--c-accent)}
.fv3-tchead{font-size:13px;margin-bottom:8px;color:var(--c-ink-1)}
.fv3-tclist{display:flex;flex-direction:column;gap:6px}
.fv3-tcrow{display:flex;gap:8px;align-items:flex-start}
.fv3-tckind{font-size:10px;padding:1px 7px;border-radius:5px;white-space:nowrap;margin-top:2px}
.fv3-tckind.pass{background:color-mix(in oklab,var(--c-ok) 16%,transparent);color:var(--c-ok)}
.fv3-tckind.reject{background:color-mix(in oklab,var(--c-warn,#f5b556) 18%,transparent);color:var(--c-warn,#f5b556)}
.fv3-tckind.edge{background:color-mix(in oklab,var(--c-bad,#ff7a8a) 16%,transparent);color:var(--c-bad,#ff7a8a)}
.fv3-tcbody{flex:1;min-width:0}
.fv3-tcname{font-size:12px;font-weight:500;color:var(--c-ink-1)}
.fv3-tcscn{font-size:11.5px;color:var(--c-ink-2);margin:1px 0}
.fv3-tcio{font-size:11px;color:var(--c-ink-3)}
.fv3-tcio code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;background:var(--soft);padding:0 4px;border-radius:4px;color:var(--c-ink-2)}
.fv3-tcio-lbl{color:var(--c-ink-3);margin-right:3px}
.fv3-tcpayload{margin-top:3px}
.fv3-tcpayload summary{font-size:10.5px;color:var(--c-ink-3);cursor:pointer}
.fv3-tcpayload pre{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--c-bg);border:1px solid var(--soft);border-radius:6px;padding:6px 8px;margin:4px 0 0;max-height:160px;overflow:auto;white-space:pre-wrap}
.fv3-tcacts{display:flex;gap:8px;margin-top:10px}
.fv3-tcbtn{font-size:12px;padding:6px 14px;border-radius:8px;cursor:pointer;font-weight:500;border:1px solid var(--soft);background:var(--c-surface);color:var(--c-ink-1)}
.fv3-tcbtn.run{border-color:var(--c-ok);color:var(--c-ok)}
.fv3-tcbtn.run:hover{background:color-mix(in oklab,var(--c-ok) 12%,transparent)}
.fv3-tcbtn.re:hover{background:var(--soft)}
.fv3-tcwait{font-size:11px;color:var(--c-ink-3);margin-top:7px}

/* ── Feature 2: verification I/O panel ─────────────────────────────── */
.fv3-iopanel{display:flex;flex-direction:column}
.fv3-iocase{border:1px solid var(--soft);border-radius:8px;padding:7px 9px;margin-bottom:6px;background:var(--c-bg)}
.fv3-iocasehd{font-size:12px;color:var(--c-ink-1)}
.fv3-iocasehd code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;background:var(--soft);padding:0 4px;border-radius:4px}
.fv3-iopre{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--c-surface);border:1px solid var(--soft);border-radius:6px;padding:6px 8px;margin:5px 0 0;max-height:140px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.fv3-iocard{border:1px solid var(--soft);border-radius:10px;padding:9px 11px;margin-bottom:7px;background:var(--c-surface);border-left:3px solid var(--c-ok)}
.fv3-iocard.warn{border-left-color:var(--c-warn,#f5b556)}
.fv3-iocard.degraded{border-left-color:var(--c-bad,#ff7a8a)}
.fv3-iohd{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.fv3-ioname{font-size:13px;font-weight:600;color:var(--c-ink-1)}
.fv3-iostatus{font-size:10.5px;padding:1px 7px;border-radius:5px}
.fv3-iostatus.ok{background:color-mix(in oklab,var(--c-ok) 16%,transparent);color:var(--c-ok)}
.fv3-iostatus.warn,.fv3-iostatus.degraded{background:color-mix(in oklab,var(--c-warn,#f5b556) 18%,transparent);color:var(--c-warn,#f5b556)}
.fv3-iolink{margin-left:auto;font-size:11px;color:var(--c-accent);text-decoration:none}
.fv3-iolink:hover{text-decoration:underline}
.fv3-iorow{display:flex;gap:7px;align-items:baseline;font-size:11.5px;line-height:1.6;margin:1px 0}
.fv3-iolbl{font-size:10px;color:var(--c-ink-3);flex:none;width:30px;text-align:right}
.fv3-iorow code.ev{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;padding:0 5px;border-radius:4px}
.fv3-iorow code.ev.in{background:var(--c-accent-bg);color:var(--c-accent)}
.fv3-iorow code.ev.out{background:color-mix(in oklab,var(--c-ok) 16%,transparent);color:var(--c-ok)}
.fv3-iopay{color:var(--c-ink-3);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fv3-iotools{color:var(--c-ink-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}
.fv3-ioreason{color:var(--c-ink-2)}
.fv3-caserow{display:flex;gap:9px;align-items:flex-start;padding:7px 2px;border-bottom:1px solid var(--soft)}
.fv3-caserow:last-of-type{border-bottom:0}
.fv3-casemark{font-size:13px;font-weight:700;flex:none;width:16px;text-align:center}
.fv3-casemark.ok{color:var(--c-ok)} .fv3-casemark.bad{color:var(--c-bad,#ff7a8a)}
.fv3-casebody{flex:1;min-width:0}
.fv3-casename{font-size:12.5px;font-weight:600;color:var(--c-ink-1);display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.fv3-casekind{font-size:10px;font-weight:600;padding:1px 7px;border-radius:5px;background:var(--soft);color:var(--c-ink-2)}
.fv3-casekind.pass{background:color-mix(in oklch,var(--c-ok) 15%,transparent);color:var(--c-ok)}
.fv3-casekind.reject{background:color-mix(in oklch,var(--c-warn,#f5b556) 18%,transparent);color:var(--c-warn,#f5b556)}
.fv3-casedetail{font-size:11.5px;color:var(--c-ink-2);margin-top:1px}
.fv3-caserow.bad .fv3-casedetail{color:var(--c-bad,#ff7a8a)}
.fv3-bdlist{display:flex;flex-direction:column;gap:10px}
.fv3-bditem{border:1px solid var(--soft);border-radius:10px;padding:9px 11px;background:var(--c-bg)}
.fv3-bdhd{font-size:12.5px;color:var(--c-ink-1);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fv3-bdhd code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--soft);padding:1px 6px;border-radius:5px}
.fv3-bdfrom{font-size:10.5px;color:var(--c-ink-3)}
.fv3-bdwhy{font-size:11.5px;color:var(--c-ink-2);margin:3px 0 6px}
.fv3-bdseg{display:flex;gap:6px}
.fv3-bdseg-btn{font-size:11.5px;padding:4px 11px;border-radius:7px;border:1px solid var(--soft);background:var(--c-surface);color:var(--c-ink-2);cursor:pointer}
.fv3-bdseg-btn:disabled{cursor:default;opacity:.7}
.fv3-bdseg-btn.on.external{background:var(--c-accent-bg);border-color:var(--c-accent);color:var(--c-accent)}
.fv3-bdseg-btn.on.terminal{background:color-mix(in oklch,var(--c-ok) 14%,transparent);border-color:var(--c-ok);color:var(--c-ok)}
.fv3-bdseg-btn.on.break{background:color-mix(in oklch,var(--c-bad,#ff7a8a) 14%,transparent);border-color:var(--c-bad,#ff7a8a);color:var(--c-bad,#ff7a8a)}
.fv3-bdext{display:flex;flex-direction:column;gap:6px;margin-top:7px}
.fv3-bdinput{width:100%;font-size:12px;padding:6px 9px;border-radius:7px;border:1px solid var(--soft);background:var(--c-surface);color:var(--c-ink-1);font-family:inherit}
.fv3-bdinput:disabled{opacity:.7}
.fv3-bdcard{border:1px solid var(--soft);border-radius:12px;padding:12px 14px;background:var(--c-surface)}
.fv3-bdrow{display:flex;gap:9px;align-items:flex-start;padding:6px 0;border-top:1px solid var(--soft)}
.fv3-bdrow:first-of-type{border-top:none}
.fv3-bdkind{font-size:10px;font-weight:600;padding:1px 7px;border-radius:5px;white-space:nowrap;margin-top:2px}
.fv3-bdkind.external{background:var(--c-accent-bg);color:var(--c-accent)}
.fv3-bdkind.terminal{background:color-mix(in oklch,var(--c-ok) 14%,transparent);color:var(--c-ok)}
.fv3-bdkind.break{background:color-mix(in oklch,var(--c-bad,#ff7a8a) 14%,transparent);color:var(--c-bad,#ff7a8a)}
.fv3-bdbody{flex:1;min-width:0}
.fv3-bdname{font-size:12.5px;color:var(--c-ink-1)}
.fv3-bdname code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.fv3-bdconsumer{color:var(--c-ink-2)}
.fv3-bdcontract{font-size:11.5px;color:var(--c-ink-2);margin-top:1px}

/* ── UI polish pass — clean icons + refined cards (toward the mockup) ──── */
.fv3-tcicon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:var(--c-accent-bg);color:var(--c-accent);margin-right:9px;vertical-align:-6px}
.fv3-havatar{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:var(--c-accent-bg);color:var(--c-accent);flex:none}
.fv3-havatar.sub{background:color-mix(in oklch,var(--c-warn,#f5b556) 18%,transparent);color:var(--c-warn,#f5b556)}
.fv3-hhead{align-items:center}
.fv3-hnode.root{padding:13px 15px}

.fv3-balog{margin-top:10px}
.fv3-balogcap{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--c-ink-3);font-weight:600;margin:0 0 9px;padding-bottom:8px;border-bottom:1px solid var(--soft)}
.fv3-balogsteps{gap:2px}
.fv3-balogtool{padding:5px 8px;border-radius:8px;gap:8px}
.fv3-balogtool:hover{background:var(--c-accent-bg)}
.fv3-balogname{font-size:12.5px}
.fv3-balogtag{font-size:10px;padding:1.5px 7px;border-radius:6px;font-weight:600}
.fv3-balogrow.milestone{padding:3.5px 8px;gap:7px}
.fv3-balogrow.sub{margin:7px 0;padding:9px 11px;border-radius:10px;border-left-width:2.5px}
.fv3-balogava.sub{width:20px;height:20px;border-radius:6px;background:color-mix(in oklch,var(--c-warn,#f5b556) 18%,transparent);color:var(--c-warn,#f5b556)}
.fv3-balogsubhd{gap:7px;font-size:12.5px;font-weight:600}
.fv3-balogsubsum{font-size:11.5px;color:var(--c-ink-3);margin-top:4px;padding-left:27px}
.fv3-balogio{margin-left:24px}

.fv3-tccard{padding:14px 15px;border-radius:14px}
.fv3-tccard.pending{box-shadow:0 0 0 1px color-mix(in oklch,var(--c-accent) 28%,transparent)}
.fv3-tchead{font-size:13.5px;font-weight:600;margin-bottom:12px}
.fv3-tcrow{gap:10px;padding:8px 0;border-top:1px solid var(--soft);align-items:flex-start}
.fv3-tcrow:first-child{border-top:none;padding-top:0}
.fv3-tckind{font-weight:600;border-radius:6px;padding:2px 8px;align-self:flex-start;margin-top:1px}
.fv3-tcname{font-size:12.5px;font-weight:600}
.fv3-tcacts{margin-top:13px;gap:9px}
.fv3-tcbtn{display:inline-flex;align-items:center;gap:6px;padding:7px 15px;border-radius:9px;font-weight:600}
.fv3-tcbtn.run{background:var(--c-ok);color:#08121f;border-color:var(--c-ok)}
.fv3-tcbtn.run:hover{background:color-mix(in oklch,var(--c-ok) 86%,#000)}
.fv3-tcwait{border-top:1px solid var(--soft);padding-top:9px;margin-top:9px}

.fv3-stop{display:inline-flex;align-items:center;gap:6px;font-weight:600}
.fv3-bgbar{border-radius:11px;padding:8px 13px}
.fv3-cardico{display:inline-flex;align-items:center;justify-content:center;width:21px;height:21px;border-radius:6px;background:var(--c-accent-bg);color:var(--c-accent);vertical-align:-5px;margin-right:7px;flex:none}
.fv3-cardico.ok{background:color-mix(in oklch,var(--c-ok) 15%,transparent);color:var(--c-ok)}
.fv3-cardico.sub{background:color-mix(in oklch,var(--c-warn,#f5b556) 18%,transparent);color:var(--c-warn,#f5b556)}

.fv3-iocard{border-radius:11px;padding:10px 12px}
.fv3-ioname{font-size:13px}

@media (prefers-reduced-motion:reduce){
  .fv3-block,.fv3-jump,.fv3-egnode.built,.fv3-livedot,.fv3-activity,.fv3-histdot.run,.fv3-toolstatus.run,.fv3-cursor{animation:none!important}
  .fv3-agentcard,.fv3-plancard,.fv3-sandboxcard,.fv3-webcard,.fv3-makecard,.fv3-subcard,.fv3-run,.fv3-regen,.fv3-newsess,.fv3-jump,.fv3-exitview{transition:none!important;transform:none!important}
}
`;
