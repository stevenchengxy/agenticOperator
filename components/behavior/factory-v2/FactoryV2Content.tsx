"use client";

// Agent Factory v2 console — runs a v2 build over SSE and visualises it.
// SSE route: GET /api/factory-v2/build/stream?domain=<slug>
// Build events are defined in lib/agent-factory-v2/types.ts (BuildEvent union).

import React from "react";
import Link from "next/link";
import { Badge, Btn, StatusDot } from "@/components/shared/atoms";
import type { BuildEvent, FacetKind } from "@/lib/agent-factory-v2/types";

const FACTORY_TOKEN = process.env.NEXT_PUBLIC_FACTORY_TOKEN ?? "";
const factoryHeaders = (base: Record<string, string> = {}) =>
  FACTORY_TOKEN ? { ...base, "x-factory-token": FACTORY_TOKEN } : base;

// ── Types ────────────────────────────────────────────────────────────────────

type InspectorTab = "crew" | "reason" | "agents" | "tools" | "smoke";

type DotKind = "idle" | "running" | "ok" | "warn" | "err";

interface BuilderRow {
  id: string;
  label: string;
  /** One-line "what this builder does" — surfaced in the 班子 panel so the
   *  roster reads as a job description, not just a list of names. */
  role: string;
  status: DotKind;
}

/** A tool in the domain's library — shape of /api/factory/tools `tools[]`. */
interface CatalogTool {
  name: string;
  family: string;
  title: string;
  description: string;
  sideEffect: "read" | "write" | "dual-write";
  params: string;
  returns: string;
  requiredEnv: string[];
}

interface AssembledAgentSpec {
  slug: string;
  short: string;
  kind: string;
  nameZh: string;
  trigger: string[];
  emit: string[];
  objects: string[];
  retries: number;
  confidence: number;
  systemPrompt: string;
  userPrompt: string;
  steps: { name: string; tool: string | null }[];
}

interface AssembledAgent {
  name: string;
  tools: string[];
  promptSource: string;
  spec: AssembledAgentSpec;
}

interface SmokeResult {
  passed: boolean;
  ran: number;
  repairs: number;
}

interface ShipInfo {
  versionLabel: string;
  deployed: string[];
  appRegistered: boolean;
  error?: string;
}

interface RunInfo {
  fired: string[];
  runs: { runId: string; status: string; fn: string }[];
  events: string[];
  reachedTerminal: boolean;
}

// ── Builder roster (heuristic mapping from events) ───────────────────────────

const INITIAL_CREW: BuilderRow[] = [
  { id: "facet-analyst",  label: "FacetAnalyst",  role: "并行拆解本体四维(动作/事件/规则/对象),每维一个分析 agent", status: "idle" },
  { id: "integrator",     label: "Integrator",     role: "把四维洞察整合成一份连贯的领域理解(DomainUnderstanding)", status: "idle" },
  { id: "planner",        label: "Planner",        role: "据领域理解规划要造几个 agent、几个共享技能(不再 1:1 死拆)", status: "idle" },
  { id: "skill-smith",    label: "SkillSmith",     role: "构建可复用能力包(SkillSpec:prompt 片段+工具+决策规则)", status: "idle" },
  { id: "tool-smith",     label: "ToolSmith",      role: "为每个 agent 从工具库推理并选定该用哪些工具", status: "idle" },
  { id: "prompt-writer",  label: "PromptWriter",   role: "为每个 agent 撰写系统 prompt,织入选定工具与相关技能", status: "idle" },
  { id: "critic",         label: "Critic",         role: "评审每个 agent 的 prompt 质量,打分并打回重写(最多 1 轮)", status: "idle" },
  { id: "validator",      label: "Validator",      role: "静态校验事件-动作图是否闭合(悬空 emit/孤儿 trigger/幻觉工具)", status: "idle" },
  { id: "fixer",          label: "Fixer",          role: "冒烟跑不通时诊断该 agent 并生成最小补丁(最多 3 轮,修不好转人工)", status: "idle" },
];

// ── Main component ────────────────────────────────────────────────────────────

