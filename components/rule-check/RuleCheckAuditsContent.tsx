"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type {
  RuleCheckAuditListResponse,
  RuleCheckAuditRow,
} from "@/app/api/rule-check-audits/route";
import type { RuleCheckStatsResponse } from "@/app/api/rule-check-audits/stats/route";
import { RuleCheckAuditDetailDrawer } from "./RuleCheckAuditDetailDrawer";
import { RuleSeverityMatrix } from "./RuleSeverityMatrix";

export function RuleCheckAuditsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const decision = searchParams.get("decision") ?? "";
  const client = searchParams.get("client") ?? "";
  const jrId = searchParams.get("jrId") ?? "";
  const openAuditId = searchParams.get("auditId") ?? "";
  const tab = (searchParams.get("tab") ?? "list") as "list" | "matrix";

  const [data, setData] = React.useState<RuleCheckAuditListResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [stats, setStats] = React.useState<RuleCheckStatsResponse | null>(null);

  React.useEffect(() => {
    setLoading(true);
    const sp = new URLSearchParams();
    if (decision) sp.set("decision", decision);
    if (client) sp.set("client", client);
    if (jrId) sp.set("jrId", jrId);
    const qs = sp.toString();
    fetchJson<RuleCheckAuditListResponse>(
      `/api/rule-check-audits${qs ? "?" + qs : ""}`,
    )
      .then(setData)
      .finally(() => setLoading(false));
  }, [decision, client, jrId]);

  // B4 — 价值锚 stats(独立 fetch,带 7d 窗口)
  React.useEffect(() => {
    fetchJson<RuleCheckStatsResponse>("/api/rule-check-audits/stats?days=7")
      .then(setStats)
      .catch(() => {});
  }, []);

  const setFilter = (k: "decision" | "client" | "jrId", v: string) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (v) sp.set(k, v);
    else sp.delete(k);
    router.replace(`/rule-check?${sp.toString()}`);
  };

  const openDetail = (auditId: string) => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("auditId", auditId);
    router.replace(`/rule-check?${sp.toString()}`);
  };
  const closeDetail = () => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete("auditId");
    router.replace(`/rule-check${sp.toString() ? "?" + sp.toString() : ""}`);
  };

  const switchTab = (t: "list" | "matrix") => {
    const sp = new URLSearchParams(searchParams.toString());
    if (t === "list") sp.delete("tab");
    else sp.set("tab", t);
    router.replace(`/rule-check${sp.toString() ? "?" + sp.toString() : ""}`);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* B4 — 价值锚 banner */}
      {stats && stats.total > 0 ? <ValueAnchorBanner stats={stats} /> : null}

      {/* 顶部 tab 切换 + 筛选 */}
      <div
        className="border-b border-line bg-surface flex items-center"
        style={{ padding: "14px 22px", gap: 18 }}
      >
        <div>
          <div className="text-[15px] font-semibold tracking-tight">
            Rule Check 审计
          </div>
          <div className="text-ink-3 text-[12px] mt-px">
            matchResume LLM 预筛决策 · 含完整 user prompt / LLM 响应
            {data ? ` · ${data.total.toLocaleString()} 条` : ""}
          </div>
        </div>
        <div style={{ marginLeft: 24, display: "flex", gap: 14 }}>
          <TabHeaderBtn active={tab === "list"} onClick={() => switchTab("list")}>
            审计列表
          </TabHeaderBtn>
          <TabHeaderBtn active={tab === "matrix"} onClick={() => switchTab("matrix")}>
            Rule × 决策矩阵
          </TabHeaderBtn>
        </div>
        <div className="flex-1" />
        <FilterSelect
          label="决策"
          value={decision}
          onChange={(v) => setFilter("decision", v)}
          options={[
            { value: "", label: "全部" },
            { value: "PASS", label: "PASS" },
            { value: "FAIL", label: "FAIL" },
          ]}
        />
        <FilterInput
          label="客户"
          value={client}
          onChange={(v) => setFilter("client", v)}
          placeholder="腾讯 / 字节"
        />
        <FilterInput
          label="job_req_id"
          value={jrId}
          onChange={(v) => setFilter("jrId", v)}
          placeholder="JR_..."
        />
      </div>
      <div className="flex-1 overflow-auto" style={{ padding: "16px 22px" }}>
        {tab === "matrix" ? (
          <RuleSeverityMatrix />
        ) : loading && !data ? (
          <EmptyState title="加载中…" hint="" />
        ) : data?.meta.not_configured ? (
          <EmptyState
            icon={<Ic.alert />}
            title="Neo4j 未配置"
            hint="设置 NEO4J_INSTANCE_URI / RAAS_LINKS_NEO4J_URI + USER + PASSWORD 后,matchResumeAgent 跑过的 rule-check 审计会自动写入并在这里显示。"
            variant="info"
          />
        ) : data?.meta.error ? (
          <EmptyState
            icon={<Ic.alert />}
            title="Neo4j 读取出错"
            hint={data.meta.error}
            variant="default"
          />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={<Ic.shield />}
            title={data?.meta.empty ? "暂无 rule check 审计" : "无匹配项"}
            hint={
              data?.meta.empty
                ? "等候 ruleCheckAgent 完成首条 MATCH_RULE_CHECK_PASSED / MATCH_RULE_CHECK_FAILED。每条决策都会带着完整 user prompt 写入 Neo4j。"
                : "尝试清空筛选条件"
            }
            variant={data?.meta.empty ? "info" : "default"}
            action={
              !data?.meta.empty ? (
                <Btn size="sm" onClick={() => router.replace("/rule-check")}>
                  清空筛选
                </Btn>
              ) : undefined
            }
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 150 }}>时间</th>
                <th style={{ width: 70 }}>决策</th>
                <th style={{ width: 130 }}>客户 × BG</th>
                <th>candidate × job_req</th>
                <th style={{ width: 90 }}>flags</th>
                <th style={{ width: 110 }}>LLM model</th>
                <th style={{ width: 90 }}>耗时</th>
                <th style={{ width: 110 }}>规则来源</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <AuditRow key={r.audit_id} row={r} onOpen={openDetail} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {openAuditId ? (
        <RuleCheckAuditDetailDrawer
          auditId={openAuditId}
          onClose={closeDetail}
        />
      ) : null}
    </div>
  );
}

function TabHeaderBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[13px] border-0 bg-transparent cursor-pointer"
      style={{
        padding: "6px 0",
        color: active ? "var(--c-ink-1)" : "var(--c-ink-3)",
        borderBottom: active ? "2px solid var(--c-accent)" : "2px solid transparent",
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}

// B4 — 价值锚 banner
function ValueAnchorBanner({ stats }: { stats: RuleCheckStatsResponse }) {
  const pct = stats.total > 0 ? Math.round((stats.fail / stats.total) * 100) : 0;
  return (
    <div
      className="border-b border-line"
      style={{
        padding: "12px 22px",
        background: "color-mix(in oklab, var(--c-accent) 5%, var(--c-bg))",
        display: "grid",
        gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
        gap: 16,
      }}
    >
      <Stat
        label="近 7 天 audit"
        value={stats.total.toLocaleString()}
        sub={`PASS ${stats.pass} · FAIL ${stats.fail}`}
      />
      <Stat
        label="拦截不合格"
        value={`${stats.blocked_robohire_calls}`}
        sub={`占比 ${pct}% · 节省 Robohire 调用`}
        accent="err"
      />
      <Stat
        label="估算节省"
        value={`$${stats.estimated_robohire_savings_usd.toFixed(2)}`}
        sub={`@ $0.20 / Robohire 调用`}
        accent="ok"
      />
      <Stat
        label="LLM 平均耗时"
        value={`${(stats.avg_llm_duration_ms / 1000).toFixed(1)}s`}
        sub={`总 ${(stats.total_prompt_tokens / 1000).toFixed(1)}K + ${(stats.total_completion_tokens / 1000).toFixed(1)}K tokens`}
      />
      <Stat
        label="Top 失败规则"
        value={
          stats.top_failure_rules
            .slice(0, 3)
            .map((r) => r.rule_id)
            .join(" · ") || "—"
        }
        sub={stats.top_failure_rules
          .slice(0, 3)
          .map((r) => `${r.rule_id}(${r.count})`)
          .join(", ")}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "ok" | "err";
}) {
  const valueColor =
    accent === "ok" ? "var(--c-ok)" : accent === "err" ? "var(--c-err)" : "var(--c-ink-1)";
  return (
    <div>
      <div className="hint">{label}</div>
      <div
        className="mono"
        style={{ fontSize: 17, fontWeight: 600, color: valueColor, marginTop: 2 }}
      >
        {value}
      </div>
      {sub ? (
        <div className="text-ink-3 text-[10.5px] mono" style={{ marginTop: 2 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-px">
      <span className="hint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 border border-line bg-panel rounded-sm mono text-[11.5px] text-ink-1 outline-none w-[180px]"
        style={{ padding: "0 8px" }}
      />
    </label>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-px">
      <span className="hint">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 border border-line bg-panel rounded-sm text-[12px] text-ink-1 outline-none"
        style={{ padding: "0 8px", width: 100 }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function AuditRow({
  row,
  onOpen,
}: {
  row: RuleCheckAuditRow;
  onOpen: (auditId: string) => void;
}) {
  const t = row.created_at ? new Date(row.created_at) : null;
  const time = t
    ? `${t.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} ${t.toLocaleTimeString(undefined, { hour12: false })}`
    : "—";
  const decisionVariant: "ok" | "err" = row.decision === "PASS" ? "ok" : "err";
  return (
    <tr
      className="cursor-pointer hover:bg-panel"
      onClick={() => onOpen(row.audit_id)}
    >
      <td className="mono text-[11px] text-ink-2">{time}</td>
      <td>
        <Badge variant={decisionVariant}>{row.decision}</Badge>
      </td>
      <td className="mono text-[11.5px] text-ink-1">
        {row.client_name || "—"}
        {row.business_group ? ` × ${row.business_group}` : ""}
      </td>
      <td className="mono text-[11px] text-ink-2 truncate max-w-[400px]">
        <span className="text-ink-1">{row.candidate_id || "—"}</span>
        <span className="text-ink-3"> / </span>
        <span>{row.job_requisition_id || "—"}</span>
      </td>
      <td className="mono text-[11px] text-ink-2">
        {row.n_flags > 0 ? `${row.n_flags}/${row.rules_evaluated}` : `0/${row.rules_evaluated}`}
      </td>
      <td className="mono text-[10.5px] text-ink-3">{row.llm_model || "—"}</td>
      <td className="mono text-[11px] text-ink-2">
        {row.llm_duration_ms ? `${row.llm_duration_ms}ms` : "—"}
      </td>
      <td>
        <Badge variant="default">{row.rule_source}</Badge>
      </td>
    </tr>
  );
}
