"use client";

// 外部事件触发台 (External Event Trigger) — multi-domain.
//
// A standalone, chrome-less console meant to be opened from ANY machine on the
// LAN (the dev server binds 0.0.0.0:3002 → http://<host>:3002/trigger/energy).
// Pick a 业务领域 (能源调度 / 费控) + a scenario; one click POSTs the real seed
// endpoint (/api/ontology-generator/run), which deploys+activates that domain's
// agents, builds the real scenario dataset, registers the per-domain Inngest app
// and sends the domain's seed event.
//
// After triggering you can watch the chain run in Inngest (:8288) and in AO
// (/monitor · /rule-check), and the 人工节点 (HITL gate) pushes show up in AO
// 消息通知 (/notifications) + the 值班工作台 companion (:4180).
//
// Deliberately NOT wrapped in <Shell> — it's an external single-purpose surface.
// (Route stays /trigger/energy for back-compat; it now serves all runnable
// domains via the switcher.)

import React from "react";
import { Btn, Badge, Card, StatusDot } from "@/components/shared/atoms";

type Tone = "ok" | "warn" | "err" | "info";
type ScenarioDef = {
  id: string;
  title: string;
  desc: string;
  outcome: string;
  gate: string | null;
  tone: Tone;
};
type DomainDef = {
  id: string;
  label: string;
  seedEvent: string;
  intro: string;
  datasetPath: string;
  scenarios: ScenarioDef[];
};

const DOMAINS: DomainDef[] = [
  {
    id: "能源调度-v1",
    label: "能源调度",
    seedEvent: "energy/DISPATCH_CYCLE_STARTED",
    intro:
      "选择一个调度场景,点击即向 energy/DISPATCH_CYCLE_STARTED 推送真实数据集,启动 28 个能源调度智能体链路。",
    datasetPath: "neo4j_data/能源调度-v1/test-cases/能源调度-test-datasets.json",
    scenarios: [
      {
        id: "happy",
        title: "直通放行",
        desc: "出力/建议/约束全部达标,置信度与关口偏差在直通阈内。",
        outcome: "四阶段校验通过 · 分流自动采纳(直通,无人工节点)",
        gate: null,
        tone: "ok",
      },
      {
        id: "manual-review",
        title: "转人工确认",
        desc: "置信度或关口偏差越过直通阈,分流判定转人工。",
        outcome: "分流=MANUAL · 触发「人工确认」闸口 manualConfirm",
        gate: "人工确认 · manualConfirm",
        tone: "warn",
      },
      {
        id: "risk-redline",
        title: "红线风险",
        desc: "约束校验命中硬红线(水位 1613.2m 超汛限 1612m)。",
        outcome: "约束=VIOLATED+红线 · 触发「防汛处置」闸口 handleFloodControl",
        gate: "防汛处置 · handleFloodControl",
        tone: "err",
      },
      {
        id: "finalize-confirm",
        title: "定版封口",
        desc: "全部校验通过,进入收口阶段等待值班长定版。",
        outcome: "校验通过 · 触发「定版封口」闸口 finalizePlan",
        gate: "定版封口 · finalizePlan",
        tone: "info",
      },
    ],
  },
  {
    id: "费控-v1",
    label: "费控",
    seedEvent: "feikong/EXPENSE_SUBMITTED",
    intro:
      "选择一个费控场景,点击即向 feikong/EXPENSE_SUBMITTED 推送真实报销单数据,启动费控智能体链路(OCR→规则校验→预算→审批建议→分流→审批→过账→付款→归档)。",
    datasetPath: "neo4j_data/费控-v1/instance-data_费控-v1.json",
    scenarios: [
      {
        id: "happy",
        title: "直通自动核准",
        desc: "合计≤2万、单票≤5千、OCR≥0.95 且验真、无风险、预算充足。",
        outcome: "四组规则通过 · PIPE-01 五条件全满足 → 自动核准 → 过账·付款·归档(无人工节点)",
        gate: null,
        tone: "ok",
      },
      {
        id: "deduction",
        title: "超标核减 · 转人工",
        desc: "成都(二类)主管住宿 480/晚,超上限 400/晚 → 核减 160。",
        outcome: "STD-01 核减 160(可报 1353)→ 转人工复核核减额 manualReview",
        gate: "人工复核 · manualReview",
        tone: "warn",
      },
      {
        id: "risk-split",
        title: "大额拆分风险",
        desc: "同报销人+同供应商 7 日内三单各 18,500,聚合 55,500 绕审批档。",
        outcome: "CMP-01 命中 T4/L3 → 风险事件 → 暂停付款 → 处置闸口 disposeRiskEvent",
        gate: "风险处置 · disposeRiskEvent",
        tone: "err",
      },
      {
        id: "risk-private",
        title: "疑似私人消费",
        desc: "办公费发票混入游戏手柄/儿童奶粉/智能手表等私人物品(2,518)。",
        outcome: "CMP-06 命中 T7/L4 → 移送稽核 + 暂停付款 → 处置闸口 disposeRiskEvent",
        gate: "风险处置 · disposeRiskEvent",
        tone: "err",
      },
    ],
  },
];

