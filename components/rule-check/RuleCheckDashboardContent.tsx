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

  return (
    <div className="flex flex-col gap-6" style={{ padding: "20px 32px 40px" }}>
      {/* header */}
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 500, letterSpacing: "-0.01em" }}>
            {t("rc_rh_title")}
          </h2>
          <div className="text-ink-3 mt-1" style={{ fontSize: 12.5 }}>
            {t("rc_rh_sub").replace("{fired}", String(totals?.rules_fired ?? 0)).replace("{total}", String(totals?.rules_total ?? 0))}
          </div>
        </div>
        <div className="flex items-center" style={{ gap: 10, marginLeft: "auto" }}>
          <button
            type="button"
            onClick={refreshNow}
            disabled={refreshing}
            title={t("rc_rh_refresh_hint")}
            className="flex items-center text-ink-2 hover:text-ink-1"
            style={{
              gap: 6,
              fontSize: 12,
              padding: "4px 11px",
              background: "var(--c-surface)",
              border: "1px solid var(--c-line)",
              borderRadius: 7,
              cursor: refreshing ? "default" : "pointer",
              opacity: refreshing ? 0.6 : 1,
            }}
          >
            <span aria-hidden className={refreshing ? "animate-spin" : ""} style={{ display: "inline-block" }}>
              ⟳
            </span>
            {refreshing ? t("rc_rh_refreshing") : t("rc_rh_refresh")}
          </button>
          <WindowToggle value={win} onChange={setWin} t={t} />
        </div>
      </div>

      {/* infra banner — only when LLM 没钱/故障 parked something this window */}
      {parked.length > 0 && (
        <Link
          href="/fleet"
          className="flex items-center gap-2 rounded-md no-underline"
          style={{ padding: "9px 14px", background: "var(--c-warn-bg)", border: "1px solid color-mix(in oklab, var(--c-warn) 40%, transparent)", fontSize: 12.5 }}
        >
          <span style={{ color: "var(--c-warn)" }}>⚠</span>
          <span className="text-ink-1">
            {t("rc_rh_infra_banner").replace("{n}", String(parked.length))}
          </span>
          <span className="ml-auto" style={{ color: "var(--c-accent)" }}>{t("rc_rh_infra_link")} →</span>
        </Link>
      )}

      {/* body: rule table (left) + infra-parked / dead (right) */}
      <div className="grid gap-6 items-start" style={{ gridTemplateColumns: "minmax(0, 1.9fr) minmax(260px, 1fr)" }}>
        {/* left — rule table */}
        <div className="flex flex-col gap-3 min-w-0">
          {/* 搜索:按 id / 规则名 / 阶段 / 规则内容 过滤 */}
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("rc_rh_search_ph")}
              className="rounded text-ink-1"
              style={{ flex: 1, padding: "6px 12px", fontSize: 12.5, background: "var(--c-surface)", border: "1px solid var(--c-line)" }}
            />
            {q !== "" && (
              <span className="text-ink-3 flex-none" style={{ fontSize: 11.5 }}>
                {t("rc_rh_search_count").replace("{n}", String(shownRules.length))}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label={`${t("rc_rh_filter_all")} ${rules.length}`} />
            <FilterChip active={filter === "blocking"} onClick={() => setFilter("blocking")} label={`${t("rc_rh_filter_blocking")} ${rules.filter((r) => r.health === "blocking").length}`} tone="err" />
            <FilterChip active={filter === "idle"} onClick={() => setFilter("idle")} label={`${t("rc_rh_filter_idle")} ${rules.filter((r) => r.health === "idle").length}`} />
            <FilterChip active={filter === "unassessed"} onClick={() => setFilter("unassessed")} label={`${t("rc_rh_filter_unassessed")} ${rules.filter((r) => r.health === "unassessed").length}`} />
            {/* 阶段筛选 —— 31 个阶段太多用下拉 */}
            <select
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value)}
              className="rounded-full"
              style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 11.5, background: stageFilter ? "var(--c-panel)" : "transparent", border: "1px solid var(--c-line)", color: stageFilter ? "var(--c-ink-1)" : "var(--c-ink-3)" }}
            >
              <option value="">{t("rc_rh_stage_all")}（{stages.length}）</option>
              {stages.map((s) => (
                <option key={s} value={s}>{s}（{rules.filter((r) => r.stage === s).length}）</option>
              ))}
            </select>
          </div>

          {!data ? (
            <div className="text-ink-3 py-10 text-center border border-line rounded" style={{ fontSize: 12.5 }}>{err ? t("rc_rh_error") : t("rc_loading")}</div>
          ) : shownRules.length === 0 ? (
            <div className="text-ink-3 py-10 text-center border border-line rounded" style={{ fontSize: 12.5 }}>{t("rc_rh_empty")}</div>
          ) : (
            <div className="border border-line rounded" style={{ background: "var(--c-surface)" }}>
              <div className="grid items-center text-ink-3" style={{ gridTemplateColumns: "minmax(0, 2.3fr) 56px minmax(0, 2fr) 88px", gap: 12, padding: "8px 14px", fontSize: 10.5, borderBottom: "1px solid var(--c-line)" }}>
                <span>{t("rc_rh_col_rule")}</span>
                <span style={{ textAlign: "right" }}>{t("rc_rh_col_fired")}</span>
                <span>{t("rc_rh_col_passfail")}</span>
                <span>{t("rc_rh_col_health")}</span>
              </div>
              {shownRules.map((r) => <RuleRow key={r.rule_id} r={r} t={t} onSelect={setSelectedRule} />)}
            </div>
          )}
        </div>

        {/* right — infra-parked + dead rules */}
        <div className="flex flex-col gap-6 min-w-0">
          <section>
            <h3 className="m-0 text-ink-1 flex items-baseline gap-2" style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 500 }}>
              <span style={{ color: parked.length ? "var(--c-warn)" : "var(--c-ink-3)" }}>⚠</span>{t("rc_rh_parked_title")}
            </h3>
            <div className="text-ink-3 mb-2 mt-0.5" style={{ fontSize: 11 }}>{t("rc_rh_parked_sub")}</div>
            {parked.length === 0 ? (
              <div className="text-ink-4 py-3" style={{ fontSize: 11.5 }}>{data ? t("rc_rh_parked_none") : t("rc_loading")}</div>
            ) : (
              <div className="border-t border-line">
                {parked.slice(0, 10).map((p) => <ParkedRow key={p.audit_id} p={p} t={t} />)}
                {parked.length > 10 && (
                  <div className="text-ink-4 pt-2" style={{ fontSize: 10.5 }}>
                    {t("rc_rh_parked_more").replace("{shown}", "10").replace("{total}", String(parked.length))}
                  </div>
                )}
              </div>
            )}
          </section>

          <section>
            <h3 className="m-0 text-ink-3 flex items-baseline gap-2" style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 500 }}>
              💤 {t("rc_rh_dead_title")} ({data?.dead_rules.length ?? 0})
            </h3>
            <div className="text-ink-3 mb-2 mt-0.5" style={{ fontSize: 11 }}>{t("rc_rh_dead_hint")}</div>
            {(data?.dead_rules.length ?? 0) === 0 ? (
              <div className="text-ink-4 py-3" style={{ fontSize: 11.5 }}>{data ? t("rc_rh_dead_none") : t("rc_loading")}</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(showDead ? data!.dead_rules : data!.dead_rules.slice(0, 12)).map((d) => (
                  <button
                    key={d.rule_id}
                    type="button"
                    onClick={() => setSelectedRule(d.rule_id)}
                    title={d.name}
                    className="rounded text-ink-3 hover:text-ink-1 transition-colors"
                    style={{ fontFamily: "var(--f-mono)", fontSize: 11, padding: "2px 7px", background: "var(--c-panel)", border: "1px solid var(--c-line)", cursor: "pointer" }}
                  >
                    {d.rule_id}
                  </button>
                ))}
                {(data?.dead_rules.length ?? 0) > 12 && (
                  <button type="button" onClick={() => setShowDead((s) => !s)} className="text-ink-3 hover:text-ink-1" style={{ fontSize: 11, padding: "2px 4px" }}>
                    {showDead ? t("rc_rh_dead_collapse") : `+${data!.dead_rules.length - 12}…`}
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
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
  return (
    <button
      type="button"
      onClick={() => onSelect(r.rule_id)}
      className="grid items-center w-full text-left hover:bg-panel transition-colors"
      style={{ gridTemplateColumns: "minmax(0, 2.3fr) 56px minmax(0, 2fr) 88px", gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--c-line)", borderLeft: `2px solid ${r.health === "blocking" ? "var(--c-err)" : "transparent"}`, background: "transparent", cursor: "pointer" }}
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
          <span className="flex-none" style={{ fontSize: 9, color: "var(--c-err)", border: "1px solid color-mix(in oklab, var(--c-err) 40%, transparent)", padding: "0 4px", borderRadius: 3 }}>
            {t("rc_rh_redline")}
          </span>
        )}
      </span>
      <span className="tabular-nums text-ink-2" style={{ textAlign: "right", fontSize: 12 }}>{r.evaluated}</span>
      <span className="min-w-0">
        <span className="flex rounded-full overflow-hidden" style={{ height: 7, background: "var(--c-panel)" }} title={t("rc_rh_passfail").replace("{pass}", String(r.passed)).replace("{fail}", String(r.failed))}>
          {passW > 0 && <span style={{ flex: passW, background: "var(--c-ok)" }} />}
          {failW > 0 && <span style={{ flex: failW, background: "var(--c-err)" }} />}
        </span>
        <span className="text-ink-3" style={{ fontSize: 9.5 }}>
          {t("rc_rh_passfail").replace("{pass}", String(r.passed)).replace("{fail}", String(r.failed))}
        </span>
      </span>
      <span>
        {r.health === "blocking" ? (
          <span style={{ background: "var(--c-err-bg)", color: "var(--c-err)", padding: "1px 8px", borderRadius: 10, fontSize: 10 }}>{t("rc_rh_health_blocking")}</span>
        ) : r.health === "unassessed" ? (
          <span className="text-ink-4" style={{ fontSize: 10.5 }}>{t("rc_rh_health_unassessed")}</span>
        ) : r.health === "dead" ? (
          <span className="text-ink-4" style={{ fontSize: 10.5 }}>{t("rc_rh_health_dead")}</span>
        ) : (
          <span className="text-ink-3" style={{ fontSize: 10.5 }}>{t("rc_rh_health_idle")}</span>
        )}
      </span>
    </button>
  );
}

function ParkedRow({ p, t }: { p: InfraParkedEntry; t: (k: string) => string }) {
  return (
    <Link
      href={`/rule-check/audits/${encodeURIComponent(p.audit_id)}`}
      className="grid no-underline border-b border-line hover:bg-panel transition-colors"
      style={{ gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, padding: "8px 4px" }}
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
      className="rounded-full transition-colors"
      style={{
        padding: "3px 12px",
        fontSize: 11.5,
        background: active ? "var(--c-panel)" : "transparent",
        border: "1px solid var(--c-line)",
        color: active ? (tone === "err" ? "var(--c-err)" : "var(--c-ink-1)") : "var(--c-ink-3)",
        fontWeight: active ? 500 : 400,
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
    <div className="flex items-center gap-1">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className="transition-colors rounded"
          style={{
            padding: "3px 9px",
            color: value === o.id ? "var(--c-ink-1)" : "var(--c-ink-3)",
            background: value === o.id ? "var(--c-panel)" : "transparent",
            fontWeight: value === o.id ? 500 : 400,
            fontSize: 12.5,
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
