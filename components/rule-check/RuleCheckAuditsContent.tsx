"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type {
  RuleCheckAuditListResponse,
  RuleCheckAuditRow,
} from "@/app/api/rule-check-audits/route";
import type { RuleCheckStatsResponse } from "@/app/api/rule-check-audits/stats/route";
import { RuleCheckAuditDetailDrawer } from "./RuleCheckAuditDetailDrawer";

export function RuleCheckAuditsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useApp();
  const decision = searchParams.get("decision") ?? "";
  const client = searchParams.get("client") ?? "";
  const jrId = searchParams.get("jrId") ?? "";
  const openAuditId = searchParams.get("auditId") ?? "";

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

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* B4 — value-anchor banner */}
      {stats && stats.total > 0 ? <ValueAnchorBanner stats={stats} t={t} /> : null}

      {/* header + filters */}
      <div
        className="border-b border-line bg-surface flex items-center"
        style={{ padding: "14px 22px", gap: 18 }}
      >
        <div>
          <div className="text-[15px] font-semibold tracking-tight">
            {t("rc_audits_title")}
          </div>
          <div className="text-ink-3 text-[12px] mt-px">
            {t("rc_audits_sub")}
            {data ? ` · ${data.total.toLocaleString()} ${t("rc_count_unit")}` : ""}
          </div>
        </div>
        <div className="flex-1" />
        <FilterSelect
          label={t("rc_filter_decision")}
          value={decision}
          onChange={(v) => setFilter("decision", v)}
          options={[
            { value: "", label: t("rc_filter_all") },
            { value: "PASS", label: "PASS" },
            { value: "FAIL", label: "FAIL" },
          ]}
        />
        <FilterInput
          label={t("rc_filter_client")}
          value={client}
          onChange={(v) => setFilter("client", v)}
          placeholder={t("rc_filter_client_placeholder")}
        />
        <FilterInput
          label="job_req_id"
          value={jrId}
          onChange={(v) => setFilter("jrId", v)}
          placeholder="JR_..."
        />
      </div>
      <div className="flex-1 overflow-auto" style={{ padding: "16px 22px" }}>
        {loading && !data ? (
          <EmptyState title={t("rc_loading")} hint="" />
        ) : data?.meta.not_configured ? (
          <EmptyState
            icon={<Ic.alert />}
            title={t("rc_empty_no_neo4j_title")}
            hint={t("rc_empty_no_neo4j_hint")}
            variant="info"
          />
        ) : data?.meta.error ? (
          <EmptyState
            icon={<Ic.alert />}
            title={t("rc_empty_neo4j_err_title")}
            hint={data.meta.error}
            variant="default"
          />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={<Ic.shield />}
            title={data?.meta.empty ? t("rc_empty_no_audits_title") : t("rc_empty_filter_title")}
            hint={data?.meta.empty ? t("rc_empty_no_audits_hint") : t("rc_empty_filter_hint")}
            variant={data?.meta.empty ? "info" : "default"}
            action={
              !data?.meta.empty ? (
                <Btn size="sm" onClick={() => router.replace("/rule-check")}>
                  {t("rc_clear_filters")}
                </Btn>
              ) : undefined
            }
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 150 }}>{t("rc_col_time")}</th>
                <th style={{ width: 70 }}>{t("rc_col_decision")}</th>
                <th style={{ width: 130 }}>{t("rc_col_client_bg")}</th>
                <th>{t("rc_col_candidate_jr")}</th>
                <th style={{ width: 90 }}>{t("rc_col_flags")}</th>
                <th style={{ width: 110 }}>{t("rc_col_llm_model")}</th>
                <th style={{ width: 90 }}>{t("rc_col_duration")}</th>
                <th style={{ width: 110 }}>{t("rc_col_rule_source")}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <AuditRow key={r.audit_id} row={r} onOpen={openDetail} t={t} />
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

// B4 — value-anchor banner
function ValueAnchorBanner({ stats, t }: { stats: RuleCheckStatsResponse; t: (k: string) => string }) {
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
        label={t("rc_stat_audits_7d")}
        value={stats.total.toLocaleString()}
        sub={`PASS ${stats.pass} · FAIL ${stats.fail}`}
      />
      <Stat
        label={t("rc_stat_blocked")}
        value={`${stats.blocked_robohire_calls}`}
        sub={`${t("rc_stat_blocked_sub_pre")} ${pct}% · ${t("rc_stat_blocked_sub_post")}`}
        accent="err"
      />
      <Stat
        label={t("rc_stat_savings")}
        value={`$${stats.estimated_robohire_savings_usd.toFixed(2)}`}
        sub={t("rc_stat_savings_sub")}
        accent="ok"
      />
      <Stat
        label={t("rc_stat_llm_duration")}
        value={`${(stats.avg_llm_duration_ms / 1000).toFixed(1)}s`}
        sub={`${(stats.total_prompt_tokens / 1000).toFixed(1)}K + ${(stats.total_completion_tokens / 1000).toFixed(1)}K tokens`}
      />
      <Stat
        label={t("rc_stat_top_fail_rules")}
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
  t: _t,
}: {
  row: RuleCheckAuditRow;
  onOpen: (auditId: string) => void;
  t: (k: string) => string;
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
