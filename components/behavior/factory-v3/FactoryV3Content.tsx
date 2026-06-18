"use client";

// Agent Factory v3 — the autonomous Harness brain cockpit (Claude/Codex-style).
//
// Center = a streaming conversation: the brain's reasoning streams in, tool
// calls render as cards (reasoning → input → result), generated agents + sandbox
// runs appear inline. Right inspector = Agents (tools used + agents made) ·
// Trace (full chronological log) · Eval (validation + real sandbox run).
// Driven by the BrainEvent SSE stream from /api/factory-v3/brain/stream.

import React from "react";
import type { BrainEvent, AgentCardLite } from "@/lib/agent-factory-v3/brain/types";

const FACTORY_TOKEN = process.env.NEXT_PUBLIC_FACTORY_TOKEN ?? "";

const DOMAINS = [
  { id: "recruit-gen-v1", label: "招聘", tag: "recruit-gen-v1" },
  { id: "Agents-generation", label: "Agents 生成", tag: "agents-generation" },
  { id: "energy", label: "能源调度", tag: "energy" },
  { id: "feikong", label: "费控", tag: "feikong" },
];

const TOOL_LABEL: Record<string, string> = {
  read_ontology: "读本体", generate_agents: "生成 agent", validate_graph: "校验图", sandbox_run: "沙箱跑通", finish: "完成", web_search: "网络搜索",
};

type Block =
  | { kind: "think"; text: string }
  | { kind: "tool"; id: string; name: string; reasoning: string; input: unknown; result?: { ok: boolean; summary: string } }
  | { kind: "agent"; spec: AgentCardLite }
  | { kind: "validation"; ok: boolean; issues: string[] }
  | { kind: "sandbox"; ran: number; reachedTerminal: boolean; agents: string[]; events: string[] }
  | { kind: "web"; query: string; results: Array<{ title: string; url: string; snippet: string }> }
  | { kind: "skill"; name: string; purpose: string }
  | { kind: "toolnew"; name: string; description: string }
  | { kind: "subagent"; task: string; summary?: string }
  | { kind: "message"; text: string }
  | { kind: "error"; message: string };

function toBlocks(events: BrainEvent[]): Block[] {
  const blocks: Block[] = [];
  let think = "";
  const flush = () => { if (think.trim()) blocks.push({ kind: "think", text: think.trim() }); think = ""; };
  for (const e of events) {
    if (e.t === "think") { think += e.delta; continue; }
    flush();
    if (e.t === "tool.call") blocks.push({ kind: "tool", id: e.id, name: e.name, reasoning: e.reasoning, input: e.input });
    else if (e.t === "tool.result") {
      for (let i = blocks.length - 1; i >= 0; i--) { const b = blocks[i]; if (b.kind === "tool" && b.id === e.id) { b.result = { ok: e.ok, summary: e.summary }; break; } }
    } else if (e.t === "agent.created") blocks.push({ kind: "agent", spec: e.spec });
    else if (e.t === "validation") blocks.push({ kind: "validation", ok: e.ok, issues: e.issues });
    else if (e.t === "sandbox") blocks.push({ kind: "sandbox", ran: e.ran, reachedTerminal: e.reachedTerminal, agents: e.agents, events: e.events });
    else if (e.t === "web.result") blocks.push({ kind: "web", query: e.query, results: e.results });
    else if (e.t === "skill.created") blocks.push({ kind: "skill", name: e.name, purpose: e.purpose });
    else if (e.t === "tool.created") blocks.push({ kind: "toolnew", name: e.name, description: e.description });
    else if (e.t === "subagent.start") blocks.push({ kind: "subagent", task: e.task });
    else if (e.t === "subagent.done") {
      for (let i = blocks.length - 1; i >= 0; i--) { const b = blocks[i]; if (b.kind === "subagent" && b.task === e.task) { b.summary = e.summary; break; } }
    } else if (e.t === "message") blocks.push({ kind: "message", text: e.text });
    else if (e.t === "error") blocks.push({ kind: "error", message: e.message });
  }
  flush();
  return blocks;
}

