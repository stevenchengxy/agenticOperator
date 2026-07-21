"use client";
// AI 事实审查视图 — 监控层 P2/P3 的只读面:确定性告警簇(triage)、抽样
// groundedness 判定、judge↔human 校准矩阵。独立页面,不动既有 MonitorContent。
import React from "react";

interface Cluster {
  key: string;
  prefix: string;
  domain: string | null;
  total: number;
  alerts: { dedupeKey: string; severity: string; count: number }[];
}
interface EvalRow {
  id: string;
  ts: string;
  domain: string | null;
  agent: string | null;
  verdict: string | null;
  score: number | null;
  primaryAgreed: boolean | null;
  auditId: string | null;
}
interface Matrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  kappa: number;
}

const PREFIX_LABEL: Record<string, string> = {
  run_stalled: "运行停滞",
  sla_breach: "处理超时",
  cost: "成本",
  error_rate: "错误率",
  groundedness: "事实审查",
};

function verdictColor(v: string | null): string {
  if (v === "grounded") return "var(--c-ok)";
  if (v === "not_grounded") return "var(--c-err)";
  return "var(--c-ink-2)";
}
function verdictLabel(v: string | null): string {
  if (v === "grounded") return "依据充分";
  if (v === "not_grounded") return "依据存疑";
  return "不确定";
}

export function MonitorEvalsContent() {
  const [clusters, setClusters] = React.useState<Cluster[]>([]);
  const [evals, setEvals] = React.useState<EvalRow[]>([]);
  const [matrix, setMatrix] = React.useState<Matrix | null>(null);
  const [labelled, setLabelled] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [triggering, setTriggering] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [f, c] = await Promise.all([
        fetch("/api/monitor/findings")
          .then((r) => r.json())
          .catch(() => ({ clusters: [], recentEvals: [] })),
        fetch("/api/monitor/calibration")
          .then((r) => r.json())
          .catch(() => ({ matrix: null, labelledCount: 0 })),
      ]);
      setClusters(f.clusters ?? []);
      setEvals(f.recentEvals ?? []);
      setMatrix(c.matrix ?? null);
      setLabelled(c.labelledCount ?? 0);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const trigger = async () => {
    setTriggering(true);
    try {
      await fetch("/api/monitor/eval", { method: "POST" });
      await new Promise((r) => setTimeout(r, 2000));
      await load();
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink-1">AI 事实审查 · 监控</h1>
          <p className="text-sm text-ink-2">
            确定性告警 + 抽样 groundedness 判官(跨家族陪审团)+ judge↔human 校准
          </p>
        </div>
        <button
          type="button"
          onClick={trigger}
          disabled={triggering}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink-1 disabled:opacity-50"
        >
          {triggering ? "审查中…" : "触发一次抽样审查"}
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-ink-2">加载中…</div>
      ) : (
        <div className="grid gap-6" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {/* 告警簇 */}
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink-1">实时告警簇</h2>
            {clusters.length === 0 ? (
              <div className="text-sm text-ink-2">当前无告警</div>
            ) : (
              <ul className="space-y-2">
                {clusters.map((c) => (
                  <li key={c.key} className="flex items-center justify-between text-sm">
                    <span className="text-ink-1">
                      {PREFIX_LABEL[c.prefix] ?? c.prefix}
                      {c.domain ? <span className="text-ink-2"> · {c.domain}</span> : null}
                    </span>
                    <span className="text-ink-2">
                      {c.alerts.length} 条 · 累计 {c.total}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 校准矩阵 */}
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink-1">judge↔human 校准</h2>
            {!matrix || labelled === 0 ? (
              <div className="text-sm text-ink-2">尚无人工标注样本</div>
            ) : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <Stat label="样本" value={String(labelled)} />
                <Stat label="κ (Cohen)" value={matrix.kappa.toFixed(2)} />
                <Stat label="精确率" value={pct(matrix.precision)} />
                <Stat label="召回率" value={pct(matrix.recall)} />
                <Stat label="F1" value={matrix.f1.toFixed(2)} />
                <Stat label="准确率" value={pct(matrix.accuracy)} />
                <Stat label="TP/FP" value={`${matrix.tp}/${matrix.fp}`} />
                <Stat label="FN/TN" value={`${matrix.fn}/${matrix.tn}`} />
              </div>
            )}
          </section>

          {/* 最近判定 */}
          <section className="col-span-2 rounded-lg border border-line bg-surface p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink-1">最近事实审查判定</h2>
            {evals.length === 0 ? (
              <div className="text-sm text-ink-2">尚无判定记录(触发一次抽样审查后出现)</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-ink-2">
                    <th className="pb-2 font-normal">时间</th>
                    <th className="pb-2 font-normal">Agent</th>
                    <th className="pb-2 font-normal">域</th>
                    <th className="pb-2 font-normal">判定</th>
                    <th className="pb-2 font-normal">分数</th>
                    <th className="pb-2 font-normal">陪审团一致</th>
                  </tr>
                </thead>
                <tbody>
                  {evals.map((e) => (
                    <tr key={e.id} className="border-t border-line">
                      <td className="py-1.5 text-ink-2">{new Date(e.ts).toLocaleString()}</td>
                      <td className="py-1.5 text-ink-1">{e.agent ?? "—"}</td>
                      <td className="py-1.5 text-ink-2">{e.domain ?? "—"}</td>
                      <td className="py-1.5" style={{ color: verdictColor(e.verdict) }}>
                        {verdictLabel(e.verdict)}
                      </td>
                      <td className="py-1.5 text-ink-1">{e.score == null ? "—" : pct(e.score)}</td>
                      <td className="py-1.5 text-ink-2">
                        {e.primaryAgreed == null ? "—" : e.primaryAgreed ? "一致" : "分歧(已升陪审团)"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-2">{label}</span>
      <span className="text-ink-1">{value}</span>
    </div>
  );
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