type RunResult = {
  ok: boolean;
  caseId?: string;
  seedEvent?: string;
  scenario?: string;
  deployed?: { deployed: number; total: number } | null;
  expect?: ({ gate?: string | null } & Record<string, unknown>) | null;
  ids?: string[];
  error?: string;
};

type RunRow = { domainId: string; scenario: string; title: string; res: RunResult; at: string };

export default function EventTriggerPage() {
  const [domainId, setDomainId] = React.useState(DOMAINS[0].id);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [runs, setRuns] = React.useState<RunRow[]>([]);
  const [host, setHost] = React.useState("localhost");

  React.useEffect(() => {
    setHost(window.location.hostname || "localhost");
  }, []);

  const domain = DOMAINS.find((d) => d.id === domainId) ?? DOMAINS[0];

  async function trigger(sc: ScenarioDef) {
    if (busy) return;
    setBusy(sc.id);
    const at = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    try {
      const r = await fetch("/api/ontology-generator/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domainId: domain.id, scenario: sc.id }),
      });
      const res: RunResult = await r.json();
      setRuns((prev) => [{ domainId: domain.id, scenario: sc.id, title: sc.title, res, at }, ...prev].slice(0, 8));
    } catch (e) {
      setRuns((prev) =>
        [{ domainId: domain.id, scenario: sc.id, title: sc.title, res: { ok: false, error: (e as Error).message }, at }, ...prev].slice(0, 8),
      );
    } finally {
      setBusy(null);
    }
  }

  const latest = runs[0];
  const inngestUrl = `http://${host}:8288`;
  const companionUrl = `http://${host}:4180`;

  return (
    <div className="min-h-screen bg-bg text-ink-1" style={{ background: "var(--c-bg)" }}>
      <div className="max-w-[920px] mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2.5">
            <StatusDot kind="ok" />
            <h1 className="text-[22px] font-bold leading-none">外部事件触发台</h1>
          </div>
          <Badge variant="info" dot>
            {domain.id}
          </Badge>
        </div>

        {/* Domain switcher */}
        <div className="flex items-center gap-2 mt-4 mb-3">
          <span className="text-[11px] text-ink-4 uppercase tracking-[0.06em]">业务领域</span>
          <div className="flex gap-1.5">
            {DOMAINS.map((d) => {
              const active = d.id === domainId;
              return (
                <button
                  key={d.id}
                  onClick={() => setDomainId(d.id)}
                  className="rounded-full text-[12.5px] transition-colors"
                  style={{
                    padding: "5px 16px",
                    border: `1px solid ${active ? "var(--c-accent)" : "var(--c-line)"}`,
                    background: active ? "color-mix(in oklab, var(--c-accent) 18%, var(--c-bg))" : "var(--c-panel)",
                    color: active ? "var(--c-ink-1)" : "var(--c-ink-3)",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>

        <p className="text-[12.5px] text-ink-3 mb-6">{domain.intro}</p>

        {/* Scenario cards */}
        <div className="grid gap-3 mb-7" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {domain.scenarios.map((sc) => (
            <Card key={sc.id} className="flex flex-col">
              <div className="px-4 pt-3.5 pb-3 flex flex-col gap-2 flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant={sc.tone} dot>
                    {sc.title}
                  </Badge>
                  {sc.gate ? (
                    <span className="text-[10.5px] text-ink-4">含人工节点</span>
                  ) : (
                    <span className="text-[10.5px] text-ink-4">无人工节点</span>
                  )}
                </div>
                <div className="text-[12px] text-ink-2 leading-relaxed">{sc.desc}</div>
                <div className="text-[11px] text-ink-4 leading-relaxed mt-auto">预期:{sc.outcome}</div>
              </div>
              <div className="px-4 py-2.5 border-t border-line bg-panel">
                <Btn
                  variant="primary"
                  className="w-full justify-center"
                  disabled={!!busy}
                  onClick={() => trigger(sc)}
                >
                  {busy === sc.id ? "正在发送…" : "发送事件 · 启动链路"}
                </Btn>
              </div>
            </Card>
          ))}
        </div>

        {/* Latest result + watch links */}
        {latest && (
          <Card className="mb-6">
            <div className="px-4 py-3 border-b border-line flex items-center gap-2.5">
              {latest.res.ok ? <StatusDot kind="ok" /> : <StatusDot kind="err" />}
              <span className="text-[13px] font-semibold">{latest.res.ok ? "事件已发送" : "发送失败"}</span>
              <span className="text-[11px] text-ink-4">
                {latest.at} · {DOMAINS.find((d) => d.id === latest.domainId)?.label ?? latest.domainId}
              </span>
            </div>
            <div className="px-4 py-3.5 text-[12px]">
              {latest.res.ok ? (
                <>
                  <div className="grid gap-1.5 mb-3.5" style={{ gridTemplateColumns: "auto 1fr" }}>
                    <span className="text-ink-4">案件 caseId</span>
                    <span className="mono text-ink-1">{latest.res.caseId}</span>
                    <span className="text-ink-4">种子事件</span>
                    <span className="mono text-ink-1">{latest.res.seedEvent}</span>
                    <span className="text-ink-4">已部署</span>
                    <span className="text-ink-1">
                      {latest.res.deployed
                        ? `${latest.res.deployed.deployed}/${latest.res.deployed.total} 智能体激活`
                        : "—"}
                    </span>
                    <span className="text-ink-4">人工节点</span>
                    <span className="text-ink-1">
                      {latest.res.expect?.gate ? (
                        <Badge variant="warn" dot>
                          将在 {latest.res.expect.gate} 挂起等待
                        </Badge>
                      ) : (
                        "无(自动直通)"
                      )}
                    </span>
                  </div>
                  <div className="text-[11px] text-ink-4 mb-1.5">实时观察:</div>
                  <div className="flex flex-wrap gap-2">
                    <a href={inngestUrl} target="_blank" rel="noreferrer">
                      <Btn size="sm">Inngest 运行链路 ↗</Btn>
                    </a>
                    <a href="/monitor" target="_blank" rel="noreferrer">
                      <Btn size="sm">AO 监控 ↗</Btn>
                    </a>
                    <a href="/rule-check" target="_blank" rel="noreferrer">
                      <Btn size="sm">Rule Check 审计 ↗</Btn>
                    </a>
                    <a href="/notifications" target="_blank" rel="noreferrer">
                      <Btn size="sm" variant={latest.res.expect?.gate ? "accent" : "default"}>
                        消息通知 · 人工节点 ↗
                      </Btn>
                    </a>
                    <a href={companionUrl} target="_blank" rel="noreferrer">
                      <Btn size="sm">值班工作台(处置人工节点) ↗</Btn>
                    </a>
                  </div>
                </>
              ) : (
                <div className="text-[color:var(--c-err)]">{latest.res.error ?? "未知错误"}</div>
              )}
            </div>
          </Card>
        )}

        {/* Recent triggers */}
        {runs.length > 1 && (
          <div>
            <div className="text-[11px] text-ink-4 uppercase tracking-[0.06em] mb-2">最近触发</div>
            <Card>
              <div className="divide-y divide-[color:var(--c-line)]">
                {runs.slice(1).map((row, i) => (
                  <div key={i} className="px-4 py-2 flex items-center gap-3 text-[12px]">
                    <span className="text-ink-4 mono text-[11px] w-[64px]">{row.at}</span>
                    <span className="text-ink-4 text-[11px] w-[64px]">
                      {DOMAINS.find((d) => d.id === row.domainId)?.label ?? row.domainId}
                    </span>
                    <span className="w-[96px]">{row.title}</span>
                    {row.res.ok ? (
                      <span className="mono text-[11px] text-ink-2 flex-1 truncate">{row.res.caseId}</span>
                    ) : (
                      <span className="text-[11px] text-[color:var(--c-err)] flex-1 truncate">{row.res.error}</span>
                    )}
                    <StatusDot kind={row.res.ok ? "ok" : "err"} />
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        <div className="mt-8 text-[10.5px] text-ink-4 leading-relaxed">
          外部对接(裸事件):<span className="mono">POST http://{host}:8288/e/&lt;INNGEST_EVENT_KEY&gt;</span>{" "}
          body <span className="mono">{`{ name: "${domain.seedEvent}", data: {…dataset} }`}</span>。
          数据集结构见 <span className="mono">{domain.datasetPath}</span>。
        </div>
      </div>
    </div>
  );
}
