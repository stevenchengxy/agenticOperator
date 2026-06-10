"use client";
// 运行统计页 — 每个智能体按小时/天/周 run 了多少次、叫了多少次 RoboHire 等
// 外部服务。数据全部来自 Docker 本地 Postgres(/api/analytics/stats:
// inngest_run_archive + log_event category='api')。图表是手绘 SVG,
// 复用 monitor 的图表惯例(viewBox + CSS 变量配色),不引第三方库。
import React from "react";
import { useApp } from "@/lib/i18n";
import { Card, CardHead, Badge, EmptyState, Metric } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { fetchJson } from "@/lib/api/client";
import type {
  AgentRunStats,
  ApiCallAggregation,
  RunAggregation,
  StatsBucket,
  StatsWindow,
} from "@/lib/analytics/stats";

type StatsResponse = {
  window: StatsWindow;
  bucket: StatsBucket;
  buckets: number[];
  runs: RunAggregation;
  apiCalls: ApiCallAggregation;
  kpi: { totalRuns: number; failedRuns: number; totalApiCalls: number; robohireCalls: number };
  error?: string;
};

const WINDOWS: { key: StatsWindow; label: string }[] = [
  { key: "24h", label: "anx_window_24h" },
  { key: "7d", label: "anx_window_7d" },
  { key: "30d", label: "anx_window_30d" },
];
const BUCKETS_FOR: Record<StatsWindow, StatsBucket[]> = {
  "24h": ["hour"],
  "7d": ["day", "hour"],
  "30d": ["day", "week"],
};
const BUCKET_LABEL: Record<StatsBucket, string> = {
  hour: "anx_bucket_hour",
  day: "anx_bucket_day",
  week: "anx_bucket_week",
};

// 智能体序列固定配色 — 取自全局 OKLCH 色相环,深浅主题下都可读。
const SERIES_COLORS = [
  "oklch(0.62 0.14 250)",
  "oklch(0.65 0.13 150)",
  "oklch(0.68 0.14 75)",
  "oklch(0.60 0.15 320)",
  "oklch(0.63 0.13 25)",
  "oklch(0.66 0.10 200)",
  "oklch(0.58 0.12 290)",
  "oklch(0.64 0.12 110)",
];
const OTHER_COLOR = "var(--c-ink-4)";
const PROVIDER_COLORS: Record<string, string> = {
  robohire: "oklch(0.62 0.14 250)",
  allmeta: "oklch(0.65 0.13 150)",
  "partner-pg": "oklch(0.68 0.14 75)",
  rmhr: "oklch(0.60 0.15 320)",
};

