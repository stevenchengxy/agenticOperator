"use client";
import React from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/api/client";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";
import { RuleDefinitionBody, type OntologyRuleResponse } from "@/components/rule-check/RuleDefinitionPanel";
import type { RuleHealthRow } from "@/lib/rule-check/rule-health";
import type { RuleHealthResponse, InfraParkedEntry } from "@/app/api/rule-check-audits/rule-health/route";

// 规则检查 · 总览 — rule-centric health view (2026-06 redesign).
//
// Was a rule×audit heatmap whose audit list ignored the window toggle, so the
// grid looked populated while the windowed KPIs read 0 ("假数据"). Rebuilt
// around ONE window-aware payload (/rule-health): the protagonist is the rule.
// Binary outcomes — 通过 / 失败 — with NO "判不了". LLM 没钱/故障 failures are an
// infra signal (candidate NOT rejected), surfaced separately from rule失败.

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

type Win = "7d" | "30d" | "90d" | "all";

export function RuleCheckDashboardContent() {
  const { t } = useApp();
  const { domain } = useDomain();
  const [data, setData] = React.useState<RuleHealthResponse | null>(null);
  const [err, setErr] = React.useState(false);
  const [win, setWin] = React.useState<Win>("30d");
  const [filter, setFilter] = React.useState<"all" | "blocking" | "idle" | "unassessed">("all");
  const [stageFilter, setStageFilter] = React.useState<string>("");
  const [search, setSearch] = React.useState("");
  const [showDead, setShowDead] = React.useState(false);
  // 点开某条规则 → 看 Neo4j 上的原规则定义(不是审计记录)。
  const [selectedRule, setSelectedRule] = React.useState<string | null>(null);

  // One window-aware fetch (no more multi-source window disagreement), 10s poll
  // so freshly-completed checks surface without a refresh. Only replace state on
  // a healthy (ok) payload — a transient backend error keeps the last good view
  // instead of flashing the empty-window message.
  React.useEffect(() => {
    let cancel = false;
    const url = `/api/rule-check-audits/rule-health?window=${win}&domain=${encodeURIComponent(domain)}`;
    const load = () => {
      fetchJson<RuleHealthResponse>(url)
        .then((d) => { if (cancel) return; if (d.ok) { setData(d); setErr(false); } else { setErr(true); } })
        .catch(() => { if (!cancel) setErr(true); });
    };
    load();
    const id = setInterval(load, 10_000);
    return () => { cancel = true; clearInterval(id); };
  }, [win, domain]);

  // 手动「刷新规则库」—— 立即重新拉取当前领域的全量规则(fetchDomainOntology 是
  // no-store,每次都读 Neo4j 当前值)。给编辑完 Neo4j 想马上看到改动的人,不必等下一次
  // 10s 轮询。后台 10s 自动轮询仍在跑。
  const [refreshing, setRefreshing] = React.useState(false);
  const refreshNow = React.useCallback(() => {
    setRefreshing(true);
    const url = `/api/rule-check-audits/rule-health?window=${win}&domain=${encodeURIComponent(domain)}`;
    fetchJson<RuleHealthResponse>(url)
      .then((d) => { if (d.ok) { setData(d); setErr(false); } else { setErr(true); } })
      .catch(() => setErr(true))
      .finally(() => setRefreshing(false));
  }, [win, domain]);

  const totals = data?.totals;
  const rules = data?.rules ?? [];
  // 全部阶段(去重排序),给阶段下拉用。
  const stages = React.useMemo(
    () => [...new Set(rules.map((r) => r.stage).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [rules],
  );
  // 搜索:匹配 rule_id / 规则名 / 阶段 / 规则内容(logic),大小写不敏感。
  const q = search.trim().toLowerCase();
  const shownRules = rules.filter(
    (r) =>
      (filter === "all" || r.health === filter) &&
      (stageFilter === "" || r.stage === stageFilter) &&
      (q === "" ||
        r.rule_id.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.stage.toLowerCase().includes(q) ||
        (r.logic || "").toLowerCase().includes(q)),
  );
  const parked = data?.infra_parked ?? [];
  const deadRules = data?.dead_rules ?? [];

  return (
    <div className="flex flex-col gap-5" style={{ padding: "18px 32px 40px" }}>
      <section className="rc-surface-panel rc-card-in" style={{ padding: 16 }}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="hint">{t("rc_view_dashboard")}</div>
            <div className="text-ink-1" style={{ fontSize: 18, fontWeight: 560, marginTop: 4 }}>
              {totals?.rules_fired ?? 0} / {totals?.rules_total ?? 0}
              <span className="text-ink-3" style={{ fontSize: 12.5, fontWeight: 450, marginLeft: 8 }}>
                {t("rc_rh_kpi_fired")}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refreshNow}
              disabled={refreshing}
              title={t("rc_rh_refresh_hint")}
              className="rc-icon-btn"
              style={{ opacity: refreshing ? 0.55 : 1 }}
            >
              <span aria-hidden className={refreshing ? "animate-spin" : ""}>↻</span>
            </button>
            <WindowToggle value={win} onChange={setWin} t={t} />
          </div>
        </div>
        <HealthStrip totals={totals} parkedCount={parked.length} t={t} />
      </section>

      {parked.length > 0 && (
        <Link href="/fleet" className="rc-alert-line no-underline rc-card-in">
          <span className="rc-status-dot" style={{ background: "var(--c-warn)" }} />
          <span className="text-ink-1">{t("rc_rh_infra_banner").replace("{n}", String(parked.length))}</span>
          <span className="ml-auto text-accent">{t("rc_rh_infra_link")} →</span>
        </Link>
      )}

      <div className="grid gap-5 items-start" style={{ gridTemplateColumns: "minmax(0, 1fr) 310px" }}>
        <section className="rc-surface-panel min-w-0 rc-card-in" style={{ padding: 0 }}>
          <div className="flex flex-col gap-3 border-b border-line" style={{ padding: 14 }}>
            <div className="flex items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("rc_rh_search_ph")}
                className="rc-quiet-input text-ink-1"
                style={{ flex: 1 }}
              />
              <select
                value={stageFilter}
                onChange={(e) => setStageFilter(e.target.value)}
                className="rc-quiet-select"
                style={{ width: 170 }}
              >
                <option value="">{t("rc_rh_stage_all")} ({stages.length})</option>
                {stages.map((s) => (
                  <option key={s} value={s}>{s} ({rules.filter((r) => r.stage === s).length})</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label={`${t("rc_rh_filter_all")} ${rules.length}`} />
              <FilterChip active={filter === "blocking"} onClick={() => setFilter("blocking")} label={`${t("rc_rh_filter_blocking")} ${rules.filter((r) => r.health === "blocking").length}`} tone="err" />
              <FilterChip active={filter === "idle"} onClick={() => setFilter("idle")} label={`${t("rc_rh_filter_idle")} ${rules.filter((r) => r.health === "idle").length}`} />
              <FilterChip active={filter === "unassessed"} onClick={() => setFilter("unassessed")} label={`${t("rc_rh_filter_unassessed")} ${rules.filter((r) => r.health === "unassessed").length}`} />
              {q !== "" && <span className="text-ink-3 ml-auto" style={{ fontSize: 11 }}>{t("rc_rh_search_count").replace("{n}", String(shownRules.length))}</span>}
            </div>
          </div>

          {!data ? (
            <div className="text-ink-3 py-12 text-center" style={{ fontSize: 12.5 }}>{err ? t("rc_rh_error") : t("rc_loading")}</div>
          ) : shownRules.length === 0 ? (
            <div className="text-ink-3 py-12 text-center" style={{ fontSize: 12.5 }}>{t("rc_rh_empty")}</div>
          ) : (
            <div>
              <div className="grid items-center text-ink-3" style={{ gridTemplateColumns: "minmax(0, 2.1fr) 70px minmax(160px, 1.5fr) 86px", gap: 12, padding: "9px 14px", fontSize: 10.5, borderBottom: "1px solid var(--c-line)" }}>
                <span>{t("rc_rh_col_rule")}</span>
                <span style={{ textAlign: "right" }}>{t("rc_rh_col_fired")}</span>
                <span>{t("rc_rh_col_passfail")}</span>
                <span>{t("rc_rh_col_health")}</span>
              </div>
              {shownRules.map((r, i) => (
                <div key={r.rule_id} className="rc-row-in" style={{ ["--rc-i"]: Math.min(i, 14) } as React.CSSProperties}>
                  <RuleRow r={r} t={t} onSelect={setSelectedRule} />
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-4 min-w-0">
          <SidePanel
            title={t("rc_rh_parked_title")}
            count={parked.length}
            tone={parked.length ? "warn" : "muted"}
            empty={data ? t("rc_rh_parked_none") : t("rc_loading")}
          >
            {parked.slice(0, 8).map((p) => <ParkedRow key={p.audit_id} p={p} t={t} />)}
            {parked.length > 8 && <div className="text-ink-4 pt-2" style={{ fontSize: 10.5 }}>{t("rc_rh_parked_more").replace("{shown}", "8").replace("{total}", String(parked.length))}</div>}
          </SidePanel>

          <SidePanel
            title={t("rc_rh_dead_title")}
            count={deadRules.length}
            tone="muted"
            empty={data ? t("rc_rh_dead_none") : t("rc_loading")}
          >
            <div className="flex flex-wrap gap-1.5">
              {(showDead ? deadRules : deadRules.slice(0, 18)).map((d) => (
                <button
                  key={d.rule_id}
                  type="button"
                  onClick={() => setSelectedRule(d.rule_id)}
                  title={d.name}
                  className="rc-mini-chip"
                >
                  {d.rule_id}
                </button>
              ))}
              {deadRules.length > 18 && (
                <button type="button" onClick={() => setShowDead((s) => !s)} className="rc-mini-chip">
                  {showDead ? t("rc_rh_dead_collapse") : `+${deadRules.length - 18}`}
                </button>
              )}
            </div>
          </SidePanel>
        </aside>
      </div>

      {selectedRule && (
        <RuleDefinitionDrawer
          ruleId={selectedRule}
          domain={domain}
          onClose={() => setSelectedRule(null)}
        />
      )}
    </div>
  );
}

function HealthStrip({
  totals,
  parkedCount,
  t,
}: {
  totals: RuleHealthResponse["totals"] | undefined;
  parkedCount: number;
  t: (k: string) => string;
}) {
  const coverage =
    totals && totals.rules_total > 0 ? Math.round((totals.rules_fired / totals.rules_total) * 100) : 0;
  const items = [
    { label: t("rc_rh_kpi_coverage_sub").replace("{n}", String(coverage)), value: `${coverage}%`, tone: "ok" as const },
    { label: t("rc_rh_kpi_blocking"), value: String(totals?.blocking_rules ?? 0), tone: "err" as const },
    { label: t("rc_rh_kpi_dead"), value: String(totals?.rules_dead ?? 0), tone: "muted" as const },
    { label: t("rc_rh_kpi_infra"), value: String(parkedCount), tone: parkedCount > 0 ? "warn" as const : "muted" as const },
  ];
  return (
    <div className="grid gap-2 mt-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
      {items.map((item) => (
        <div key={item.label} className="rc-metric-cell">
          <div className="flex items-center gap-2">
            <span className="rc-status-dot" style={{ background: toneColor(item.tone) }} />
            <span className="text-ink-3 truncate" style={{ fontSize: 11.5 }}>{item.label}</span>
          </div>
          <div className="tabular-nums text-ink-1" style={{ fontSize: 21, fontWeight: 560, marginTop: 6 }}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function SidePanel({
  title,
  count,
  tone,
  empty,
  children,
}: {
  title: string;
  count: number;
  tone: "warn" | "muted";
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rc-surface-panel rc-card-in" style={{ padding: 14 }}>
      <div className="flex items-center gap-2">
        <span className="rc-status-dot" style={{ background: tone === "warn" ? "var(--c-warn)" : "var(--c-ink-4)" }} />
        <h3 className="m-0 text-ink-1 truncate" style={{ fontSize: 13, fontWeight: 560 }}>
          {title}
        </h3>
        <span className="ml-auto tabular-nums text-ink-3" style={{ fontSize: 12 }}>{count}</span>
      </div>
      <div className="mt-3">
        {count === 0 ? <div className="text-ink-4" style={{ fontSize: 11.5 }}>{empty}</div> : children}
      </div>
    </section>
  );
}

function toneColor(tone: "ok" | "err" | "warn" | "muted"): string {
  if (tone === "ok") return "var(--c-ok)";
  if (tone === "err") return "var(--c-err)";
  if (tone === "warn") return "var(--c-warn)";
  return "var(--c-ink-4)";
}

// 点开某条规则 → 抽屉里展示 Neo4j 上的**原规则定义**(live render),不是审计记录。
function RuleDefinitionDrawer({ ruleId, domain, onClose }: { ruleId: string; domain: string; onClose: () => void }) {
  const { t } = useApp();
  const [data, setData] = React.useState<OntologyRuleResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancel = false;
    setLoading(true);
    setErr(null);
    setData(null);
    const dq = domain ? `?domain=${encodeURIComponent(domain)}` : "";
    fetchJson<OntologyRuleResponse>(`/api/ontology/rules/${encodeURIComponent(ruleId)}${dq}`)
      .then((d) => { if (!cancel) setData(d); })
      .catch((e) => { if (!cancel) setErr((e as { message?: string })?.message || t("rc_rule_def_load_failed")); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [ruleId, domain, t]);

  // Esc 关闭
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.32)", zIndex: 40 }} />
      <div
        role="dialog"
        aria-modal="true"
        style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 540, maxWidth: "92vw", background: "var(--c-surface)", borderLeft: "1px solid var(--c-line)", zIndex: 41, overflowY: "auto", padding: "20px 24px", boxShadow: "-8px 0 28px rgba(0,0,0,0.14)" }}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
          <span className="text-ink-1" style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 500 }}>
            {t("rc_rh_rule_def_title")} · {ruleId}
          </span>
          <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink-1" style={{ fontSize: 22, lineHeight: 1, padding: "0 6px", background: "transparent", border: 0, cursor: "pointer" }}>
            ×
          </button>
        </div>
        {loading ? (
          <div className="text-ink-3" style={{ fontSize: 12.5 }}>{t("rc_loading")}</div>
        ) : err ? (
          <div className="text-err" style={{ fontSize: 12.5 }}>{t("rc_rule_def_load_failed")}: {err}</div>
        ) : !data ? null : !data.ok ? (
          <div style={{ fontSize: 12.5, color: "var(--c-warn)" }}>
            {data.reason === "not_found"
              ? `${t("rc_rule_def_not_found")}: "${ruleId}" ${t("rc_rule_def_drift")}`
              : `${t("rc_rule_def_load_err")}: ${data.error ?? ""}`}
          </div>
        ) : (
          <RuleDefinitionBody rule={data.rule} source={data.source} />
        )}
      </div>
    </>
  );
}

// ── rule row ────────────────────────────────────────────────────────────────

function RuleRow({ r, t, onSelect }: { r: RuleHealthRow; t: (k: string) => string; onSelect: (id: string) => void }) {
  const passW = Math.max(r.passed, 0);
  const failW = Math.max(r.failed, 0);
  const redline = r.severity === "terminal";
  const healthTone: "ok" | "err" | "muted" =
    r.health === "blocking" ? "err" : r.health === "unassessed" || r.health === "dead" ? "muted" : "ok";
  return (
    <button
      type="button"
      onClick={() => onSelect(r.rule_id)}
      className="grid items-center w-full text-left rc-row-hover"
      style={{ gridTemplateColumns: "minmax(0, 2.1fr) 70px minmax(160px, 1.5fr) 86px", gap: 12, padding: "11px 14px", borderBottom: "1px solid var(--c-line)", background: "transparent", cursor: "pointer" }}
      title={r.name}
    >
      <span className="flex items-baseline gap-2 min-w-0">
        <code className="text-ink-1 tabular-nums flex-none" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>{r.rule_id}</code>
        <span className="text-ink-2 truncate" style={{ fontSize: 11.5 }}>{r.name !== r.rule_id ? r.name : ""}</span>
        {r.stage && (
          <span className="flex-none text-ink-3" style={{ fontSize: 9, border: "1px solid var(--c-line)", padding: "0 4px", borderRadius: 3, background: "var(--c-panel)", whiteSpace: "nowrap" }}>
            {r.stage}
          </span>
        )}
        {redline && (
          <span className="flex-none" style={{ fontSize: 9, color: "var(--c-err)", background: "var(--c-err-bg)", padding: "1px 5px", borderRadius: 999 }}>
            {t("rc_rh_redline")}
          </span>
        )}
      </span>
      <span className="tabular-nums text-ink-2" style={{ textAlign: "right", fontSize: 12.5 }}>{r.evaluated}</span>
      <span className="min-w-0">
        <span className="flex rounded-full overflow-hidden" style={{ height: 6, background: "var(--c-panel)" }} title={t("rc_rh_passfail").replace("{pass}", String(r.passed)).replace("{fail}", String(r.failed))}>
          {passW > 0 && <span className="rc-meter-fill" style={{ flex: passW, background: "var(--c-ok)" }} />}
          {failW > 0 && <span className="rc-meter-fill" style={{ flex: failW, background: "var(--c-err)" }} />}
        </span>
        <span className="text-ink-3" style={{ fontSize: 9.5 }}>
          {t("rc_rh_passfail").replace("{pass}", String(r.passed)).replace("{fail}", String(r.failed))}
        </span>
      </span>
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="rc-status-dot" style={{ background: toneColor(healthTone) }} />
        <span className={healthTone === "err" ? "text-err" : "text-ink-3"} style={{ fontSize: 10.5 }}>
          {r.health === "blocking"
            ? t("rc_rh_health_blocking")
            : r.health === "unassessed"
              ? t("rc_rh_health_unassessed")
              : r.health === "dead"
                ? t("rc_rh_health_dead")
                : t("rc_rh_health_idle")}
        </span>
      </span>
    </button>
  );
}

function ParkedRow({ p, t }: { p: InfraParkedEntry; t: (k: string) => string }) {
  return (
    <Link
      href={`/rule-check/audits/${encodeURIComponent(p.audit_id)}`}
      className="grid no-underline rc-row-hover"
      style={{ gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--c-line)" }}
    >
      <span className="min-w-0">
        <span className="text-ink-1 truncate block" style={{ fontSize: 12 }} title={[p.candidate_name, p.jr_title, p.client_name].filter(Boolean).join(" · ")}>
          {p.candidate_name || t("rc_rh_parked_anon")}
          {p.jr_title ? <span className="text-ink-3"> · {p.jr_title}</span> : null}
        </span>
        <span className="text-ink-3 truncate block" style={{ fontSize: 10.5 }} title={p.reason_label || t("rc_rh_parked_generic")}>
          {p.reason_label || t("rc_rh_parked_generic")}
        </span>
      </span>
      <span className="text-ink-4 tabular-nums flex-none" style={{ fontSize: 10 }}>{fmtDate(p.created_at)}</span>
    </Link>
  );
}

// ── small components ─────────────────────────────────────────────────────────

function FilterChip({ active, onClick, label, tone }: { active: boolean; onClick: () => void; label: string; tone?: "err" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full transition-all"
      style={{
        padding: "4px 11px",
        fontSize: 11.5,
        background: active ? "var(--c-panel)" : "var(--c-surface)",
        border: "1px solid var(--c-line)",
        color: active ? (tone === "err" ? "var(--c-err)" : "var(--c-ink-1)") : "var(--c-ink-3)",
        fontWeight: active ? 560 : 450,
        boxShadow: active ? "0 1px 2px rgba(15,23,42,0.06)" : "none",
      }}
    >
      {label}
    </button>
  );
}

function WindowToggle({ value, onChange, t }: { value: Win; onChange: (v: Win) => void; t: (k: string) => string }) {
  const opts: { id: Win; label: string }[] = [
    { id: "7d", label: t("rc_range_7d") },
    { id: "30d", label: t("rc_range_30d") },
    { id: "90d", label: t("rc_range_90d") },
    { id: "all", label: t("rc_range_all") },
  ];
  return (
    <div className="inline-flex items-center border border-line" style={{ padding: 3, borderRadius: 8, background: "var(--c-surface)" }}>
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className="transition-all"
          style={{
            padding: "4px 9px",
            border: 0,
            borderRadius: 6,
            color: value === o.id ? "var(--c-ink-1)" : "var(--c-ink-3)",
            background: value === o.id ? "var(--c-panel)" : "transparent",
            fontWeight: value === o.id ? 560 : 450,
            fontSize: 12,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch { return iso.slice(5, 10); }
}