type RightTab = "agents" | "trace" | "eval";

export function FactoryV3Content() {
  const [domain, setDomain] = React.useState("recruit-gen-v1");
  const [goal, setGoal] = React.useState("为这个域生成能真正跑通的 agents，并在沙箱里验证事件链跑通。");
  const [events, setEvents] = React.useState<BrainEvent[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const [tab, setTab] = React.useState<RightTab>("agents");
  const esRef = React.useRef<EventSource | null>(null);
  const doneRef = React.useRef(false);
  const feedEnd = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => () => esRef.current?.close(), []);
  React.useEffect(() => { feedEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [events.length]);

  function start() {
    if (streaming) return;
    esRef.current?.close();
    doneRef.current = false;
    setEvents([]); setStreaming(true);
    const p = new URLSearchParams({ domain, goal });
    if (FACTORY_TOKEN) p.set("token", FACTORY_TOKEN);
    const es = new EventSource(`/api/factory-v3/brain/stream?${p.toString()}`);
    esRef.current = es;
    es.onmessage = (m) => {
      let e: BrainEvent; try { e = JSON.parse(m.data) as BrainEvent; } catch { return; }
      setEvents((prev) => [...prev, e]);
      if (e.t === "done") { doneRef.current = true; es.close(); setStreaming(false); }
    };
    es.onerror = () => { if (!doneRef.current) setEvents((p2) => [...p2, { t: "error", message: "流式连接中断" }]); es.close(); setStreaming(false); };
  }

  const blocks = toBlocks(events);
  const agents = blocks.filter((b): b is Extract<Block, { kind: "agent" }> => b.kind === "agent");
  const toolCalls = events.filter((e): e is Extract<BrainEvent, { t: "tool.call" }> => e.t === "tool.call");
  const toolCounts = new Map<string, number>();
  for (const tc of toolCalls) toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1);
  const validation = [...blocks].reverse().find((b) => b.kind === "validation") as Extract<Block, { kind: "validation" }> | undefined;
  const sandbox = [...blocks].reverse().find((b) => b.kind === "sandbox") as Extract<Block, { kind: "sandbox" }> | undefined;
  const tokens = events.reduce((n, e) => (e.t === "done" ? e.tokensUsed : n), 0);
  const turns = events.reduce((n, e) => (e.t === "done" ? e.turns : n), 0);

  return (
    <div className="fv3-root">
      <style>{FV3_CSS}</style>

      <aside className="fv3-left">
        <div className="fv3-brand"><span className="fv3-logo">AO</span><div><b>Agent 工厂</b><small>v3 · 自主 Harness 大脑</small></div></div>
        <div className="fv3-grp">业务域</div>
        {DOMAINS.map((d) => (
          <button key={d.id} className={`fv3-sess ${domain === d.id ? "on" : ""}`} onClick={() => setDomain(d.id)} disabled={streaming}>
            {d.label}<span className="fv3-domtag">{d.tag}</span>
          </button>
        ))}
        <div className="fv3-grp">本次运行</div>
        <div className="fv3-step"><span className="fv3-mini">{turns ? `${turns} 轮 · ${(tokens / 1000).toFixed(1)}k tok` : streaming ? "推理中…" : "就绪"}</span></div>
        <div className="fv3-grp">生成的 agent（{agents.length}）</div>
        {agents.length === 0 && <div className="fv3-empty">大脑生成的 agent 会作为草稿出现这里</div>}
        {agents.map((a) => (
          <div key={a.spec.slug} className="fv3-draft"><span className="fv3-draftname">{a.spec.nameZh}</span><span className="fv3-badge draft">DRAFT</span></div>
        ))}
      </aside>

      <main className="fv3-center">
        <div className="fv3-head">
          <span className="fv3-crumb">自主大脑 · {DOMAINS.find((d) => d.id === domain)?.label}</span>
          <span className="fv3-chip">{streaming ? "● 推理中" : sandbox?.reachedTerminal ? "✓ 跑通到终态" : tokens ? "完成" : "就绪"}</span>
        </div>

        <div className="fv3-feed">
          <div className="fv3-userbubble">{goal}</div>
          {events.length === 0 && !streaming && (
            <div className="fv3-hint">这是一个<strong>自主的 Harness 大脑</strong>：它会自己思考、读本体、推理要造哪些 agent、生成它们、校验事件图、并在沙箱里<strong>真实部署到 Inngest 跑通</strong>——全程像 Claude/Codex 一样流式展示思考与每一步工具调用。点「开始」让它跑。</div>
          )}
          {blocks.map((b, i) => <BlockView key={i} b={b} streaming={streaming && i === blocks.length - 1} />)}
          {streaming && <div className="fv3-cursor">▍</div>}
          <div ref={feedEnd} />
        </div>

        <div className="fv3-composer">
          <input className="fv3-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="给大脑一个目标…" disabled={streaming} onKeyDown={(e) => { if (e.key === "Enter") start(); }} />
          <button className="fv3-run" disabled={streaming} onClick={start}>{streaming ? "运行中…" : "开始"}</button>
        </div>
      </main>

      <aside className="fv3-right">
        <div className="fv3-tabs">
          {(["agents", "trace", "eval"] as RightTab[]).map((t) => (
            <button key={t} className={`fv3-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t === "agents" ? "内部" : t === "trace" ? "Trace" : "Eval"}</button>
          ))}
        </div>
        <div className="fv3-tabbody">
          {tab === "agents" && (
            <>
              <div className="fv3-ititle">大脑用过的工具{streaming && <span className="fv3-live">● live</span>}</div>
              {Object.keys(TOOL_LABEL).filter((n) => toolCounts.has(n) || ["read_ontology", "generate_agents", "validate_graph", "sandbox_run"].includes(n)).map((n) => (
                <div key={n} className="fv3-agentrow"><span className={`fv3-dot ${toolCounts.has(n) ? "ok" : "idle"}`} /><span className="fv3-agnm">{TOOL_LABEL[n]}</span><span className="fv3-agms">{toolCounts.get(n) || ""}</span></div>
              ))}
              <div className="fv3-ititle" style={{ marginTop: 10 }}>生成的 agent（{agents.length}）</div>
              {agents.map((a) => (
                <div key={a.spec.slug} className="fv3-gcard">
                  <div className="fv3-gname">{a.spec.nameZh} <span className="fv3-badge draft">DRAFT</span></div>
                  <div className="fv3-gmeta">{a.spec.trigger.join(", ")} → {a.spec.emit.join(" / ")}</div>
                  <div className="fv3-gtools">{a.spec.tools.map((t) => <span key={t} className="fv3-tool">{t}</span>)}</div>
                </div>
              ))}
            </>
          )}
          {tab === "trace" && (
            <>
              {events.length === 0 && <div className="fv3-empty">大脑的完整思考 + 每一步工具调用与结果会在这里逐条出现。</div>}
              {blocks.filter((b) => b.kind !== "think" || (b as any).text).map((b, i) => (
                <div key={i} className="fv3-tracerow">
                  {b.kind === "think" && <div className="fv3-tracethink">💭 {(b as Extract<Block, { kind: "think" }>).text}</div>}
                  {b.kind === "tool" && <div className="fv3-tracetool"><span className={`fv3-pill t-${b.name}`}>{TOOL_LABEL[b.name] ?? b.name}</span> {b.result ? (b.result.ok ? "✓ " : "✗ ") + b.result.summary : "…"}</div>}
                  {b.kind === "agent" && <div className="fv3-traceagent">🤖 {b.spec.nameZh}</div>}
                  {b.kind === "validation" && <div className={`fv3-traceval ${b.ok ? "ok" : "warn"}`}>{b.ok ? "✓ 图闭合" : "⚠ " + (b.issues[0] ?? "")}</div>}
                  {b.kind === "sandbox" && <div className={`fv3-traceval ${b.reachedTerminal ? "ok" : "warn"}`}>⚙ 真实运行 {b.ran} agent · {b.reachedTerminal ? "到达终态" : "未到终态"}</div>}
                </div>
              ))}
            </>
          )}
          {tab === "eval" && (
            <>
              <div className="fv3-ititle">真实验证</div>
              <EvalLine ok={agents.length >= 6} label={`生成 agent 覆盖（${agents.length} 个）`} />
              <EvalLine ok={validation?.ok} label="事件图闭合" detail={validation && !validation.ok ? validation.issues.slice(0, 2).join("；") : undefined} />
              <EvalLine ok={!!sandbox && sandbox.ran > 0} label={`部署到 Inngest 并真实运行（${sandbox?.ran ?? 0} agent）`} />
              <EvalLine ok={sandbox?.reachedTerminal} label="事件链跑通到终态" />
              {sandbox && <div className="fv3-evalnote">真实运行的事件链（{sandbox.events.length} 个事件）：{sandbox.events.slice(0, 8).map((e) => e.replace(`${domain}/`, "")).join(" · ")}…</div>}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function EvalLine({ ok, label, detail }: { ok?: boolean; label: string; detail?: string }) {
  const cls = ok === undefined ? "idle" : ok ? "ok" : "err";
  return <div className="fv3-eval"><span className={`fv3-evmark ${cls}`}>{ok === undefined ? "·" : ok ? "✓" : "✗"}</span><div><div className="fv3-evlabel">{label}</div>{detail && <div className="fv3-evdetail">{detail}</div>}</div></div>;
}

function BlockView({ b, streaming }: { b: Block; streaming: boolean }) {
  const [open, setOpen] = React.useState(false);
  switch (b.kind) {
    case "think": return <div className={`fv3-think ${streaming ? "streaming" : ""}`}>{b.text}</div>;
    case "tool": return (
      <div className="fv3-toolcard">
        <button className="fv3-toolhead" onClick={() => setOpen(!open)}>
          <span className={`fv3-pill t-${b.name}`}>{TOOL_LABEL[b.name] ?? b.name}</span>
          <span className="fv3-toolreason">{b.reasoning}</span>
          {b.result ? <span className={`fv3-toolstatus ${b.result.ok ? "ok" : "warn"}`}>{b.result.ok ? "✓" : "✗"}</span> : <span className="fv3-toolstatus run">●</span>}
        </button>
        {b.result && <div className="fv3-toolresult">{b.result.summary}</div>}
        {open && <pre className="fv3-toolinput">{JSON.stringify(b.input, null, 2)}</pre>}
      </div>
    );
    case "agent": return (
      <div className="fv3-agentcard">
        <div className="fv3-achead">🤖 {b.spec.nameZh} <span className="fv3-badge draft">DRAFT</span> <code>{b.spec.short}</code></div>
        <div className="fv3-acmeta">{b.spec.trigger.join(", ") || "(入口)"} → {b.spec.emit.join(" / ") || "(终态)"}</div>
        {b.spec.tools.length > 0 && <div className="fv3-gtools">{b.spec.tools.map((t) => <span key={t} className="fv3-tool">{t}</span>)}</div>}
      </div>
    );
    case "validation": return <div className={`fv3-valid ${b.ok ? "ok" : "warn"}`}>{b.ok ? "✓ 事件图闭合" : `⚠ 校验：${b.issues.slice(0, 2).join("；")}`}</div>;
    case "sandbox": return <div className={`fv3-sandboxcard ${b.reachedTerminal ? "ok" : "warn"}`}>⚙ <b>真实运行</b>：{b.ran} 个 agent 部署到 Inngest 并跑起来 · 事件链 {b.events.length} 个 · {b.reachedTerminal ? "到达终态 ✓" : "未到终态"}</div>;
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
    case "subagent": return <div className="fv3-subcard">🧬 <b>子大脑</b>：{b.task}{b.summary ? <div className="fv3-submeta">↳ {b.summary}</div> : <span className="fv3-toolstatus run"> ●</span>}</div>;
    case "message": return <div className="fv3-assistant">{b.text}</div>;
    case "error": return <div className="fv3-errcard">⚠ {b.message}</div>;
  }
}

const FV3_CSS = `
.fv3-root{display:grid;grid-template-columns:228px 1fr 344px;height:100%;min-height:0;background:var(--c-bg);color:var(--c-ink-1);font-size:14px}
.fv3-root *{box-sizing:border-box}
.fv3-left{background:var(--c-bg);border-right:1px solid var(--c-line);padding:13px 11px;overflow-y:auto}
.fv3-brand{display:flex;align-items:center;gap:9px;margin-bottom:13px}
.fv3-logo{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,var(--c-accent),var(--c-ok));display:grid;place-items:center;font-weight:800;font-size:12px;color:#08121f}
.fv3-brand b{font-size:13.5px}.fv3-brand small{display:block;color:var(--c-ink-3);font-size:10.5px}
.fv3-grp{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--c-ink-3);margin:13px 4px 5px}
.fv3-sess{display:flex;align-items:center;width:100%;text-align:left;gap:6px;color:var(--c-ink-2);font-size:13px;padding:6px 9px;border-radius:8px;border:1px solid transparent;background:none;cursor:pointer;margin-bottom:2px}
.fv3-sess:hover{background:var(--c-surface)}.fv3-sess:disabled{opacity:.5;cursor:default}
.fv3-sess.on{background:var(--c-surface);color:var(--c-ink-1);border-color:var(--c-line);border-left:2px solid var(--c-accent)}
.fv3-domtag{margin-left:auto;font-size:10px;color:var(--c-ok);font-family:ui-monospace,Menlo,monospace}
.fv3-mini{font-size:12px;color:var(--c-ink-2);padding:0 9px}
.fv3-step{padding:3px 0}
.fv3-draft{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:7px;background:var(--c-surface);border:1px solid var(--c-line);margin-bottom:3px}
.fv3-draftname{font-size:12.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fv3-empty{font-size:11.5px;color:var(--c-ink-3);padding:4px 9px;line-height:1.5}
.fv3-center{display:flex;flex-direction:column;min-width:0;background:var(--c-bg)}
.fv3-head{display:flex;align-items:center;gap:9px;padding:11px 16px;border-bottom:1px solid var(--c-line)}
.fv3-crumb{font-size:12.5px;color:var(--c-ink-3)}
.fv3-chip{margin-left:auto;font-size:11.5px;color:var(--c-ink-2);background:var(--c-surface);border:1px solid var(--c-line);border-radius:20px;padding:2px 11px}
.fv3-feed{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:10px;max-width:860px;width:100%;margin:0 auto}
.fv3-userbubble{align-self:flex-end;background:var(--c-accent);color:#08121f;border-radius:13px 13px 4px 13px;padding:9px 15px;font-size:13.5px;max-width:80%}
.fv3-hint{color:var(--c-ink-2);font-size:13.5px;line-height:1.75;background:var(--c-surface);border:1px solid var(--c-line);border-radius:12px;padding:14px 16px}
.fv3-think{color:var(--c-ink-3);font-size:13px;line-height:1.7;white-space:pre-wrap;padding:2px 4px;border-left:2px solid var(--c-line);padding-left:12px}
.fv3-think.streaming{color:var(--c-ink-2)}
.fv3-cursor{color:var(--c-accent);animation:fv3blink 1s steps(1) infinite;font-weight:700;margin-left:12px}
@keyframes fv3blink{50%{opacity:0}}
.fv3-toolcard{border:1px solid var(--c-line);border-radius:10px;background:var(--c-surface);overflow:hidden}
.fv3-toolhead{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:9px 12px;background:none;border:none;cursor:pointer}
.fv3-toolreason{flex:1;font-size:13px;color:var(--c-ink-2)}
.fv3-toolstatus{font-size:13px;color:var(--c-ok)}.fv3-toolstatus.warn{color:var(--c-warn)}.fv3-toolstatus.run{color:var(--c-accent);animation:fv3pulse 1.2s infinite}
.fv3-toolresult{padding:0 12px 9px 12px;font-size:12px;color:var(--c-ink-2);border-top:1px solid var(--c-line);padding-top:8px}
.fv3-toolinput{margin:0;padding:9px 12px;background:var(--c-bg);border-top:1px solid var(--c-line);font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--c-ink-3);white-space:pre-wrap;max-height:200px;overflow:auto}
.fv3-pill{font-size:10px;font-weight:700;color:#08121f;background:var(--c-accent);border-radius:5px;padding:2px 7px;white-space:nowrap}
.fv3-pill.t-validate_graph,.fv3-pill.t-validate{background:var(--c-ok)}.fv3-pill.t-sandbox_run{background:oklch(.7 .14 300)}.fv3-pill.t-finish{background:var(--c-ink-3)}.fv3-pill.t-generate_agents{background:var(--c-ok)}
.fv3-agentcard{border:1px solid var(--c-line-2,var(--c-line));border-radius:10px;background:color-mix(in oklch,var(--c-ok) 6%,var(--c-surface));padding:10px 13px}
.fv3-achead{font-size:14px;font-weight:600;display:flex;align-items:center;gap:7px}.fv3-achead code{font-size:10px;color:var(--c-ink-3);font-family:ui-monospace,Menlo,monospace}
.fv3-acmeta{font-size:11px;color:var(--c-ink-3);margin:4px 0 6px;font-family:ui-monospace,Menlo,monospace}
.fv3-gtools{display:flex;flex-wrap:wrap;gap:4px}
.fv3-tool{font-size:9.5px;font-family:ui-monospace,Menlo,monospace;color:var(--c-accent);background:var(--c-bg);border:1px solid var(--c-line);border-radius:5px;padding:1px 5px}
.fv3-valid{font-size:12.5px;border-radius:8px;padding:7px 12px}
.fv3-valid.ok{color:var(--c-ok);background:color-mix(in oklch,var(--c-ok) 10%,transparent)}
.fv3-valid.warn{color:var(--c-warn);background:color-mix(in oklch,var(--c-warn) 10%,transparent)}
.fv3-sandboxcard{font-size:13px;border-radius:10px;padding:10px 14px;border:1px solid var(--c-line)}
.fv3-sandboxcard.ok{color:var(--c-ok);background:color-mix(in oklch,var(--c-ok) 12%,transparent)}
.fv3-sandboxcard.warn{color:var(--c-warn);background:color-mix(in oklch,var(--c-warn) 10%,transparent)}
.fv3-webcard{border:1px solid var(--c-line);border-radius:10px;background:var(--c-surface);padding:9px 13px}
.fv3-webhead{font-size:12.5px;color:var(--c-ink-2);margin-bottom:5px}
.fv3-webrow{font-size:11.5px;margin:3px 0;display:flex;flex-direction:column}
.fv3-webrow a{color:var(--c-accent);font-weight:500}.fv3-webrow span{color:var(--c-ink-3)}
.fv3-makecard{font-size:13px;border-radius:10px;padding:9px 13px;border:1px solid var(--c-line);background:color-mix(in oklch,var(--c-accent) 7%,var(--c-surface))}
.fv3-subcard{font-size:13px;border-radius:10px;padding:9px 13px;border:1px solid var(--c-line);border-left:3px solid oklch(.7 .14 300);background:var(--c-surface)}
.fv3-submeta{font-size:11.5px;color:var(--c-ink-3);margin-top:4px}
.fv3-assistant{font-size:14px;line-height:1.7;color:var(--c-ink-1);white-space:pre-wrap;background:var(--c-surface);border:1px solid var(--c-line);border-radius:12px;padding:13px 16px}
.fv3-errcard{color:var(--c-err);background:color-mix(in oklch,var(--c-err) 10%,transparent);border:1px solid var(--c-line);border-radius:9px;padding:8px 13px;font-size:12.5px}
.fv3-composer{border-top:1px solid var(--c-line);padding:11px 16px;display:flex;gap:8px;max-width:860px;width:100%;margin:0 auto}
.fv3-input{flex:1;background:var(--c-surface);border:1px solid var(--c-line);border-radius:10px;padding:9px 14px;color:var(--c-ink-1);font:inherit;font-size:13.5px;outline:none}
.fv3-input:focus{border-color:var(--c-accent)}
.fv3-run{background:var(--c-accent);color:#08121f;border:none;border-radius:10px;padding:9px 20px;font-weight:600;font-size:13.5px;cursor:pointer}
.fv3-run:disabled{opacity:.6;cursor:default}
.fv3-right{background:var(--c-surface);border-left:1px solid var(--c-line);display:flex;flex-direction:column;min-width:0}
.fv3-tabs{display:flex;gap:2px;padding:9px 9px 0;border-bottom:1px solid var(--c-line)}
.fv3-tab{flex:1;text-align:center;font-size:12.5px;color:var(--c-ink-3);padding:8px 4px;border:none;background:none;border-bottom:2px solid transparent;cursor:pointer}
.fv3-tab.on{color:var(--c-ink-1);border-bottom-color:var(--c-accent)}
.fv3-tabbody{flex:1;overflow-y:auto;padding:12px 13px;display:flex;flex-direction:column;gap:6px}
.fv3-ititle{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--c-ink-3)}
.fv3-live{color:var(--c-ok);font-size:10px;margin-left:6px}
.fv3-agentrow{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--c-ink-2);padding:6px 9px;border-radius:8px;background:var(--c-bg);border:1px solid var(--c-line)}
.fv3-agnm{flex:1}.fv3-agms{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--c-ink-3)}
.fv3-gcard{border:1px solid var(--c-line);border-radius:9px;background:var(--c-bg);padding:8px 11px}
.fv3-gname{font-size:13px;font-weight:600}.fv3-gmeta{font-size:10px;color:var(--c-ink-3);margin:3px 0;font-family:ui-monospace,Menlo,monospace}
.fv3-tracerow{font-size:12px;line-height:1.5}
.fv3-tracethink{color:var(--c-ink-3);font-size:11.5px;line-height:1.6;padding:3px 0}
.fv3-tracetool{color:var(--c-ink-2);display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.fv3-traceagent{color:var(--c-ok);font-size:12px}
.fv3-traceval{font-size:11.5px;padding:2px 0}.fv3-traceval.ok{color:var(--c-ok)}.fv3-traceval.warn{color:var(--c-warn)}
.fv3-eval{display:flex;gap:9px;align-items:flex-start;padding:5px 2px}
.fv3-evmark{font-weight:700;font-size:13px}.fv3-evmark.ok{color:var(--c-ok)}.fv3-evmark.err{color:var(--c-err)}.fv3-evmark.idle{color:var(--c-ink-3)}
.fv3-evlabel{font-size:12.5px;color:var(--c-ink-1)}.fv3-evdetail{font-size:11px;color:var(--c-ink-3);margin-top:2px}
.fv3-evalnote{font-size:11px;color:var(--c-ink-3);line-height:1.55;margin-top:8px}
.fv3-badge{font-size:9px;font-weight:700;border-radius:5px;padding:1px 5px}
.fv3-badge.draft{color:oklch(.82 .12 75);background:color-mix(in oklch,var(--c-warn) 16%,transparent);border:1px solid color-mix(in oklch,var(--c-warn) 35%,transparent)}
.fv3-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--c-ink-3)}
.fv3-dot.ok{background:var(--c-ok)}.fv3-dot.idle{background:var(--c-ink-3)}
@keyframes fv3pulse{0%,100%{opacity:1}50%{opacity:.3}}
`;
