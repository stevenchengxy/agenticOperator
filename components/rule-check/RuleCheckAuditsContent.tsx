"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type {
  RuleCheckAuditListResponse,
  RuleCheckAuditRow,
} from "@/app/api/rule-check-audits/route";
import type { RuleCheckStatsResponse } from "@/app/api/rule-check-audits/stats/route";
// Audit detail moved to /rule-check/audits/[auditId] fullscreen route
// (2026-05-25) — no longer renders here as a drawer.

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

export function RuleCheckAuditsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, lang } = useApp();
  const decision = searchParams.get("decision") ?? "";
  const client = searchParams.get("client") ?? "";
  const jrId = searchParams.get("jrId") ?? "";

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

  // value-anchor stats (7d window)
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

  // Per user request (2026-05-25): open audit detail in a dedicated
  // fullscreen route rather than a right-side drawer. Gives the detail
  // view the whole viewport, makes URLs shareable, and lets browser back
  // work as expected.
  const openDetail = (auditId: string) => {
    router.push(`/rule-check/audits/${encodeURIComponent(auditId)}`);
  };

  const hasFilters = !!(decision || client || jrId);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Serif KPI banner */}
      {stats && stats.total > 0 ? <ValueAnchorBanner stats={stats} t={t} /> : null}

      {/* Filter strip — horizontal row */}
      <div className="border-b border-line bg-surface flex items-center gap-3" style={{ padding: "12px 26px" }}>
        <div className="flex-1">
          <div className="text-[14px] font-semibold text-ink-1" style={{ fontFamily: SERIF }}>
            {t("rc_audits_title")}
          </div>
          <div className="text-[11.5px] text-ink-3 mt-0.5">
            {t("rc_audits_sub")}
            {data ? ` · ${data.total.toLocaleString()} ${t("rc_count_unit")}` : ""}
          </div>
        </div>
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
          label={t("rc_audits_jr_filter")}
          value={jrId}
          onChange={(v) => setFilter("jrId", v)}
          placeholder="JR_..."
        />
        {hasFilters && (
          <Btn size="sm" variant="ghost" onClick={() => router.replace("/rule-check?view=audits")}>
            {t("rc_clear_filters")}
          </Btn>
        )}
      </div>

      {/* Audit list */}
      <div className="flex-1 overflow-auto" style={{ padding: "16px 26px 40px" }}>
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
          <>
            <div className="flex flex-col gap-1">
              {data.rows.map((r) => (
                <AuditCard key={r.audit_id} row={r} onOpen={openDetail} t={t} lang={lang} />
              ))}
            </div>
            {data.rows.length > 0 && data.total > data.rows.length && (
              <div className="text-[11px] text-ink-3 text-center mt-4">
                {t("rc_loaded_of_total")
                  .replace("{loaded}", String(data.rows.length))
                  .replace("{total}", String(data.total))}
              </div>
            )}
          </>
        )}
      </div>

    </div>
  );
}

// ── Serif KPI banner ─────────────────────────────────────────────────────────

function ValueAnchorBanner({ stats, t }: { stats: RuleCheckStatsResponse; t: (k: string) => string }) {
  const pct = stats.total > 0 ? Math.round((stats.fail / stats.total) * 100) : 0;
  return (
    <div className="border-b border-line" style={{ padding: "20px 26px", background: "var(--c-bg)" }}>
      <div
        className="grid gap-x-10 gap-y-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}
      >
        <Kpi
          label={t("rc_stat_audits_7d")}
          value={stats.total.toLocaleString()}
          sub={`PASS ${stats.pass} · FAIL ${stats.fail}`}
        />
        <Kpi
          label={t("rc_stat_blocked")}
          value={`${stats.blocked_robohire_calls}`}
          sub={`${pct}% 拦截率`}
          tone="err"
        />
        <Kpi
          label={t("rc_stat_savings")}
          value={`$${stats.estimated_robohire_savings_usd.toFixed(2)}`}
          sub={t("rc_stat_savings_sub")}
          tone="ok"
        />
        <Kpi
          label={t("rc_stat_llm_duration")}
          value={`${(stats.avg_llm_duration_ms / 1000).toFixed(1)}s`}
          sub={`${(stats.total_prompt_tokens / 1000).toFixed(1)}K + ${(stats.total_completion_tokens / 1000).toFixed(1)}K tokens`}
        />
        <Kpi
          label={t("rc_stat_top_fail_rules")}
          value={stats.top_failure_rules[0]?.rule_id ?? "—"}
          sub={stats.top_failure_rules.slice(0, 3).map((r) => `${r.rule_id}(${r.count})`).join(", ")}
        />
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "err" }) {
  const color = tone === "ok" ? "var(--c-ok)" : tone === "err" ? "var(--c-err)" : "var(--c-ink-1)";
  return (
    <div className="min-w-0">
      <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500, color: "var(--c-ink-3)" }}>
        {label}
      </div>
      <div
        className="tabular-nums truncate"
        style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 500, letterSpacing: "-0.015em", lineHeight: 1.1, color, marginTop: 6 }}
      >
        {value}
      </div>
      {sub && (
        <div className="text-ink-3 mono" style={{ fontSize: 11, marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ── Filter helpers ───────────────────────────────────────────────────────────

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

// ── Audit card ────────────────────────────────────────────────────────────────

function AuditCard({
  row,
  onOpen,
  t: _t,
  lang,
}: {
  row: RuleCheckAuditRow;
  onOpen: (auditId: string) => void;
  t: (k: string) => string;
  lang: "zh" | "en";
}) {
  const pass = row.decision === "PASS";
  const accent = pass ? "var(--c-ok)" : "var(--c-err)";
  return (
    <button
      type="button"
      onClick={() => onOpen(row.audit_id)}
      className="text-left cursor-pointer rounded-lg transition-all"
      style={{
        padding: "12px 14px",
        background: "var(--c-surface)",
        border: "1px solid var(--c-line)",
        borderLeft: `3px solid ${accent}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--c-panel)";
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.05)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--c-surface)";
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span
            className="rounded-full font-mono text-[11px] flex-shrink-0"
            style={{
              padding: "2px 9px",
              background: pass ? "var(--c-ok-bg)" : "var(--c-err-bg)",
              color: accent,
              fontWeight: 600,
            }}
          >
            {row.decision}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink-1 truncate" style={{ fontFamily: SERIF, fontWeight: 500 }}>
              {row.client_name || "—"}{row.business_group ? ` × ${row.business_group}` : ""}
            </div>
            <div className="text-[10.5px] text-ink-3 mono truncate mt-0.5">
              {row.candidate_id || "—"} → {row.job_requisition_id || "—"}
            </div>
          </div>
        </div>
        <div className="text-[11px] text-ink-3 text-right flex-shrink-0">
          <div className="mono">{formatRelative(row.created_at, lang)}</div>
          <div className="mono mt-0.5 text-ink-4">
            {row.n_flags > 0 ? `${row.n_flags}/${row.rules_evaluated}` : `0/${row.rules_evaluated}`} flags
            {row.llm_duration_ms ? ` · ${row.llm_duration_ms}ms` : ""}
          </div>
        </div>
      </div>
    </button>
  );
}

function formatRelative(iso: string | null | undefined, lang: "zh" | "en"): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const diffMin = Math.floor((Date.now() - then) / 60_000);
  if (diffMin < 1) return lang === "zh" ? "刚刚" : "just now";
  if (diffMin < 60) return lang === "zh" ? `${diffMin}分钟前` : `${diffMin}m ago`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return lang === "zh" ? `${h}小时前` : `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return lang === "zh" ? `${d}天前` : `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