export function AnalyticsContent() {
  const { t, lang } = useApp();
  const [window_, setWindow] = React.useState<StatsWindow>("24h");
  const [bucket, setBucket] = React.useState<StatsBucket>("hour");
  const [data, setData] = React.useState<StatsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [backendError, setBackendError] = React.useState<string | null>(null);
  const [agentFilter, setAgentFilter] = React.useState<string | null>(null);

  const pickWindow = (w: StatsWindow) => {
    setWindow(w);
    setBucket(BUCKETS_FOR[w][0]);
    setAgentFilter(null); // 换窗口后旧筛选可能不在新窗口里,清掉避免空图死局
  };

  const load = React.useCallback(async () => {
    try {
      const res = await fetchJson<StatsResponse>(`/api/analytics/stats?window=${window_}&bucket=${bucket}`);
      setBackendError(res.error ?? null);
      // 后端报错时(200 + error 字段,数据全零)保留上一份好数据,只亮错误标;
      // 全零假数据会误导运维"agents 没在跑"。
      setData((prev) => (res.error && prev ? prev : res));
    } catch {
      /* 网络失败:keep last */
    } finally {
      setLoading(false);
    }
  }, [window_, bucket]);

  React.useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const agents = data?.runs.agents ?? [];
  // 选中的 agent 可能在自动刷新后退出窗口(30 天→24 小时缩窗等),失效即视为未筛选。
  const effFilter = agentFilter && agents.some((a) => a.slug === agentFilter) ? agentFilter : null;
  const shownAgents = effFilter ? agents.filter((a) => a.slug === effFilter) : agents;
  const failRate = data && data.kpi.totalRuns > 0 ? ((data.kpi.failedRuns / data.kpi.totalRuns) * 100).toFixed(1) + "%" : "0%";

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* sub-header */}
      <div className="border-b border-line bg-surface flex items-center" style={{ padding: "14px 22px", gap: 18 }}>
        <div>
          <div className="text-[15px] font-semibold tracking-tight">{t("anx_title")}</div>
          <div className="text-ink-3 text-[12px] mt-px">{t("anx_subtitle")}</div>
        </div>
        <div className="flex-1" />
        {backendError && (
          <span title={backendError}>
            <Badge variant="warn" dot>{t("anx_backend_error")}</Badge>
          </span>
        )}
        <div className="flex items-center gap-1 bg-panel rounded-md p-0.5 border border-line">
          {WINDOWS.map((w) => (
            <Pill key={w.key} active={window_ === w.key} onClick={() => pickWindow(w.key)}>
              {t(w.label)}
            </Pill>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-panel rounded-md p-0.5 border border-line">
          {BUCKETS_FOR[window_].map((b) => (
            <Pill key={b} active={bucket === b} onClick={() => setBucket(b)}>
              {t(BUCKET_LABEL[b])}
            </Pill>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto" style={{ padding: "16px 22px" }}>
        {/* KPI strip */}
        <div className="grid grid-cols-5 gap-3 mb-4">
          <Card><Metric label={t("anx_kpi_runs")} value={data?.kpi.totalRuns ?? "—"} /></Card>
          <Card><Metric label={t("anx_kpi_failed")} value={data?.kpi.failedRuns ?? "—"} /></Card>
          <Card><Metric label={t("anx_kpi_fail_rate")} value={failRate} /></Card>
          <Card><Metric label={t("anx_kpi_api_calls")} value={data?.kpi.totalApiCalls ?? "—"} /></Card>
          <Card><Metric label={t("anx_kpi_robohire")} value={data?.kpi.robohireCalls ?? "—"} /></Card>
        </div>

        {/* agent filter pills */}
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          <Pill active={effFilter === null} onClick={() => setAgentFilter(null)}>
            {t("anx_agents_all")}
          </Pill>
          {agents.slice(0, 10).map((a, i) => (
            <Pill key={a.slug} active={effFilter === a.slug} onClick={() => setAgentFilter(effFilter === a.slug ? null : a.slug)}>
              <span className="inline-block w-2 h-2 rounded-sm mr-1 align-middle" style={{ background: colorFor(i) }} />
              {shortName(a)}
            </Pill>
          ))}
        </div>

        {/* runs chart */}
        <Card className="mb-4">
          <CardHead>
            <span>{t("anx_chart_runs")}</span>
            <span className="flex-1" />
            <Badge variant="info">{loading ? "…" : `${data?.kpi.totalRuns ?? 0}`}</Badge>
          </CardHead>
          {data && data.buckets.length > 0 && data.kpi.totalRuns > 0 ? (
            <StackedBarChart
              buckets={data.buckets}
              bucket={data.bucket}
              series={shownAgents.slice(0, 8).map((a, i) => ({
                key: a.slug,
                label: shortName(a),
                color: effFilter ? colorFor(agents.findIndex((x) => x.slug === a.slug)) : colorFor(i),
                values: a.series,
              }))}
              rest={effFilter ? null : restSeries(agents, data.buckets.length)}
              lang={lang}
            />
          ) : (
            <EmptyState icon={<Ic.gauge />} title={t("anx_empty_runs")} variant="info" />
          )}
        </Card>

        {/* external calls chart */}
        <Card className="mb-4">
          <CardHead>
            <span>{t("anx_chart_calls")}</span>
            <span className="flex-1" />
            <Badge variant="info">{loading ? "…" : `${data?.kpi.totalApiCalls ?? 0}`}</Badge>
          </CardHead>
          {data && data.apiCalls.providers.length > 0 ? (
            <StackedBarChart
              buckets={data.buckets}
              bucket={data.bucket}
              series={data.apiCalls.providers.map((p, i) => ({
                key: p.provider,
                label: providerLabel(p.provider, lang),
                color: PROVIDER_COLORS[p.provider] ?? colorFor(i),
                values: p.series,
              }))}
              rest={null}
              lang={lang}
            />
          ) : (
            <EmptyState icon={<Ic.plug />} title={t("anx_empty_calls")} variant="info" />
          )}
        </Card>

        {/* breakdown tables */}
        <div className="grid gap-4" style={{ gridTemplateColumns: "1.2fr 1fr 1fr" }}>
          <Card>
            <CardHead>{t("anx_table_agents")}</CardHead>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("anx_col_agent")}</th>
                  <th style={{ textAlign: "right" }}>{t("anx_col_runs")}</th>
                  <th style={{ textAlign: "right" }}>{t("anx_col_failed")}</th>
                </tr>
              </thead>
              <tbody>
                {agents.slice(0, 14).map((a, i) => (
                  <tr key={a.slug}>
                    <td>
                      <span className="inline-block w-2 h-2 rounded-sm mr-1.5" style={{ background: colorFor(i) }} />
                      <span title={a.slug}>{shortName(a)}</span>
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>{a.total}</td>
                    <td className="mono" style={{ textAlign: "right", color: a.failed > 0 ? "var(--c-err)" : undefined }}>
                      {a.failed}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card>
            <CardHead>{t("anx_table_ops")}</CardHead>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("anx_col_op")}</th>
                  <th style={{ textAlign: "right" }}>{t("anx_col_count")}</th>
                  <th style={{ textAlign: "right" }}>{t("anx_col_errors")}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.apiCalls.operations ?? []).slice(0, 14).map((o) => (
                  <tr key={`${o.provider}|${o.op}`}>
                    <td>
                      <Badge variant="default" className="mr-1.5">{providerLabel(o.provider, lang)}</Badge>
                      <span className="mono text-[11px]">{o.op}</span>
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>{o.count}</td>
                    <td className="mono" style={{ textAlign: "right", color: o.errors > 0 ? "var(--c-err)" : undefined }}>
                      {o.errors}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card>
            <CardHead>{t("anx_table_by_agent")}</CardHead>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("anx_col_agent")}</th>
                  <th>{t("anx_col_provider")}</th>
                  <th style={{ textAlign: "right" }}>{t("anx_col_count")}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.apiCalls.byAgent ?? []).slice(0, 14).map((g, i) => (
                  <tr key={i}>
                    <td className="mono text-[11px]">{g.agent ?? t("anx_unattributed")}</td>
                    <td><Badge variant="default">{providerLabel(g.provider, lang)}</Badge></td>
                    <td className="mono" style={{ textAlign: "right" }}>{g.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11.5px] px-2 py-1 rounded whitespace-nowrap ${active ? "bg-accent-bg text-accent font-medium" : "text-ink-3 hover:text-ink-1"}`}
    >
      {children}
    </button>
  );
}

function colorFor(i: number): string {
  return i >= 0 && i < SERIES_COLORS.length ? SERIES_COLORS[i] : OTHER_COLOR;
}

// 外部服务的业务显示名(robohire/partner-pg 是内部代号,用户页面用业务语言;
// 操作名 o.op 保留原始数据值不翻译)。
function providerLabel(provider: string, lang: string): string {
  switch (provider) {
    case "robohire":
      return "RoboHire";
    case "allmeta":
      return "Allmeta";
    case "partner-pg":
      return lang === "zh" ? "合作方数据库" : "Partner DB";
    case "rmhr":
      return "RMHR";
    default:
      return provider;
  }
}

// "主链路第①段·数据解释 · InterpretDataAgent" → "主链路第①段·数据解释"
function shortName(a: AgentRunStats): string {
  const n = a.name.split(" · ")[0].trim();
  return n.length > 24 ? `${n.slice(0, 23)}…` : n || a.slug;
}

// 第 9 名往后合并成"其它"系列,图例不爆。
function restSeries(agents: AgentRunStats[], len: number): number[] | null {
  if (agents.length <= 8) return null;
  const rest = Array.from({ length: len }, () => 0);
  for (const a of agents.slice(8)) a.series.forEach((v, i) => (rest[i] += v));
  return rest.some((v) => v > 0) ? rest : null;
}

// ── 堆叠柱状图(手绘 SVG,monitor ErrorRateChart 同款惯例) ──────────────

const W = 960;
const H = 220;
const PAD = { top: 16, right: 12, bottom: 30, left: 40 };

function StackedBarChart({
  buckets,
  bucket,
  series,
  rest,
  lang,
}: {
  buckets: number[];
  bucket: StatsBucket;
  series: { key: string; label: string; color: string; values: number[] }[];
  rest: number[] | null;
  lang: string;
}) {
  const all = rest ? [...series, { key: "__rest", label: lang === "zh" ? "其它" : "others", color: OTHER_COLOR, values: rest }] : series;
  const totals = buckets.map((_, i) => all.reduce((s, sr) => s + (sr.values[i] ?? 0), 0));
  const peak = Math.max(1, ...totals);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / buckets.length;
  const barW = Math.min(slot * 0.7, 38);
  // x 轴标签最多 ~12 个,等间隔抽样
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 12));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={PAD.left} y1={PAD.top + innerH} x2={W - PAD.right} y2={PAD.top + innerH} stroke="var(--c-line)" />
        {/* y grid at 50% */}
        <line x1={PAD.left} y1={PAD.top + innerH / 2} x2={W - PAD.right} y2={PAD.top + innerH / 2} stroke="var(--c-line)" strokeDasharray="3 4" />
        {buckets.map((b, i) => {
          let y = PAD.top + innerH;
          const x = PAD.left + i * slot + (slot - barW) / 2;
          return (
            <g key={b}>
              {all.map((sr) => {
                const v = sr.values[i] ?? 0;
                if (v === 0) return null;
                const h = (innerH * v) / peak;
                y -= h;
                return <rect key={sr.key} x={x} y={y} width={barW} height={h} fill={sr.color} rx={1}>
                  <title>{`${bucketLabel(b, bucket, lang, bucket === "hour")} · ${sr.label}: ${v}`}</title>
                </rect>;
              })}
              {totals[i] > 0 && totals[i] === peak && (
                <text x={x + barW / 2} y={PAD.top + innerH - (innerH * totals[i]) / peak - 4} fontSize={9.5} textAnchor="middle" fill="var(--c-ink-3)">
                  {totals[i]}
                </text>
              )}
              {i % labelEvery === 0 && (
                <text x={PAD.left + i * slot + slot / 2} y={H - 12} fontSize={9.5} textAnchor="middle" fill="var(--c-ink-4)">
                  {bucketLabel(b, bucket, lang, bucket === "hour" && buckets.length > 25)}
                </text>
              )}
            </g>
          );
        })}
        <text x={PAD.left - 6} y={PAD.top + 6} fontSize={10} textAnchor="end" fill="var(--c-ink-4)">{peak}</text>
        <text x={PAD.left - 6} y={PAD.top + innerH + 4} fontSize={10} textAnchor="end" fill="var(--c-ink-4)">0</text>
      </svg>
      {/* legend */}
      <div className="flex items-center gap-3 flex-wrap px-2 pb-2 pt-1">
        {all.map((sr) => (
          <span key={sr.key} className="inline-flex items-center gap-1.5 text-[11px] text-ink-3">
            <span className="w-2 h-2 rounded-sm inline-block" style={{ background: sr.color }} />
            {sr.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function bucketLabel(ms: number, bucket: StatsBucket, lang: string, multiDay = false): string {
  const d = new Date(ms);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  if (bucket === "hour") {
    const hh = `${String(d.getHours()).padStart(2, "0")}:00`;
    // 跨多天的小时轴(7d+hour)只标 HH:00 会让人分不清是哪天 — 带上日期。
    return multiDay ? `${md} ${hh}` : hh;
  }
  if (bucket === "week") return lang === "zh" ? `${md}周` : `wk ${md}`;
  return md;
}