export function FactoryV2Content() {
  const [domain, setDomain] = React.useState("recruit-gen-v1");
  const [tab, setTab] = React.useState<InspectorTab>("crew");

  const [streaming, setStreaming] = React.useState(false);
  const [events, setEvents] = React.useState<BuildEvent[]>([]);
  const [crew, setCrew] = React.useState<BuilderRow[]>(INITIAL_CREW);
  const [assembledAgents, setAssembledAgents] = React.useState<AssembledAgent[]>([]);
  const [smokeResult, setSmokeResult] = React.useState<SmokeResult | null>(null);
  const [needsHuman, setNeedsHuman] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [buildMeta, setBuildMeta] = React.useState<{ domain: string; source: string } | null>(null);
  const [catalog, setCatalog] = React.useState<CatalogTool[] | null>(null);
  const [shipInfo, setShipInfo] = React.useState<ShipInfo | null>(null);
  const [runInfo, setRunInfo] = React.useState<RunInfo | null>(null);

  const esRef = React.useRef<EventSource | null>(null);
  const doneRef = React.useRef(false);
  const reasonEndRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  // Load the domain's tool library whenever the domain changes, so 工具库 is
  // browsable before/independent of a build — the agents compose from these.
  React.useEffect(() => {
    let alive = true;
    setCatalog(null);
    fetch(`/api/factory/tools?domain=${encodeURIComponent(domain)}`, { headers: factoryHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { tools?: CatalogTool[] }) => { if (alive) setCatalog(j.tools ?? []); })
      .catch(() => { if (alive) setCatalog([]); });
    return () => { alive = false; };
  }, [domain]);

  React.useEffect(() => {
    if (tab === "reason") {
      reasonEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, tab]);

  function updateCrew(updater: (prev: BuilderRow[]) => BuilderRow[]) {
    setCrew(updater);
  }

  function setCrwStatus(id: string, status: DotKind) {
    updateCrew((rows) => rows.map((r) => r.id === id ? { ...r, status } : r));
  }

  function reset() {
    setEvents([]);
    setCrew(INITIAL_CREW);
    setAssembledAgents([]);
    setSmokeResult(null);
    setNeedsHuman(null);
    setError(null);
    setBuildMeta(null);
    setShipInfo(null);
    setRunInfo(null);
  }

  function applyEvent(e: BuildEvent) {
    setEvents((prev) => [...prev, e]);

    switch (e.t) {
      case "build.start":
        setBuildMeta({ domain: e.domain, source: e.source });
        break;

      case "facet.start":
        setCrwStatus("facet-analyst", "running");
        break;

      case "facet.analyzed":
        // after all 4 facets, keep running until understanding.ready
        setCrwStatus("facet-analyst", "running");
        break;

      case "understanding.ready":
        setCrwStatus("facet-analyst", "ok");
        setCrwStatus("integrator", "ok");
        setCrwStatus("planner", "running");
        break;

      case "plan.ready":
        setCrwStatus("planner", "ok");
        break;

      case "skill.built":
        setCrwStatus("skill-smith", "ok");
        break;

      case "agent.start":
        setCrwStatus("tool-smith", "running");
        setCrwStatus("prompt-writer", "running");
        break;

      case "prompt.critique":
        setCrwStatus("critic", "ok");
        break;

      case "agent.assembled":
        setCrwStatus("tool-smith", "ok");
        setCrwStatus("prompt-writer", "ok");
        // Dedupe by name (a re-plan can re-assemble the same agent) → unique keys.
        setAssembledAgents((prev) => [
          ...prev.filter((x) => x.name !== e.name),
          { name: e.name, tools: e.tools, promptSource: e.promptSource, spec: e.spec },
        ]);
        break;

      case "replan":
        // The prior attempt's agents are discarded — clear so the panel reflects
        // only the current decomposition (and avoids duplicate-key churn).
        setAssembledAgents([]);
        setCrwStatus("tool-smith", "running");
        setCrwStatus("prompt-writer", "running");
        break;

      case "validation":
        setCrwStatus("validator", e.ok ? "ok" : "warn");
        break;

      case "repair.start":
        setCrwStatus("fixer", "running");
        break;

      case "repair.done":
        setCrwStatus("fixer", "ok");
        break;

      case "smoke.result":
        setSmokeResult({ passed: e.passed, ran: e.ran, repairs: e.repairs });
        setCrewAllDone();
        break;

      case "needs-human":
        setNeedsHuman(e.reason);
        break;

      case "ship.done":
        setShipInfo({ versionLabel: e.versionLabel, deployed: e.deployed, appRegistered: e.appRegistered, error: e.error });
        break;

      case "run.observed":
        setRunInfo((prev) => ({
          fired: prev?.fired ?? [],
          runs: e.runs,
          events: e.events,
          reachedTerminal: e.reachedTerminal,
        }));
        break;

      case "run.fired":
        setRunInfo((prev) => ({
          fired: e.events,
          runs: prev?.runs ?? [],
          events: prev?.events ?? [],
          reachedTerminal: prev?.reachedTerminal ?? false,
        }));
        break;

      case "error":
        setError(e.message);
        break;
    }
  }

  function setCrewAllDone() {
    setCrew((rows) => rows.map((r) => r.status === "running" ? { ...r, status: "ok" } : r));
  }

  function runBuild() {
    if (streaming) return;
    esRef.current?.close();
    doneRef.current = false;
    reset();
    setStreaming(true);
    setTab("reason");

    const params = new URLSearchParams({ domain });
    if (FACTORY_TOKEN) params.set("token", FACTORY_TOKEN);

    const es = new EventSource(`/api/factory-v2/build/stream?${params.toString()}`);
    esRef.current = es;

    es.onmessage = (m) => {
      let e: BuildEvent;
      try { e = JSON.parse(m.data) as BuildEvent; } catch { return; }
      applyEvent(e);
      if (e.t === "build.done" || e.t === "error") {
        doneRef.current = true;
        es.close();
        setStreaming(false);
        if (e.t === "build.done") setTab("agents");
      }
    };

    es.onerror = () => {
      if (!doneRef.current) setError("流式连接中断");
      es.close();
      setStreaming(false);
    };
  }

  // Derive the latest meaningful stage label from events
  const stageLabel = (() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.t === "agent.start")       return `组装 ${e.name}…`;
      if (e.t === "facet.start")       return `分析 ${e.facet} 维度…`;
      if (e.t === "understanding.ready") return "整合领域理解…";
      if (e.t === "plan.ready")        return `规划 ${e.agents} 个 agent…`;
      if (e.t === "repair.start")      return `修复 ${e.agent}…`;
      if (e.t === "skill.built")       return `技能 ${e.name} 已构建`;
    }
    return "启动构建…";
  })();

  return (
    <div className="flex h-full min-h-0 bg-bg text-ink-1">
      <style>{`
        .fv2-sel{background:var(--c-surface);border:1px solid var(--c-line);color:var(--c-ink-1);border-radius:8px;padding:5px 9px;font-size:13px}
        .fv2-card{background:var(--c-surface);border:1px solid var(--c-line);border-radius:12px;padding:13px 15px;margin-bottom:12px}
        .fv2-blk{border:1px solid var(--c-line);border-radius:9px;margin:5px 0;overflow:hidden;background:var(--c-surface)}
        .fv2-blk>summary{cursor:pointer;padding:6px 10px;font-size:11.5px;color:var(--c-ink-2);list-style:none;font-family:ui-monospace,Menlo,monospace}
        .fv2-blk>summary::-webkit-details-marker{display:none}
        .fv2-blk .in{padding:8px 11px;border-top:1px solid var(--c-line);font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--c-ink-3);white-space:pre-wrap;line-height:1.55;max-height:280px;overflow:auto}
        .ao-code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--c-accent);background:var(--c-accent-bg);border:1px solid var(--c-line);padding:1px 5px;border-radius:5px}
        .blink{display:inline-block;width:7px;height:13px;background:var(--c-accent);margin-left:3px;vertical-align:-2px;animation:fv2b 1s steps(1) infinite}
        @keyframes fv2b{50%{opacity:0}}
      `}</style>

      {/* ── Console column ── */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0 border-r border-line">

        {/* Top bar */}
        <div className="flex items-center gap-2.5 px-6 py-3 border-b border-line shrink-0 flex-wrap">
          <span className="font-semibold text-[14px]">Agent 工厂 v2</span>
          <span className="text-[12px] text-ink-3">本体理解 → agent 组装 · 流式生成台</span>
          <div className="flex-1" />
          <label className="text-[12px] text-ink-3">业务域</label>
          <select
            className="fv2-sel"
            value={domain}
            disabled={streaming}
            onChange={(e) => { setDomain(e.target.value); reset(); }}
          >
            <option value="recruit-gen-v1">recruit-gen-v1</option>
            <option value="Agents-generation">Agents-generation</option>
          </select>
          <Btn
            variant="accent"
            size="sm"
            onClick={runBuild}
            disabled={streaming}
          >
            {streaming ? "构建中…" : "▶ 运行生成"}
          </Btn>
        </div>

        {/* Main scroll area */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          <div className="mx-auto" style={{ maxWidth: 820 }}>

            {/* Status line */}
            {buildMeta && (
              <div className="text-[12px] text-ink-3 mb-4">
                <span className="text-ink-2 font-medium">{buildMeta.domain}</span>
                {" · 本体来源 "}
                <code className="ao-code">{buildMeta.source}</code>
                {streaming && (
                  <span className="ml-2 text-ink-2">{stageLabel}<span className="blink" /></span>
                )}
              </div>
            )}

            {/* Error banner */}
            {error && (
              <div className="fv2-card" style={{ borderColor: "var(--c-err)", background: "var(--c-err-bg)" }}>
                <div className="font-semibold text-[13px]" style={{ color: "var(--c-err)" }}>构建失败</div>
                <div className="text-[12.5px] text-ink-2 mt-1">{error}</div>
              </div>
            )}

            {/* Needs-human warning */}
            {needsHuman && (
              <div className="fv2-card" style={{ borderColor: "oklch(0.5 0.14 75)", background: "var(--c-warn-bg)" }}>
                <div className="font-semibold text-[13px]" style={{ color: "oklch(0.5 0.14 75)" }}>
                  ⚠ 挂起 · 转人工
                </div>
                <div className="text-[12.5px] text-ink-2 mt-1">{needsHuman}</div>
              </div>
            )}

            {/* Empty state */}
            {!buildMeta && !streaming && !error && (
              <div className="text-ink-3 text-[13.5px] mt-10 text-center">
                选择业务域，点 <b className="text-ink-1">「▶ 运行生成」</b>。<br />
                工厂 v2 会<strong>流式</strong>展示多个构建 agent 如何逐步理解本体、协商 agent 规划、组装实现——右侧「推理」面板实时呈现。
              </div>
            )}

            {/* Assembled agents (console column) — click to view full spec/code */}
            {assembledAgents.length > 0 && (
              <>
                <div className="text-[11px] text-ink-3 mb-2 uppercase tracking-wider">
                  已组装 · {assembledAgents.length} 个 agent · 点击任意 agent 展开看完整 spec 与 LLM 生成的 prompt
                </div>
                {assembledAgents.map((a) => (
                  <AgentSpecCard key={a.spec.slug || a.name} agent={a} />
                ))}
              </>
            )}

            {/* Smoke result */}
            {smokeResult && (
              <div
                className="fv2-card"
                style={{
                  borderColor: smokeResult.passed ? "var(--c-ok)" : "var(--c-err)",
                  background: smokeResult.passed ? "var(--c-ok-bg)" : "var(--c-err-bg)",
                }}
              >
                <div
                  className="font-semibold text-[13px]"
                  style={{ color: smokeResult.passed ? "var(--c-ok)" : "var(--c-err)" }}
                >
                  {smokeResult.passed ? "✓ 冒烟验证通过" : "✗ 冒烟验证失败"}
                </div>
                <div className="text-[12.5px] text-ink-2 mt-1">
                  运行 {smokeResult.ran} 个 · 修复 {smokeResult.repairs} 次
                </div>
              </div>
            )}

          </div>
        </div>

        {/* Bottom info strip */}
        <div className="shrink-0 px-6 py-2.5 border-t border-line">
          <div
            className="text-center text-[11px] text-ink-3"
            style={{ maxWidth: 820, margin: "0 auto" }}
          >
            SSE 流式 <code className="ao-code">/api/factory-v2/build/stream</code> · 多 builder agent 协同 · 右侧面板实时呈现推理过程
          </div>
        </div>
      </div>

      {/* ── Inspector column ── */}
      <aside className="flex flex-col shrink-0 bg-panel" style={{ width: 460 }}>
        {/* Tabs */}
        <div className="flex gap-1 px-3 pt-2 border-b border-line shrink-0">
          {(
            [
              ["crew",   `班子`],
              ["reason", `推理${streaming ? " ●" : ""}`],
              ["agents", `Agents${assembledAgents.length ? ` · ${assembledAgents.length}` : ""}`],
              ["tools",  `工具库${catalog ? ` · ${catalog.length}` : ""}`],
              ["smoke",  "跑通"],
            ] as [InspectorTab, string][]
          ).map(([k, label]) => {
            const active = tab === k;
            return (
              <button
                key={k}
                onClick={() => setTab(k)}
                className="flex-1 text-[12.5px] py-2 rounded-t-md border-b-2 transition-colors"
                style={{
                  color: active ? "var(--c-ink-1)" : "var(--c-ink-3)",
                  borderBottomColor: active ? "var(--c-accent)" : "transparent",
                  background: active ? "var(--c-surface)" : "transparent",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Tab body */}
        <div className="flex-1 overflow-y-auto p-3">
          {tab === "crew" ? (
            <CrewPane crew={crew} />
          ) : tab === "reason" ? (
            <ReasonPane events={events} streaming={streaming} endRef={reasonEndRef} />
          ) : tab === "agents" ? (
            <AgentsPane agents={assembledAgents} />
          ) : tab === "tools" ? (
            <ToolsPane catalog={catalog} domain={domain} />
          ) : (
            <SmokePane result={smokeResult} needsHuman={needsHuman} ship={shipInfo} run={runInfo} />
          )}
        </div>
      </aside>
    </div>
  );
}

// ── CrewPane ─────────────────────────────────────────────────────────────────

function CrewPane({ crew }: { crew: BuilderRow[] }) {
  const dotKind = (s: DotKind): "ok" | "warn" | "err" | "info" | "idle" | "paused" => {
    if (s === "running") return "info";
    if (s === "ok")      return "ok";
    if (s === "warn")    return "warn";
    if (s === "err")     return "err";
    return "idle";
  };
  const statusLabel = (s: DotKind) =>
    s === "running" ? "构建中" :
    s === "ok"      ? "完成" :
    s === "warn"    ? "有告警" :
    s === "err"     ? "失败" : "等待";

  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-ink-3 mb-2">
        构建班子 · {crew.filter((r) => r.status !== "idle").length}/{crew.length} 已介入
      </div>
      <div className="text-[11px] text-ink-3 mb-3 leading-relaxed">
        「班子」= 工厂内部的<strong className="text-ink-2">构建 agent</strong>(builder)。它们不是工厂生成的产物,而是协同<strong className="text-ink-2">把你的产物造出来</strong>的流水线工种——读本体、规划、选工具、写 prompt、评审、验证、修复。下方按介入顺序排列,运行时实时点亮。
      </div>
      {crew.map((r) => (
        <div
          key={r.id}
          className="rounded-lg px-3 py-2.5 mb-1.5 bg-surface border border-line"
        >
          <div className="flex items-center gap-3">
            <StatusDot kind={dotKind(r.status)} />
            <span className="text-[13px] text-ink-1 font-medium">{r.label}</span>
            <span className="ml-auto text-[11px] text-ink-3">{statusLabel(r.status)}</span>
          </div>
          <div className="text-[11px] text-ink-3 mt-1 leading-snug pl-[18px]">{r.role}</div>
        </div>
      ))}
      <div className="mt-3 text-[11px] text-ink-3 rounded-lg p-2.5" style={{ background: "var(--c-accent-bg)", border: "1px solid var(--c-accent-line)" }}>
        流水线:FacetAnalyst×4 并行分析本体四维 → Integrator 整合 → Planner 规划 → SkillSmith 构建技能 →(每个目标 agent)ToolSmith 选工具 + PromptWriter 写 prompt + Critic 评审 → Validator 静态验证 → 冒烟跑不通则 Fixer 修复。全程每次 LLM 调用都留痕。
      </div>
    </div>
  );
}

// ── ToolsPane ────────────────────────────────────────────────────────────────

function ToolsPane({ catalog, domain }: { catalog: CatalogTool[] | null; domain: string }) {
  if (catalog === null) return <div className="text-ink-3 text-[12.5px] p-4 text-center">加载工具库…</div>;
  if (catalog.length === 0) {
    return (
      <div className="text-ink-3 text-[12.5px] p-4 text-center leading-relaxed">
        该域暂无工具。<br />
        要么本体未声明 <code className="font-mono text-[11px]">tool_use</code>,要么这是个通用 mock 注册表。
      </div>
    );
  }
  const seVariant = (se: CatalogTool["sideEffect"]) => (se === "read" ? "info" : se === "dual-write" ? "err" : "warn") as "info" | "err" | "warn";
  const seLabel = (se: CatalogTool["sideEffect"]) => (se === "read" ? "读" : se === "dual-write" ? "双写" : "写");
  const families = [...new Set(catalog.map((t) => t.family))].sort();
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-ink-3 mb-1">
        {domain} · 工具库 {catalog.length} 个
      </div>
      <div className="text-[11px] text-ink-3 mb-3 leading-relaxed">
        这是该业务域所有可用工具的<strong className="text-ink-2">真实注册表</strong>。生成时 ToolSmith 就从这里为每个 agent 推理并绑定工具——点任意工具<strong className="text-ink-2">查看其源码</strong>。
      </div>
      {families.map((fam) => {
        const tools = catalog.filter((t) => t.family === fam);
        return (
          <div key={fam} className="mb-4">
            <div className="text-[11.5px] font-semibold text-ink-2 mb-1.5">{fam} <span className="text-ink-3">· {tools.length}</span></div>
            {tools.map((t) => (
              <Link
                key={t.name}
                href={`/behavior/factory-v2/tool/${encodeURIComponent(t.name)}?domain=${encodeURIComponent(domain)}`}
                className="block rounded-lg bg-surface border border-line px-3 py-2.5 mb-1.5 hover:border-accent transition-colors"
              >
                <div className="flex items-center gap-2">
                  <code className="font-mono text-[11.5px] text-ink-1">{t.name}</code>
                  <span className="ml-auto flex items-center gap-1.5">
                    <Badge variant={seVariant(t.sideEffect)}>{seLabel(t.sideEffect)}</Badge>
                    <span className="text-[10.5px]" style={{ color: "var(--c-accent)" }}>查看代码 →</span>
                  </span>
                </div>
                <div className="text-[11px] text-ink-3 mt-1">{t.title}</div>
                <code className="block font-mono text-[10.5px] text-ink-3 mt-1.5" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  ({t.params}) → {t.returns}
                </code>
                <div className="text-[11px] text-ink-2 mt-1.5 leading-relaxed">{t.description}</div>
                {t.requiredEnv.length > 0 && (
                  <div className="text-[10.5px] text-ink-3 mt-1 font-mono">需要环境:{t.requiredEnv.join(", ")}</div>
                )}
              </Link>
            ))}
          </div>
        );
      })}
      <div className="text-[11px] text-ink-3 mt-2 rounded-lg p-2.5" style={{ background: "var(--c-accent-bg)", border: "1px solid var(--c-accent-line)" }}>
        工具库代码:<code className="font-mono text-[10.5px]">lib/tools/recruitment-tools.ts</code> + <code className="font-mono text-[10.5px]">lib/tools/registry.ts</code>。每个工具 = 真实客户端方法的类型化封装(JSON schema + 副作用标签 + dryRun mock)。
      </div>
    </div>
  );
}

// ── ReasonPane ───────────────────────────────────────────────────────────────

function ReasonPane({
  events,
  streaming,
  endRef,
}: {
  events: BuildEvent[];
  streaming: boolean;
  endRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (events.length === 0) {
    return (
      <div className="text-ink-3 text-[12.5px] p-4 text-center">
        运行生成后，这里实时流式展示 v2 构建班子的内部推理：读本体 → 逐维分析 → 整合理解 → 规划 → 逐 agent 组装。
      </div>
    );
  }
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-ink-3 mb-1">
        内部推理 · 实时流(SSE)
      </div>
      <div className="text-[11px] text-ink-3 mb-3 leading-relaxed">
        每条 <b className="text-ink-2">💬 LLM</b> 可展开,看该次调用的<strong className="text-ink-2">完整 system/user 输入与 output 输出</strong>、模型、是否真实调用。全部同时落库到 FactoryLlmCall 账本,可回溯。
      </div>
      <div className="relative pl-4" style={{ borderLeft: "2px solid var(--c-line)" }}>
        {events.map((e, i) => <ReasonLine key={i} e={e} />)}
        {streaming && (
          <div className="text-[12px] text-ink-3">
            <span className="blink" /> …
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function dot(color: string) {
  return (
    <span
      className="absolute rounded-full"
      style={{
        left: -21, top: 5, width: 8, height: 8,
        background: color,
        boxShadow: "0 0 0 3px var(--c-panel)",
      }}
    />
  );
}

function wrap(color: string, body: React.ReactNode) {
  return (
    <div className="relative mb-2.5">
      {dot(color)}
      <div className="text-[12.5px] text-ink-2">{body}</div>
    </div>
  );
}

const FACET_LABELS: Record<FacetKind, string> = {
  actions: "动作",
  events:  "事件",
  rules:   "规则",
  objects: "对象",
};

function ReasonLine({ e }: { e: BuildEvent }) {
  switch (e.t) {
    case "build.start":
      return wrap("var(--c-accent-2)", <>📖 开始构建 <b>{e.domain}</b> · 本体来源 <code className="ao-code">{e.source}</code></>);
    case "facet.start":
      return wrap("var(--c-accent)", <>🔍 分析 <b>{FACET_LABELS[e.facet] ?? e.facet}</b> 维度…</>);
    case "facet.analyzed":
      return wrap(
        e.degraded ? "oklch(0.5 0.14 75)" : "var(--c-ok)",
        <>
          ✓ <b>{FACET_LABELS[e.facet] ?? e.facet}</b> 分析完成
          {e.degraded && <Badge variant="warn" className="ml-1.5">降级</Badge>}
          {e.highlights.length > 0 && (
            <span className="text-ink-3 text-[11px]"> · {e.highlights[0]}{e.highlights.length > 1 ? `…+${e.highlights.length - 1}` : ""}</span>
          )}
        </>
      );
    case "llm":
      return (
        <div className="relative mb-2.5">
          {dot(e.degraded ? "oklch(0.5 0.14 75)" : "var(--c-info)")}
          <details className="fv2-blk">
            <summary>
              💬 LLM · <b>{e.builder}</b>
              {e.target ? <> → {e.target}</> : null}
              {" · "}{e.purpose}
              {e.degraded
                ? <Badge variant="warn" className="ml-1.5">降级·兜底(未真正调用)</Badge>
                : <Badge variant="ok" className="ml-1.5">真实调用</Badge>}
              {e.model && <span className="text-ink-3 ml-1.5">{e.model}</span>}
              <span className="text-ink-3 ml-2">{e.promptChars}ch → {e.responseChars}ch</span>
              <b className="ml-1.5" style={{ color: "var(--c-accent-2)" }}>· {(e.latencyMs / 1000).toFixed(1)}s 真实耗时</b>
              <span className="text-accent ml-1.5">展开看完整 input/output ▾</span>
            </summary>
            <div
              className="in"
              style={{ maxHeight: 460 }}
            >
              <div style={{ fontWeight: 700, color: "var(--c-ink-2)", marginBottom: 3 }}>▸ SYSTEM(角色与指令输入)</div>
              {e.system || "（空）"}
              <div style={{ fontWeight: 700, color: "var(--c-ink-2)", margin: "10px 0 3px" }}>▸ USER(本体/数据输入)</div>
              {e.user || "（空）"}
              <div style={{ fontWeight: 700, margin: "10px 0 3px", color: e.degraded ? "oklch(0.5 0.14 75)" : "var(--c-ok)" }}>
                ▸ OUTPUT({e.degraded ? "降级兜底,非 LLM 产物" : "LLM 真实响应"})
              </div>
              {e.response || "（空）"}
            </div>
          </details>
        </div>
      );
    case "understanding.ready":
      return wrap("var(--c-ok)", <>
        🧠 领域理解完成 · actions {e.counts.actions} / events {e.counts.events} / rules {e.counts.rules} / objects {e.counts.objects}
        {e.synthesis && <span className="text-ink-3 text-[11px]"> · {e.synthesis.slice(0, 80)}{e.synthesis.length > 80 ? "…" : ""}</span>}
      </>);
    case "plan.ready":
      return wrap("var(--c-accent)", <>📋 规划完成 · <b>{e.agents}</b> 个 agent · {e.skills} 个技能</>);
    case "skill.built":
      return wrap("var(--c-accent-2)", <>🔧 技能 <b>{e.name}</b> 已构建 · tools: <code className="font-mono text-[11px]">{e.tools.join(" ")}</code></>);
    case "agent.start":
      return wrap("var(--c-accent)", <>▶ 组装 <b>{e.name}</b></>);
    case "prompt.critique":
      return wrap(
        e.approved ? "var(--c-ok)" : "oklch(0.5 0.14 75)",
        <>
          🔬 Critic 评审 <b>{e.name}</b> · 评分 <b>{e.score.toFixed(2)}</b>
          {" · "}{e.approved ? <span style={{ color: "var(--c-ok)" }}>通过</span> : <span style={{ color: "oklch(0.5 0.14 75)" }}>待修订</span>}
        </>
      );
    case "agent.assembled":
      return wrap("var(--c-ok)", <>
        ✓ <b>{e.name}</b> 组装完成 · tools: <code className="font-mono text-[11px]">{e.tools.join(" ")}</code>
        {" · "}<Badge variant={e.promptSource === "llm" ? "info" : "default"}>{e.promptSource}</Badge>
      </>);
    case "repair.start":
      return wrap("oklch(0.5 0.14 75)", <>🔨 修复 <b>{e.agent}</b> · 原因 <code className="ao-code">{e.kind}</code></>);
    case "repair.done":
      return wrap(e.changed ? "var(--c-ok)" : "var(--c-ink-3)", <>
        ♻ 修复完成 <b>{e.agent}</b> {e.changed ? <span style={{ color: "var(--c-ok)" }}>已修订</span> : <span className="text-ink-3">无需改动</span>}
      </>);
    case "validation":
      return wrap(
        e.ok ? "var(--c-ok)" : "var(--c-err)",
        <>🔎 静态校验 {e.ok ? <span style={{ color: "var(--c-ok)" }}>通过</span> : <span style={{ color: "var(--c-err)" }}>未过</span>}
          {e.issues.length > 0 && <span className="text-ink-3 ml-1 text-[11px]">· {e.issues[0]}</span>}
        </>
      );
    case "smoke.result":
      return wrap(
        e.passed ? "var(--c-ok)" : "var(--c-err)",
        <>{e.passed ? "✅" : "✗"} 冒烟验证 {e.passed ? "通过" : "失败"} · 运行 {e.ran} 个 · 修复 {e.repairs} 次</>
      );
    case "needs-human":
      return wrap("oklch(0.5 0.14 75)", <>🙋 挂起 · 转人工: {e.reason}</>);
    case "replan":
      return wrap("oklch(0.5 0.14 75)", <>🔁 第 {e.attempt} 轮重规划 · 校验未闭合,反馈给 Planner 重新拆分</>);
    case "ship.start":
      return wrap("var(--c-accent-2)", <>🚀 上架 <b>{e.count}</b> 个 agent 到真实 Inngest app…</>);
    case "ship.done":
      return wrap(
        e.appRegistered ? "var(--c-ok)" : "var(--c-err)",
        <>
          {e.appRegistered ? "📦" : "✗"} 已落库+注册 · 版本 <code className="ao-code">{e.versionLabel}</code> · {e.deployed.length} 个 agent
          {e.error && <span style={{ color: "var(--c-err)" }} className="ml-1 text-[11px]">· {e.error}</span>}
        </>
      );
    case "run.fired":
      return wrap("var(--c-accent)", <>📨 已发出入口事件: <code className="font-mono text-[11px]">{e.events.join(" ")}</code></>);
    case "run.observed":
      return wrap(
        e.reachedTerminal ? "var(--c-ok)" : "oklch(0.5 0.14 75)",
        <>
          {e.reachedTerminal ? "🎯" : "⏳"} 真实运行 · {e.runs.length} 个 run · 链路事件 {e.events.length} 个
          {e.reachedTerminal ? <span style={{ color: "var(--c-ok)" }}> · 抵达终止事件</span> : <span className="text-ink-3"> · 未见终止(可能仍在跑)</span>}
        </>
      );
    case "build.done":
      return wrap("var(--c-ok)", <>✅ 构建完成 · 累计 token {e.tokensUsed}</>);
    case "log":
      return wrap("var(--c-ink-3)", <span className="text-ink-3 text-[11px]">{e.line}</span>);
    case "error":
      return wrap("var(--c-err)", <span style={{ color: "var(--c-err)" }}>✗ {e.message}</span>);
    default:
      return null;
  }
}

// ── AgentsPane ───────────────────────────────────────────────────────────────

function AgentsPane({ agents }: { agents: AssembledAgent[] }) {
  if (agents.length === 0) {
    return (
      <div className="text-ink-3 text-[12.5px] p-4 text-center">
        运行生成后，这里展示已组装的 agent。点任意 agent 可展开看完整 spec、LLM 生成的 system prompt、绑定的工具与执行步骤。
      </div>
    );
  }
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-ink-3 mb-3">
        已组装 · {agents.length} 个 agent · 点击展开看 spec / 代码
      </div>
      {agents.map((a) => (
        <AgentSpecCard key={a.spec.slug || a.name} agent={a} />
      ))}
    </div>
  );
}

// ── AgentSpecCard: click to view the full generated spec / "code" ─────────────

const PRE_STYLE: React.CSSProperties = {
  margin: "4px 0 0", fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11,
  lineHeight: 1.55, color: "var(--c-ink-2)", background: "var(--c-bg)",
  border: "1px solid var(--c-line)", borderRadius: 6, padding: "8px 10px",
  whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 340, overflow: "auto",
};

function SpecRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3 text-[12px] mb-1">
      <span className="text-ink-3 shrink-0" style={{ minWidth: 64 }}>{k}</span>
      <span className="text-ink-1 font-mono text-[11px]" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}

function AgentSpecCard({ agent }: { agent: AssembledAgent }) {
  const s = agent.spec;
  return (
    <details className="rounded-xl mb-2.5 bg-surface border border-line" style={{ overflow: "hidden" }}>
      <summary style={{ cursor: "pointer", listStyle: "none", padding: "11px 14px" }}>
        <div className="flex items-center gap-2">
          <StatusDot kind="ok" />
          <span className="font-semibold text-[13.5px]">{agent.name}</span>
          <Badge variant="default" className="ml-1">{s.kind}</Badge>
          <span className="ml-auto flex items-center gap-1.5">
            <Badge variant={agent.promptSource === "llm" ? "info" : "default"}>{agent.promptSource}</Badge>
            <span className="text-[10.5px]" style={{ color: "var(--c-accent)" }}>展开 spec/代码 ▾</span>
          </span>
        </div>
        <div className="font-mono text-[11px] text-ink-3 mt-1.5" style={{ wordBreak: "break-word" }}>
          {s.trigger.join("/") || "—"} → {s.emit.join("/") || "—"} · {agent.tools.length} 工具
        </div>
      </summary>
      <div style={{ borderTop: "1px solid var(--c-line)", padding: "11px 14px" }}>
        <SpecRow k="slug" v={s.slug} />
        <SpecRow k="中文名" v={s.nameZh || "—"} />
        <SpecRow k="触发事件" v={s.trigger.join(", ") || "—"} />
        <SpecRow k="发出事件" v={s.emit.join(", ") || "—"} />
        <SpecRow k="工具" v={agent.tools.join(", ") || "（无）"} />
        <SpecRow k="数据对象" v={s.objects.join(", ") || "—"} />
        <SpecRow k="retries / 置信度" v={`retries=${s.retries} · confidence=${s.confidence}`} />

        <div className="text-[10.5px] uppercase tracking-wider text-ink-3 mt-3 mb-0.5">执行步骤 steps</div>
        <div className="font-mono text-[11px] text-ink-3">
          {s.steps.length
            ? s.steps.map((st, i) => <div key={i}>{i + 1}. {st.name}{st.tool ? ` → ${st.tool}` : "(判定逻辑)"}</div>)
            : "（无）"}
        </div>

        <div className="text-[10.5px] uppercase tracking-wider text-ink-3 mt-3 mb-0.5">
          SYSTEM PROMPT · LLM 生成的"代码"({agent.promptSource === "llm" ? "真实 LLM 撰写" : agent.promptSource})
        </div>
        <pre style={PRE_STYLE}>{s.systemPrompt || "（空）"}</pre>

        <div className="text-[10.5px] uppercase tracking-wider text-ink-3 mt-3 mb-0.5">USER PROMPT · 运行时输入模板</div>
        <pre style={{ ...PRE_STYLE, maxHeight: 220 }}>{s.userPrompt || "（空）"}</pre>
      </div>
    </details>
  );
}

// ── SmokePane ────────────────────────────────────────────────────────────────

function SmokePane({
  result,
  needsHuman,
  ship,
  run,
}: {
  result: SmokeResult | null;
  needsHuman: string | null;
  ship: ShipInfo | null;
  run: RunInfo | null;
}) {
  if (!result && !needsHuman && !ship && !run) {
    return (
      <div className="text-ink-3 text-[12.5px] p-4 text-center leading-relaxed">
        构建完成后这里显示三件事:<br />
        ① 冒烟验证(进程内链路模拟)→ ② 上架到真实 Inngest app → ③ 发出入口事件后,真实运行在归档里观测到的 runId 与链路事件。
      </div>
    );
  }
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-ink-3 mb-3">验证 · 上架 · 真实运行</div>

      {result && (
        <div
          className="rounded-lg border px-3.5 py-3 mb-3"
          style={{
            background: result.passed ? "var(--c-ok-bg)" : "var(--c-err-bg)",
            borderColor: result.passed ? "var(--c-ok)" : "var(--c-err)",
          }}
        >
          <div
            className="font-semibold text-[13px]"
            style={{ color: result.passed ? "var(--c-ok)" : "var(--c-err)" }}
          >
            ① {result.passed ? "✓ 冒烟通过(进程内模拟)" : "✗ 冒烟失败"}
          </div>
          <div className="text-[12.5px] text-ink-2 mt-1.5 flex gap-4">
            <span>运行 <b className="text-ink-1">{result.ran}</b> 个</span>
            <span>修复 <b className="text-ink-1">{result.repairs}</b> 次</span>
          </div>
        </div>
      )}

      {ship && (
        <div
          className="rounded-lg border px-3.5 py-3 mb-3"
          style={{
            background: ship.appRegistered ? "var(--c-ok-bg)" : "var(--c-err-bg)",
            borderColor: ship.appRegistered ? "var(--c-ok)" : "var(--c-err)",
          }}
        >
          <div className="font-semibold text-[13px]" style={{ color: ship.appRegistered ? "var(--c-ok)" : "var(--c-err)" }}>
            ② {ship.appRegistered ? "📦 已上架到真实 Inngest" : "✗ 上架/注册失败"}
          </div>
          <div className="text-[12px] text-ink-2 mt-1.5">
            版本 <code className="ao-code">{ship.versionLabel || "—"}</code> · 部署 <b className="text-ink-1">{ship.deployed.length}</b> 个 agent · app <code className="font-mono text-[11px]">agentic-operator-…</code>
          </div>
          {ship.error && <div className="text-[11px] mt-1" style={{ color: "var(--c-err)" }}>{ship.error}</div>}
        </div>
      )}

      {run && (
        <div
          className="rounded-lg border px-3.5 py-3 mb-3"
          style={{
            background: run.reachedTerminal ? "var(--c-ok-bg)" : "var(--c-warn-bg)",
            borderColor: run.reachedTerminal ? "var(--c-ok)" : "color-mix(in oklab, var(--c-warn) 40%, transparent)",
          }}
        >
          <div className="font-semibold text-[13px]" style={{ color: run.reachedTerminal ? "var(--c-ok)" : "oklch(0.5 0.14 75)" }}>
            ③ {run.reachedTerminal ? "🎯 真实运行抵达终止事件" : "⏳ 真实运行(未见终止事件)"}
          </div>
          {run.fired.length > 0 && (
            <div className="text-[11.5px] text-ink-2 mt-1.5">
              入口事件:{run.fired.map((f) => <code key={f} className="font-mono text-[11px] mr-1">{f}</code>)}
            </div>
          )}
          {run.runs.length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] text-ink-3 mb-1">归档中的真实 run({run.runs.length}):</div>
              {run.runs.slice(0, 8).map((r) => (
                <div key={r.runId} className="text-[10.5px] font-mono text-ink-3 flex items-center gap-1.5">
                  <StatusDot kind={/complete/i.test(r.status) ? "ok" : /fail|cancel/i.test(r.status) ? "err" : "info"} />
                  <span className="truncate" style={{ maxWidth: 250 }}>{r.runId}</span>
                  <span className="ml-auto">{r.status}</span>
                </div>
              ))}
            </div>
          )}
          {run.events.length > 0 && (
            <details className="mt-2">
              <summary className="text-[11px] text-ink-3 cursor-pointer">链路事件 {run.events.length} 个</summary>
              <div className="text-[10.5px] font-mono text-ink-3 mt-1 leading-relaxed" style={{ wordBreak: "break-word" }}>
                {run.events.join(" · ")}
              </div>
            </details>
          )}
        </div>
      )}

      {needsHuman && (
        <div
          className="rounded-lg border px-3.5 py-3"
          style={{
            background: "var(--c-warn-bg)",
            borderColor: "color-mix(in oklab, var(--c-warn) 40%, transparent)",
          }}
        >
          <div className="font-semibold text-[13px]" style={{ color: "oklch(0.5 0.14 75)" }}>
            ⚠ 挂起 · 转人工
          </div>
          <div className="text-[12.5px] text-ink-2 mt-1">{needsHuman}</div>
        </div>
      )}
    </div>
  );
}
