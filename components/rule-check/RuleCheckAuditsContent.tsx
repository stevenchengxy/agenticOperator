"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";
import { Ic } from "@/components/shared/Ic";
import { Btn, EmptyState } from "@/components/shared/atoms";
import { Pagination } from "@/components/shared/Pagination";
import { agentsForDomain, lookupAgent } from "@/lib/rule-check/agent-registry";
import { fetchJson } from "@/lib/api/client";
import {
  paginationFrom,
  readPage,
  readPageSize,
  setPaginationParams,
} from "@/lib/api/pagination";
import { friendlyInfraReason, isInfraFailure } from "@/lib/rule-check/infra-failure";
import {
  classifyFailureKind,
  parseFailureReason,
  type RuleCheckFailureKind,
} from "@/lib/rule-check/failure-reason";
import type {
  RuleCheckAuditListResponse,
  RuleCheckAuditRow,
} from "@/app/api/rule-check-audits/route";
import type { RuleCheckStatsResponse } from "@/app/api/rule-check-audits/stats/route";
// Audit detail moved to /rule-check/audits/[auditId] fullscreen route
// (2026-05-25) — no longer renders here as a drawer.

export function RuleCheckAuditsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, lang } = useApp();
  const { domain } = useDomain();
  // Unified-surface facets: which agent ran + folded verdict (pass/fail/parked).
  // `verdict` replaces the old PASS/FAIL `decision` dropdown (it splits FAIL into
  // 真违规 vs 基础设施故障挂起).
  const agent = searchParams.get("agent") ?? "";
  const verdict = searchParams.get("verdict") ?? "";
  const client = searchParams.get("client") ?? "";
  const jrId = searchParams.get("jrId") ?? "";
  const ruleId = searchParams.get("ruleId") ?? "";
  const page = readPage(searchParams.get("page"));
  const pageSize = readPageSize(searchParams.get("pageSize"), [20, 50, 100], 50);

  const [data, setData] = React.useState<RuleCheckAuditListResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [listError, setListError] = React.useState<string | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);
  const [stats, setStats] = React.useState<RuleCheckStatsResponse | null>(null);

  React.useEffect(() => {
    let cancel = false;
    setLoading(true);
    setListError(null);
    setData(null);
    const sp = new URLSearchParams();
    if (agent) sp.set("agent", agent);
    if (verdict) sp.set("verdict", verdict);
    if (client) sp.set("client", client);
    if (jrId) sp.set("jrId", jrId);
    if (ruleId) sp.set("ruleId", ruleId);
    sp.set("domain", domain);
    setPaginationParams(sp, page, pageSize);
    const qs = sp.toString();
    fetchJson<RuleCheckAuditListResponse>(
      `/api/rule-check-audits${qs ? "?" + qs : ""}`,
      { timeoutMs: 20_000 },
    )
      .then((next) => {
        if (!cancel) setData(next);
      })
      .catch((e) => {
        if (!cancel) setListError((e as Error)?.message || t("rc_audits_load_failed"));
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [agent, verdict, client, jrId, ruleId, domain, page, pageSize, refreshToken, t]);

  // value-anchor stats (7d window)
  React.useEffect(() => {
    fetchJson<RuleCheckStatsResponse>(`/api/rule-check-audits/stats?days=7&domain=${encodeURIComponent(domain)}`)
      .then(setStats)
      .catch(() => {});
  }, [domain]);

  const setUrl = React.useCallback((mutate: (params: URLSearchParams) => void) => {
    const sp = new URLSearchParams(searchParams.toString());
    mutate(sp);
    router.replace(`/rule-check${sp.toString() ? `?${sp.toString()}` : ""}`);
  }, [router, searchParams]);

  const setFilter = (k: "agent" | "verdict" | "client" | "jrId" | "ruleId", v: string) => {
    setUrl((sp) => {
      if (v) sp.set(k, v);
      else sp.delete(k);
      sp.delete("page");
    });
  };

  // 执行 agent 选项:招聘域走本地注册表(可本地化 + 标注规划中);其它域用
  // 接口返回的 facets(由 OntologyRuleCheck 数据驱动)。
  const registryAgents = agentsForDomain(domain);
  const agentOptions = [
    { value: "", label: t("rc_filter_all") },
    ...(registryAgents.length
      ? registryAgents.map((a) => ({
          value: a.id,
          label: a.status === "planned" ? `${a.label[lang]} · ${t("rc_agent_planned")}` : a.label[lang],
        }))
      : (data?.meta.facets?.agents ?? []).map((a) => ({ value: a.id, label: a.label }))),
  ];

  // Per user request (2026-05-25): open audit detail in a dedicated
  // fullscreen route rather than a right-side drawer. Gives the detail
  // view the whole viewport, makes URLs shareable, and lets browser back
  // work as expected.
  const openDetail = (auditId: string) => {
    const returnTo = `/rule-check${searchParams.toString() ? `?${searchParams.toString()}` : "?view=audits"}`;
    router.push(
      `/rule-check/audits/${encodeURIComponent(auditId)}?returnTo=${encodeURIComponent(returnTo)}`,
    );
  };

  const hasFilters = !!(agent || verdict || client || jrId || ruleId);
  const retry = React.useCallback(() => setRefreshToken((v) => v + 1), []);
  const pagination = data
    ? paginationFrom(data, { page, pageSize, rowCount: data.rows.length })
    : { page, pageSize, total: null, totalPages: null };

  React.useEffect(() => {
    if (pagination.totalPages != null && page > pagination.totalPages) {
      setUrl((sp) => {
        if (pagination.totalPages! <= 1) sp.delete("page");
        else sp.set("page", String(pagination.totalPages));
      });
    }
  }, [page, pagination.totalPages, setUrl]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Serif KPI banner */}
      {stats && stats.total > 0 ? <ValueAnchorBanner stats={stats} t={t} /> : null}

      <div className="border-b border-line bg-bg flex items-center gap-2 flex-wrap" style={{ padding: "12px 26px" }}>
        <div className="flex-1 min-w-[220px]">
          <div className="text-[13px] font-semibold text-ink-1">
            {t("rc_audits_title")}
            {data ? <span className="text-ink-3 font-normal"> · {data.total.toLocaleString()}</span> : null}
          </div>
        </div>
        <FilterSelect
          label={t("rc_filter_agent")}
          value={agent}
          onChange={(v) => setFilter("agent", v)}
          options={agentOptions}
          width={150}
        />
        <FilterSelect
          label={t("rc_filter_verdict")}
          value={verdict}
          onChange={(v) => setFilter("verdict", v)}
          options={[
            { value: "", label: t("rc_filter_all") },
            { value: "pass", label: t("rc_verdict_pass") },
            { value: "fail", label: t("rc_verdict_fail") },
            { value: "parked", label: t("rc_verdict_parked") },
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
        {ruleId && (
          <button
            type="button"
            onClick={() => setFilter("ruleId", "")}
            className="inline-flex items-center gap-1.5 rounded-full transition-colors"
            style={{ padding: "3px 10px", fontSize: 11.5, background: "var(--c-accent-bg)", color: "var(--c-accent)", border: "1px solid color-mix(in oklab, var(--c-accent) 35%, transparent)" }}
            title={t("rc_audits_rule_filter_clear")}
          >
            {t("rc_audits_rule_filter").replace("{id}", ruleId)} ✕
          </button>
        )}
        {hasFilters && (
          <Btn size="sm" variant="ghost" onClick={() => setUrl((sp) => {
            for (const key of ["agent", "verdict", "client", "jrId", "ruleId", "page"]) sp.delete(key);
            sp.set("view", "audits");
          })}>
            {t("rc_clear_filters")}
          </Btn>
        )}
      </div>

      {/* Audit list */}
      <div className="flex-1 overflow-auto" style={{ padding: "16px 26px 40px" }}>
        {loading && !data ? (
          <EmptyState title={t("rc_loading")} hint="" />
        ) : listError ? (
          <EmptyState
            icon={<Ic.alert />}
            title={t("rc_audits_load_failed")}
            hint={listError}
            variant="warn"
            action={<Btn size="sm" onClick={retry}>{t("rc_verify_retry")}</Btn>}
          />
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
                <Btn size="sm" onClick={() => setUrl((sp) => {
                  for (const key of ["agent", "verdict", "client", "jrId", "ruleId", "page"]) sp.delete(key);
                  sp.set("view", "audits");
                })}>
                  {t("rc_clear_filters")}
                </Btn>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {data.rows.map((r, i) => (
                <div
                  key={r.audit_id}
                  className="rc-row-in"
                  style={{ ["--rc-i"]: Math.min(i, 14) } as React.CSSProperties}
                >
                  <AuditCard row={r} onOpen={openDetail} t={t} lang={lang} domain={domain} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {data && !data.meta.not_configured && !data.meta.error && (
        <Pagination
          page={page}
          pageSize={pageSize}
          rowCount={data.rows.length}
          total={pagination.total}
          totalPages={pagination.totalPages}
          loading={loading}
          onPageChange={(nextPage) => setUrl((sp) => {
            if (nextPage <= 1) sp.delete("page");
            else sp.set("page", String(nextPage));
          })}
          onPageSizeChange={(nextSize) => setUrl((sp) => {
            if (nextSize === 50) sp.delete("pageSize");
            else sp.set("pageSize", String(nextSize));
            sp.delete("page");
          })}
        />
      )}

    </div>
  );
}

// ── Serif KPI banner ─────────────────────────────────────────────────────────

function ValueAnchorBanner({ stats, t }: { stats: RuleCheckStatsResponse; t: (k: string) => string }) {
  const pct = stats.total > 0 ? Math.round((stats.fail / stats.total) * 100) : 0;
  return (
    <div className="border-b border-line bg-bg" style={{ padding: "14px 26px" }}>
      <div className="rc-surface-panel grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", padding: 12 }}>
        <Kpi
          label={t("rc_stat_audits_7d")}
          value={stats.total.toLocaleString()}
          sub={`PASS ${stats.pass} · FAIL ${stats.fail}`}
        />
        <Kpi
          label={t("rc_stat_blocked")}
          value={`${stats.blocked_robohire_calls}`}
          sub={`${pct}% ${t("rc_stat_block_rate")}`}
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
    <div className="min-w-0 rc-metric-cell">
      <div className="truncate" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 560, color: "var(--c-ink-3)" }}>
        {label}
      </div>
      <div
        className="tabular-nums truncate"
        style={{ fontSize: 23, fontWeight: 560, lineHeight: 1.05, color, marginTop: 6 }}
      >
        {value}
      </div>
      {sub && (
        <div className="text-ink-3 mono truncate" style={{ fontSize: 10.5, marginTop: 4 }}>
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
        className="rc-quiet-input mono text-ink-1 w-[180px]"
        style={{ height: 30 }}
      />
    </label>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  width = 100,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  width?: number;
}) {
  return (
    <label className="flex flex-col gap-px">
      <span className="hint">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rc-quiet-select text-ink-1"
        style={{ height: 30, width }}
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
  t,
  lang,
  domain,
}: {
  row: RuleCheckAuditRow;
  onOpen: (auditId: string) => void;
  t: (k: string) => string;
  lang: "zh" | "en";
  domain: string;
}) {
  // Folded verdict drives the badge: pass(ok) / fail(err) / parked(amber 未完成,
  // 候选人 not rejected — infra 故障挂起).
  const verdict = row.verdict;
  const accent =
    verdict === "parked" ? "var(--c-warn)" : verdict === "pass" ? "var(--c-ok)" : "var(--c-err)";
  const verdictBg =
    verdict === "parked" ? "var(--c-warn-bg)" : verdict === "pass" ? "var(--c-ok-bg)" : "var(--c-err-bg)";
  const verdictText =
    verdict === "parked" ? t("rc_verdict_parked") : verdict === "pass" ? t("rc_verdict_pass") : t("rc_verdict_fail");
  // Localize the agent/stage badges via the registry (recruitment); fall back to
  // the server-provided label / raw stage for data-driven (energy…) agents.
  const reg = lookupAgent(domain, row.agent_id);
  const agentText = reg?.label[lang] ?? row.agent_label;
  const stageText = reg?.stage[lang] ?? row.stage;
  const candidate = row.candidate_name || (row.candidate_id ? row.candidate_id.slice(0, 8) : "—");
  const job = row.jr_title || (row.job_requisition_id ? row.job_requisition_id.slice(-10) : "—");
  const flagsText = `${row.n_flags > 0 ? row.n_flags : 0}/${row.rules_evaluated}`;
  const failure = summarizeAuditFailure(row, t, lang);
  return (
    <button
      type="button"
      onClick={() => onOpen(row.audit_id)}
      className="rc-audit-card text-left cursor-pointer w-full"
      style={{ "--rc-accent": accent, "--rc-bg": verdictBg } as React.CSSProperties}
    >
      <div className="grid items-center gap-3 rc-audit-card-grid">
        <span className="rc-verdict-pill" style={{ color: accent, background: verdictBg }}>
          {verdictText}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] text-ink-1 truncate" style={{ fontWeight: 560 }}>{candidate}</span>
            <span className="text-ink-4">/</span>
            <span className="text-[13px] text-ink-1 truncate" style={{ fontWeight: 520 }}>{job}</span>
            {row.dept_label ? <span className="rc-mini-chip flex-none">{row.dept_label}</span> : null}
          </div>
          <div className="flex items-center gap-2 mt-1 min-w-0">
            <span className="mono text-ink-4 truncate" style={{ fontSize: 10.5 }}>{agentText}{stageText ? ` · ${stageText}` : ""}</span>
            {failure ? (
              <span className="rc-failure-chip-wrap min-w-0" title={failure.text}>
                <span
                  className="rc-failure-chip"
                  style={{ "--rc-failure-chip-accent": failure.accent, "--rc-failure-chip-bg": failure.bg } as React.CSSProperties}
                >
                  {failure.label}
                </span>
                <span className="text-ink-3 truncate" style={{ fontSize: 11 }}>{failure.text}</span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="text-right flex-shrink-0 rc-audit-card-meta">
          <div className="mono text-ink-3" style={{ fontSize: 11 }}>{formatRelative(row.created_at, lang)}</div>
          <div className="mono text-ink-4 mt-1" style={{ fontSize: 10.5 }}>
            {flagsText}
            {row.llm_duration_ms ? ` · ${(row.llm_duration_ms / 1000).toFixed(1)}s` : ""}
          </div>
        </div>
      </div>
    </button>
  );
}

function summarizeAuditFailure(
  row: RuleCheckAuditRow,
  t: (k: string) => string,
  lang: "zh" | "en",
): {
  kind: RuleCheckFailureKind;
  label: string;
  text: string;
  accent: string;
  bg: string;
} | null {
  if (row.verdict === "pass") return null;
  if (isInfraFailure(row.fail_reason)) {
    const text =
      lang === "zh"
        ? friendlyInfraReason(row.fail_reason)
        : t("rc_failure_candidate_not_rejected");
    return {
      kind: "infra",
      label: t("rc_failure_kind_infra"),
      text,
      accent: "var(--c-warn)",
      bg: "var(--c-warn-bg)",
    };
  }
  const raw = row.failure_reasons[0] ?? row.fail_reason ?? row.llm_decision ?? "";
  if (!raw) return null;
  const parsed = parseFailureReason(raw);
  const kind = classifyFailureKind(raw);
  const warn = kind === "insufficient" || kind === "review";
  return {
    kind,
    label:
      kind === "insufficient"
        ? t("rc_failure_kind_insufficient")
        : kind === "review"
          ? t("rc_failure_kind_review")
          : t("rc_failure_kind_rule"),
    text: parsed.ruleId ? `${parsed.ruleId} · ${parsed.detail}` : parsed.detail,
    accent: warn ? "var(--c-warn)" : "var(--c-err)",
    bg: warn ? "var(--c-warn-bg)" : "var(--c-err-bg)",
  };
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
