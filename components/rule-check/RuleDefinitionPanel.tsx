"use client";
import React from "react";
import { Badge } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import { useApp } from "@/lib/i18n";
import type { Rule } from "@/lib/rule-check/types";

// Inline minimal shape — the /api/ontology/rules/[ruleId] endpoint returns the
// live Rule node pulled from the graph engine (or a json fallback).
export type OntologyRuleResponse =
  | {
      ok: true;
      rule: Rule;
      source: "ontology-api" | "json-fallback";
    }
  | {
      ok: false;
      reason: string;
      error?: string;
    };

/**
 * 单条规则详情面板 — 懒加载,从 /api/ontology/rules/[ruleId] 拉图引擎的原始
 * Rule 节点字段。给规则筛选 tab 的「适配规则」卡片嵌入用(展开看原规则)。
 *
 * 展开时 fetch,close 不释放(已加载的 rule 缓存在 state 里);切换不同 rule_id
 * 由 React key 重建组件,自然清缓存。
 */
export function RuleDefinitionPanel({ ruleId }: { ruleId: string }) {
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<OntologyRuleResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Lazy load: fetch on first expand, cache thereafter.
  React.useEffect(() => {
    if (!open || data || loading) return;
    setLoading(true);
    setErr(null);
    fetchJson<OntologyRuleResponse>(
      `/api/ontology/rules/${encodeURIComponent(ruleId)}`,
    )
      .then(setData)
      .catch((e) => setErr((e as Error)?.message || t("rc_rule_def_load_failed")))
      .finally(() => setLoading(false));
  }, [open, ruleId, data, loading, t]);

  return (
    <div
      className="border-t border-line"
      style={{ background: "var(--c-panel)" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex items-center justify-between cursor-pointer"
        style={{ padding: "8px 14px", background: "transparent", border: 0 }}
      >
        <span className="hint">
          {open ? "▾" : "▸"} {t("rc_rule_def_view")}
        </span>
        <span className="mono text-[10.5px] text-ink-3">
          {open ? t("rc_rule_def_collapse") : t("rc_rule_def_expand")}
        </span>
      </button>
      {open ? (
        <div style={{ padding: "0 14px 12px" }}>
          {loading ? (
            <div className="mono text-[11px] text-ink-3">{t("rc_rule_def_loading")}</div>
          ) : err ? (
            <div className="mono text-[11px] text-err">{t("rc_rule_def_load_failed")}: {err}</div>
          ) : !data ? null : !data.ok ? (
            <div className="mono text-[11px] text-warn">
              {data.reason === "not_found"
                ? `${t("rc_rule_def_not_found")}: "${ruleId}" ${t("rc_rule_def_drift")}`
                : `${t("rc_rule_def_load_err")}: ${data.error ?? "(no message)"}`}
            </div>
          ) : (
            <RuleDefinitionBody rule={data.rule} source={data.source} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function RuleDefinitionBody({
  rule,
  source,
}: {
  rule: Rule;
  source: "ontology-api" | "json-fallback";
}) {
  const { t } = useApp();
  const enforcement = rule.enforcementLevel ?? "optional";
  const failurePolicy = rule.failurePolicy ?? "warn";
  return (
    <div className="flex flex-col" style={{ gap: 10 }}>
      <div className="flex items-center" style={{ gap: 6, flexWrap: "wrap" }}>
        <Badge variant="default">{rule.id}</Badge>
        <Badge
          variant={
            rule.severity === "terminal" || rule.severity === "needs_human"
              ? "err"
              : "default"
          }
        >
          severity={rule.severity}
        </Badge>
        <Badge variant={enforcement === "mandatory" ? "err" : "default"}>
          {t(`rc_enforcement_${enforcement}`)}
        </Badge>
        <Badge variant={failurePolicy === "block" ? "err" : "default"}>
          {t(`rc_on_fail_${failurePolicy}`)}
        </Badge>
        <Badge variant="default">executor={rule.executor}</Badge>
        <Badge variant="default">
          applicableClient={rule.applicableClient}
        </Badge>
        <Badge variant="default">
          applicableDepartment={rule.applicableDepartment || "N/A"}
        </Badge>
        <span
          className="mono text-[10px] text-ink-3"
          title={
            source === "ontology-api"
              ? t("rc_rule_source_api_detail")
              : t("rc_rule_source_fallback_detail")
          }
        >
          {t("rc_rule_source_label").replace("{source}", source)}
        </span>
      </div>
      <div className="text-[12.5px] text-ink-1 font-semibold">
        {rule.businessLogicRuleName || t("rc_rule_no_name")}
      </div>
      <RuleField label={t("rc_rule_field_trigger")} value={rule.submissionCriteria} />
      <RuleField
        label={t("rc_rule_field_logic")}
        value={rule.standardizedLogicRule}
        mono
      />
      {rule.businessBackgroundReason ? (
        <RuleField
          label={t("rc_rule_field_bg")}
          value={rule.businessBackgroundReason}
        />
      ) : null}
      {rule.specificScenarioStage ? (
        <RuleField
          label={t("rc_rule_field_stage")}
          value={rule.specificScenarioStage}
        />
      ) : null}
      {rule.ruleSource ? (
        <RuleField label={t("rc_rule_field_source")} value={rule.ruleSource} />
      ) : null}
      {rule.relatedEntities && rule.relatedEntities.length > 0 ? (
        <RuleField
          label={t("rc_rule_field_entities")}
          value={rule.relatedEntities.join(" · ")}
        />
      ) : null}
    </div>
  );
}

function RuleField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div>
      <div className="hint" style={{ marginBottom: 2 }}>
        {label}
      </div>
      <pre
        className={
          (mono ? "mono " : "") +
          "text-[11.5px] text-ink-1 whitespace-pre-wrap"
        }
        style={{
          background: "var(--c-bg)",
          border: "1px solid var(--c-line)",
          borderRadius: 3,
          padding: "8px 10px",
          margin: 0,
          lineHeight: 1.55,
        }}
      >
        {value}
      </pre>
    </div>
  );
}
