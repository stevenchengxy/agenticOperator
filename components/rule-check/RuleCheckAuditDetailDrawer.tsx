"use client";
import React from "react";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { MiniMarkdown } from "@/components/shared/MiniMarkdown";
import { fetchJson } from "@/lib/api/client";
import { useApp } from "@/lib/i18n";
import type {
  RuleCheckAuditDetailResponse,
  RuleCheckAuditDetail,
} from "@/app/api/rule-check-audits/[auditId]/route";
import type { Rule } from "@/lib/rule-check/types";

// Inline minimal shape — the upstream /api/ontology/rules/[ruleId] endpoint
// was retired in the post-merge cleanup; the drawer still consumes the
// rule-detail fetch but uses the full Rule type from rule-check.
type OntologyRuleResponse =
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

type Tab = "prompt" | "rules" | "response" | "instances";

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

// DrawerSection shell — defined here for use by the 4 tab bodies but not
// yet wired in. Wrapping the existing PromptTab / RulesTab / ResponseTab /
// InstancesTab content in this shell creates double-border / double-padding
// regressions because each tab already manages its own section chrome.
// Deferred: tabs need a structural pass (extract section bodies, drop their
// inline headers) before this shell can be applied uniformly.
function DrawerSection({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="flex items-baseline gap-2.5">
          <h3
            className="m-0 text-ink-1"
            style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 500, letterSpacing: "-0.005em" }}
          >
            {title}
          </h3>
          {hint && <span className="text-ink-3" style={{ fontSize: 11.5 }}>{hint}</span>}
        </div>
        {action}
      </div>
      <div className="border border-line rounded" style={{ background: "var(--c-surface)", padding: "12px 14px" }}>
        {children}
      </div>
    </section>
  );
}

/**
 * Body of the audit-detail view — header + tabs + tab bodies.
 * Used by:
 *   - <RuleCheckAuditDetailDrawer/> (this file's modal wrapper)
 *   - /rule-check/audits/[auditId]/page.tsx (fullscreen route)
 *
 * `onClose` is the X-button handler when rendered as a drawer; pass
 * `undefined` to render the back-to-list link instead (fullscreen mode).
 */
export function RuleCheckAuditDetailBody({
  auditId,
  onClose,
  chrome = "drawer",
}: {
  auditId: string;
  onClose?: () => void;
  chrome?: "drawer" | "page";
}) {
  const { t } = useApp();
  const [data, setData] = React.useState<RuleCheckAuditDetailResponse | null>(
    null,
  );
  const [loading, setLoading] = React.useState(true);
  const [tab, setTab] = React.useState<Tab>("prompt");
  const [isReplaying, setIsReplaying] = React.useState(false);
  const [replayMsg, setReplayMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    setLoading(true);
    fetchJson<RuleCheckAuditDetailResponse>(`/api/rule-check-audits/${encodeURIComponent(auditId)}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [auditId]);

  const onReplay = React.useCallback(async () => {
    if (isReplaying) return;
    setIsReplaying(true);
    setReplayMsg(null);
    try {
      const r = await fetchJson<{
        ok: boolean;
        new_event_id?: string;
        error?: string;
      }>(`/api/rule-check-audits/${encodeURIComponent(auditId)}/replay`, {
        method: "POST",
      });
      if (r.ok) {
        setReplayMsg(t("rc_replay_ok").replace("{id}", r.new_event_id?.slice(0, 12) ?? ""));
      } else {
        setReplayMsg(t("rc_replay_fail").replace("{error}", r.error ?? ""));
      }
    } catch (e) {
      setReplayMsg(t("rc_replay_err").replace("{msg}", (e as Error).message.slice(0, 80)));
    } finally {
      setIsReplaying(false);
      setTimeout(() => setReplayMsg(null), 8000);
    }
  }, [auditId, isReplaying]);

  // ESC to close — only for drawer chrome (page has browser back).
  React.useEffect(() => {
    if (chrome !== "drawer" || !onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, chrome]);

  const headerAndBody = (
    <>
      <div
        className="border-b border-line flex items-center gap-3"
        style={{ padding: "12px 18px" }}
      >
        <Ic.shield />
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold tracking-tight truncate">
            {t("rc_drawer_title")}
          </div>
          <div className="mono text-[11px] text-ink-3 truncate">{auditId}</div>
        </div>
        <Btn
          size="sm"
          onClick={onReplay}
          disabled={isReplaying}
          title={t("rc_replay_title")}
        >
          {isReplaying ? t("rc_replay_running") : `🔁 ${t("rc_replay")}`}
        </Btn>
        {chrome === "drawer" && onClose && (
          <Btn size="sm" onClick={onClose}>
            {t("rc_drawer_close")}
          </Btn>
        )}
      </div>

      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState title={t("rc_loading")} hint="" />
        </div>
      ) : !data ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.alert />}
            title={t("rc_drawer_load_failed")}
            hint={t("rc_drawer_no_response")}
          />
        </div>
      ) : !data.ok ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.alert />}
            title={
              data.reason === "not_found"
                ? t("rc_drawer_audit_missing")
                : t("rc_rule_def_load_err")
            }
            hint={data.reason === "error" ? data.error ?? "" : ""}
            variant="info"
          />
        </div>
      ) : (
        <>
          <DetailHeader detail={data.detail} />
          {replayMsg ? (
            <div
              className="text-[12px] mono"
              style={{
                padding: "8px 22px",
                background: "color-mix(in oklab, var(--c-info) 12%, var(--c-bg))",
                borderBottom: "1px solid var(--c-line)",
                color: "var(--c-info)",
              }}
            >
              {replayMsg}
            </div>
          ) : null}
          <div
            className="border-b border-line flex"
            style={{ padding: "0 18px", gap: 16 }}
          >
            <TabBtn active={tab === "prompt"} onClick={() => setTab("prompt")}>
              {t("rc_tab_prompt")}
            </TabBtn>
            <TabBtn active={tab === "rules"} onClick={() => setTab("rules")}>
              {t("rc_tab_flags")} ({data.detail.flags.length})
            </TabBtn>
            <TabBtn active={tab === "response"} onClick={() => setTab("response")}>
              {t("rc_tab_response")}
            </TabBtn>
            <TabBtn active={tab === "instances"} onClick={() => setTab("instances")}>
              {t("rc_tab_instances")}
            </TabBtn>
          </div>
          <div className="flex-1 overflow-auto" style={{ padding: "16px 18px" }}>
            {tab === "prompt" ? (
              <PromptTab detail={data.detail} />
            ) : tab === "rules" ? (
              <RulesTab detail={data.detail} />
            ) : tab === "response" ? (
              <ResponseTab detail={data.detail} />
            ) : (
              <InstancesTab detail={data.detail} />
            )}
          </div>
        </>
      )}
    </>
  );

  if (chrome === "page") {
    // Fullscreen mode — no overlay, no fixed positioning. Parent route
    // owns the surrounding chrome (Shell + breadcrumbs).
    return (
      <div className="flex-1 flex flex-col min-w-0 bg-surface">
        {headerAndBody}
      </div>
    );
  }

  // Drawer mode — fixed overlay, click backdrop to close.
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      style={{ background: "color-mix(in oklab, var(--c-bg) 60%, transparent)" }}
      onClick={onClose}
    >
      <div
        className="bg-surface border-l border-line flex flex-col"
        style={{ width: "min(940px, 92vw)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {headerAndBody}
      </div>
    </div>
  );
}

/**
 * @deprecated kept for any straggling callers — use `RuleCheckAuditDetailBody`
 * with `chrome="drawer"` or navigate to /rule-check/audits/[auditId] directly.
 */
export function RuleCheckAuditDetailDrawer(props: { auditId: string; onClose: () => void }) {
  return <RuleCheckAuditDetailBody {...props} chrome="drawer" />;
}

function DetailHeader({
  detail,
}: {
  detail: RuleCheckAuditDetail;
}) {
  const { t } = useApp();
  // A5 — 一句话决策摘要(给 leader / 客户最直观看的)
  const summary = buildDecisionSummary(detail, t);
  return (
    <>
      <DecisionBanner detail={detail} summary={summary} />
      {/* 2026-05-26: 精简头部 — 只留 4 个有用字段;decision 已在 banner,
          长 UUID 标识符收进默认折叠的 <details>。 */}
      <div className="border-b border-line bg-panel" style={{ padding: "16px 22px" }}>
        <div
          className="grid"
          style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "14px 28px" }}
        >
          <Kv label={t("rc_kv_client_bg_studio")}>
            <span className="mono text-[11.5px]">
              {detail.client_name || "—"}
              {detail.business_group ? ` × ${detail.business_group}` : ""}
              {detail.studio ? ` × ${detail.studio}` : ""}
            </span>
          </Kv>
          <Kv label={t("rc_kv_model_latency")}>
            <span className="mono text-[11.5px]">
              {detail.llm_model || "—"} · {detail.llm_duration_ms}ms
            </span>
          </Kv>
          <Kv label={t("rc_kv_tokens")}>
            <span className="mono text-[11.5px]">
              {detail.llm_prompt_tokens ?? "—"} / {detail.llm_completion_tokens ?? "—"}
            </span>
          </Kv>
          <Kv label={t("rc_kv_rules_evaluated")}>
            <span
              className="mono text-[11.5px]"
              title={t("rc_rules_evaluated_title")
                .replace("{total}", String(detail.rules_total_in_ontology))
                .replace("{evaluated}", String(detail.rules_evaluated))
                .replace("{applicable}", String(detail.flags.filter((f) => f.applicable).length))
                .replace("{not_applicable}", String(detail.flags.filter((f) => !f.applicable).length))}
            >
              {t("rc_rules_evaluated_label")
                .replace("{total}", String(detail.rules_total_in_ontology))
                .replace("{evaluated}", String(detail.rules_evaluated))}
              {" → applicable="}{detail.flags.filter((f) => f.applicable).length}
              {" · N/A="}{detail.flags.filter((f) => !f.applicable).length}
            </span>
            <Badge variant="default">{detail.rule_source}</Badge>
          </Kv>
        </div>
        <details className="mt-3">
          <summary className="hint cursor-pointer select-none" style={{ fontSize: 11.5 }}>
            {t("rc_identifiers")}
          </summary>
          <div
            className="grid mt-2"
            style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "10px 28px" }}
          >
            <Kv label={t("rc_kv_candidate_id")}>
              <span className="mono text-[11px]">{detail.candidate_id || "—"}</span>
            </Kv>
            <Kv label={t("rc_kv_jr_id")}>
              <span className="mono text-[11px]">{detail.job_requisition_id || "—"}</span>
            </Kv>
            <Kv label={t("rc_kv_trace_id")}>
              <span className="mono text-[11px]">{detail.trace_id || "—"}</span>
            </Kv>
          </div>
        </details>
      </div>
      {detail.failure_reasons.length > 0 && (
        <div
          className="border-b border-line"
          style={{
            padding: "12px 22px",
            borderLeft: "3px solid var(--c-err)",
            background: "var(--c-err-bg)",
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
          }}
        >
          <Ic.alert />
          <div className="min-w-0 flex-1">
            <div className="hint" style={{ color: "var(--c-err)" }}>{t("rc_failure_reasons_label")}</div>
            <div className="mono text-[12px] text-err" style={{ marginTop: 4, lineHeight: 1.5 }}>
              {detail.failure_reasons.join("、")}
            </div>
          </div>
        </div>
      )}
      {detail.parse_error && (
        <div
          className="border-b border-line"
          style={{
            padding: "12px 22px",
            borderLeft: "3px solid var(--c-warn)",
            background: "var(--c-warn-bg)",
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
          }}
        >
          <Ic.alert />
          <div className="min-w-0 flex-1">
            <div className="hint" style={{ color: "oklch(0.45 0.14 75)" }}>{t("rc_parse_error_label")}</div>
            <div className="mono text-[11px]" style={{ color: "oklch(0.45 0.14 75)", marginTop: 4, lineHeight: 1.5 }}>
              {detail.parse_error}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// A5 — 决策摘要 banner
function DecisionBanner({
  detail,
  summary,
}: {
  detail: RuleCheckAuditDetail;
  summary: string;
}) {
  const pass = detail.decision === "PASS";
  const bgColor = pass
    ? "color-mix(in oklab, var(--c-ok) 12%, var(--c-bg))"
    : "color-mix(in oklab, var(--c-err) 12%, var(--c-bg))";
  const borderColor = pass ? "var(--c-ok)" : "var(--c-err)";
  return (
    <div
      className="border-b border-line flex items-center gap-5"
      style={{
        padding: "20px 22px",
        background: bgColor,
        borderLeft: `4px solid ${borderColor}`,
      }}
    >
      <div
        className="tabular-nums"
        style={{
          fontFamily: SERIF,
          fontSize: 36,
          fontWeight: 500,
          color: borderColor,
          minWidth: 120,
          lineHeight: 1,
          letterSpacing: "-0.02em",
        }}
      >
        {detail.decision}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-ink-1" style={{ fontSize: 14, lineHeight: 1.55 }}>
          {summary}
        </div>
        <div className="text-ink-3 mono text-[11px] mt-2 truncate">
          {detail.candidate_id?.slice(0, 8)} · {detail.job_requisition_id?.split("-").pop() || "?"}
          {detail.client_name ? ` · ${detail.client_name}` : ""}
          {detail.business_group ? ` × ${detail.business_group}` : ""}
        </div>
      </div>
      {/* Replay button moved to the top toolbar */}
    </div>
  );
}

function buildDecisionSummary(
  detail: RuleCheckAuditDetail,
  t: (k: string) => string,
): string {
  if (detail.decision === "PASS") {
    return t("rc_decision_summary_pass")
      .replace("{evaluated}", String(detail.rules_evaluated))
      .replace("{total}", String(detail.rules_total_in_ontology));
  }
  // FAIL
  const reasons = detail.failure_reasons.length
    ? detail.failure_reasons.join("、")
    : t("rc_decision_summary_llm_parse_err");
  return t("rc_decision_summary_fail").replace("{reasons}", reasons);
}

function Kv({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div
        className="text-ink-3"
        style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}
      >
        {label}
      </div>
      <div className="text-ink-1 flex items-center gap-2 truncate" style={{ marginTop: 6, fontSize: 13 }}>
        {children}
      </div>
    </div>
  );
}

function TabBtn({
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
      className="border-0 bg-transparent cursor-pointer"
      style={{
        padding: "12px 0 10px",
        color: active ? "var(--c-ink-1)" : "var(--c-ink-3)",
        borderBottom: active
          ? "1.5px solid var(--c-ink-1)"
          : "1.5px solid transparent",
        fontWeight: active ? 500 : 400,
        fontSize: 13,
      }}
    >
      {children}
    </button>
  );
}

/**
 * 在 User Prompt 之前展示 — ontology 全部规则里,有哪些被 (client × business_group ×
 * executor) filter 过滤掉了。每条带 reason,让用户能验证"规则抓取链路完整,过滤逻辑合理"。
 *
 * 数据来源:`audit.filtered_out_rules`(由 applyClientFilterWithReasons 抓取)。
 */
function FilteredOutRulesSection({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  const filteredOut = detail.filtered_out_rules ?? [];

  // 按过滤原因分类(executor / client / department)便于用户看清楚
  const byCategory: Record<string, typeof filteredOut> = {
    executor: [],
    client: [],
    department: [],
    other: [],
  };
  for (const f of filteredOut) {
    if (f.executor !== 'Agent') byCategory.executor!.push(f);
    else if (f.reason.includes('applicableClient')) byCategory.client!.push(f);
    else if (f.reason.includes('applicableDepartment')) byCategory.department!.push(f);
    else byCategory.other!.push(f);
  }
  const ontologyTotal = detail.rules_total_in_ontology;
  const evaluatedCount = detail.rules_evaluated;
  const filteredCount = filteredOut.length;
  const clientId = detail.client_name || "?";
  const businessGroup = detail.business_group || "?";

  return (
    <div className="border border-line rounded-sm bg-panel">
      <button
        type="button"
        className="w-full text-left flex items-center justify-between"
        style={{ padding: "12px 14px" }}
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <div className="hint" style={{ marginBottom: 4 }}>
            🔍 {t("rc_filter_chain_title")}
          </div>
          <div className="mono text-[12px] text-ink-1">
            {t("rc_filter_chain_summary")
              .replace("{total}", String(ontologyTotal))
              .replace("{filtered}", String(filteredCount))
              .replace("{evaluated}", String(evaluatedCount))}
            {' '}
            <span className="text-ink-3">
              {t("rc_filter_chain_dim")
                .replace("{client}", clientId)
                .replace("{bg}", businessGroup)}
            </span>
          </div>
        </div>
        <span className="mono text-[11px] text-ink-3">
          {open ? t("rc_show_less") : t("rc_show_more")} {filteredCount > 0 ? `(${filteredCount})` : ''}
        </span>
      </button>
      {open && filteredOut.length > 0 ? (
        <div style={{ borderTop: "1px solid var(--c-line)" }}>
          {Object.entries(byCategory)
            .filter(([, rules]) => rules.length > 0)
            .map(([category, rules]) => (
              <div key={category} style={{ padding: "8px 14px", borderBottom: "1px solid var(--c-line)" }}>
                <div className="hint" style={{ marginBottom: 6 }}>
                  {category === 'executor'
                    ? t("rc_filtered_executor_detail").replace("{count}", String(rules.length))
                    : category === 'client'
                      ? t("rc_filtered_client_detail").replace("{count}", String(rules.length))
                      : category === 'department'
                        ? t("rc_filtered_department_detail").replace("{count}", String(rules.length))
                        : t("rc_filtered_other_detail").replace("{count}", String(rules.length))}
                </div>
                <div className="flex flex-col" style={{ gap: 6 }}>
                  {rules.map((f) => (
                    <div
                      key={f.rule_id}
                      className="flex items-start"
                      style={{
                        gap: 10,
                        padding: "6px 8px",
                        background: "var(--c-bg)",
                        borderRadius: 3,
                      }}
                    >
                      <span
                        className="mono text-[11px] text-ink-3"
                        style={{ minWidth: 50, paddingTop: 2 }}
                      >
                        {f.rule_id}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div className="text-[12px] text-ink-1">{f.rule_name}</div>
                        <div className="mono text-[11px] text-ink-3" style={{ marginTop: 2 }}>
                          {f.reason}
                        </div>
                        <div className="mono text-[10.5px] text-ink-4" style={{ marginTop: 2 }}>
                          applicableClient="{f.applicable_client}" · applicableDepartment="{f.applicable_department}" · executor="{f.executor}"
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      ) : open ? (
        <div className="hint" style={{ padding: "10px 14px", borderTop: "1px solid var(--c-line)" }}>
          {t("rc_filter_chain_empty").replace("{total}", String(ontologyTotal))}
        </div>
      ) : null}
    </div>
  );
}

function PromptTab({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  const [view, setView] = React.useState<"rendered" | "raw">("rendered");
  if (!detail.user_prompt) {
    return (
      <EmptyState
        icon={<Ic.alert />}
        title={t("rc_prompt_missing_title")}
        hint={t("rc_prompt_missing_hint")}
        variant="info"
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {/* Before the prompt — surface which rules were filtered out + why */}
      <FilteredOutRulesSection detail={detail} />
      <div>
        <div className="hint flex items-center" style={{ gap: 8, marginBottom: 6 }}>
          <span>{t("rc_prompt_system")}</span>
          <span className="mono text-ink-3 text-[10.5px]">
            {detail.system_prompt?.length ?? 0} chars
          </span>
          <CopyBtn text={detail.system_prompt ?? ""} />
        </div>
        <pre
          className="mono text-[11.5px] text-ink-1 bg-panel border border-line rounded-sm whitespace-pre-wrap"
          style={{ padding: "12px 14px", maxHeight: 240, overflow: "auto" }}
        >
          {detail.system_prompt ?? "(no system prompt)"}
        </pre>
      </div>
      <div>
        <div className="hint flex items-center" style={{ gap: 8, marginBottom: 6 }}>
          <span>{t("rc_prompt_user")}</span>
          <span className="mono text-ink-3 text-[10.5px]">
            {detail.user_prompt.length} chars
          </span>
          <ViewToggle view={view} onChange={setView} t={t} />
          <CopyBtn text={detail.user_prompt} />
        </div>
        {view === "rendered" ? (
          <div
            className="border border-line rounded-sm"
            style={{
              padding: "12px 16px",
              background: "var(--c-surface)",
              maxHeight: 700,
              overflow: "auto",
            }}
          >
            <MiniMarkdown source={detail.user_prompt} />
          </div>
        ) : (
          <pre
            className="mono text-[11.5px] text-ink-1 bg-panel border border-line rounded-sm whitespace-pre-wrap"
            style={{ padding: "12px 14px", maxHeight: 700, overflow: "auto" }}
          >
            {detail.user_prompt}
          </pre>
        )}
      </div>
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
  t,
}: {
  view: "rendered" | "raw";
  onChange: (v: "rendered" | "raw") => void;
  t: (k: string) => string;
}) {
  return (
    <div
      className="inline-flex border border-line rounded-sm overflow-hidden"
      style={{ marginLeft: 4 }}
    >
      {(["rendered", "raw"] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className="mono text-[10.5px] cursor-pointer"
          style={{
            padding: "2px 8px",
            background: view === v ? "var(--c-ink-1)" : "var(--c-surface)",
            color: view === v ? "var(--c-bg)" : "var(--c-ink-2)",
            border: 0,
            borderRight: v === "rendered" ? "1px solid var(--c-line)" : 0,
          }}
        >
          {v === "rendered" ? t("rc_prompt_view_rendered") : t("rc_prompt_view_raw")}
        </button>
      ))}
    </div>
  );
}

function RulesTab({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  if (detail.flags.length === 0) {
    return (
      <>
        <CandidateProfileCard detail={detail} />
        <EmptyState
          title={t("rc_no_rules_title")}
          hint={t("rc_no_rules_hint")}
          variant="info"
        />
      </>
    );
  }
  // 候选人 + JD 上下文 — 让每条 flag 的"对决策影响"文案能引用具体姓名/岗位,
  // 而不是冷冰冰的"无负面影响"。
  const ctx = deriveCandidateContext(detail, t);

  // 分两段:
  //   ① applicable=true(规则被实际评估) — 按 FAIL→PASS→其他 排序,详情卡展开
  //   ② applicable=false(规则不触发) — 折叠成一行 summary,证明这条规则被审视过
  const applicable = detail.flags.filter((f) => f.applicable);
  const notApplicable = detail.flags.filter((f) => !f.applicable);

  const orderedApplicable = [...applicable].sort((a, b) => {
    const ra = a.result === "FAIL" ? 0 : a.result === "PASS" ? 2 : 3;
    const rb = b.result === "FAIL" ? 0 : b.result === "PASS" ? 2 : 3;
    if (ra !== rb) return ra - rb;
    const sa = a.severity === "terminal" || a.severity === "needs_human" ? 0 : 1;
    const sb = b.severity === "terminal" || b.severity === "needs_human" ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.rule_id.localeCompare(b.rule_id);
  });

  // 每条规则的抓取证据(为何纳入)— 内联到每条 rule 卡片,替代原来的独立"抓取链路"卡片。
  const provById = new Map(
    (detail.rule_provenance ?? []).map((p) => [p.rule_id, p]),
  );

  return (
    <div className="flex flex-col gap-3">
      <CandidateProfileCard detail={detail} />

      {/* ① 已评估的规则(applicable=true)— LLM 实际跑了逻辑判定的 */}
      {orderedApplicable.length > 0 ? (
        <>
          <div className="hint" style={{ marginTop: 4, marginBottom: 2 }}>
            {t("rc_rules_evaluated_section").replace("{count}", String(orderedApplicable.length))}
          </div>
          {orderedApplicable.map((f) => (
            <InferenceChainCard
              key={f.flag_id}
              flag={f}
              auditId={detail.audit_id}
              ctx={ctx}
              provenance={provById.get(f.rule_id) ?? null}
            />
          ))}
        </>
      ) : null}

      {/* ② 不适用的规则(applicable=false)— 折叠分区,证明被审视过 */}
      {notApplicable.length > 0 ? (
        <NotApplicableRulesSection
          flags={notApplicable.sort((a, b) => a.rule_id.localeCompare(b.rule_id))}
          ctx={ctx}
        />
      ) : null}
    </div>
  );
}

/**
 * 从 detail 派生候选人 + JD 上下文,供 InferenceChainCard / NotApplicableRulesSection
 * 在 step 3 / 不适用文案里引用具体姓名,而不是冷冰冰的"无负面影响"。
 */
type CandidateContext = {
  name: string;
  jrTitle: string;
  failureRuleIds: Set<string>; // 这次决策被 failure_reasons 命中的 rule_id (取 "<rule_id>:..." 前缀)
};

function deriveCandidateContext(
  detail: RuleCheckAuditDetail,
  t: (k: string) => string,
): CandidateContext {
  const r = (detail.parsed_resume_full ?? {}) as Record<string, unknown>;
  const j = (detail.job_requisition_full ?? {}) as Record<string, unknown>;
  const failureRuleIds = new Set<string>();
  for (const reason of detail.failure_reasons) {
    if (typeof reason !== "string") continue;
    const colon = reason.indexOf(":");
    const ruleId = colon > 0 ? reason.slice(0, colon) : reason;
    if (ruleId) failureRuleIds.add(ruleId.trim());
  }
  return {
    name: pickStr(r.name) || t("rc_candidate_no_name"),
    jrTitle: pickStr(j.client_job_title) || t("rc_jr_no_title"),
    failureRuleIds,
  };
}

/**
 * NOT_APPLICABLE 规则折叠分区 — 一行一条,带 evidence(为什么不适用)
 *
 * 每行展示:rule_id · rule_name · LLM 判断该规则触发条件不满足的具体理由 ·
 * 候选人/岗位上下文 一句话。fallback 来源(DB 漏写,从 llm_raw_text 抠出来)
 * 单独打个角标,跟正常 DB row 区分。
 */
function NotApplicableRulesSection({
  flags,
  ctx,
}: {
  flags: RuleCheckAuditDetail["flags"];
  ctx: CandidateContext;
}) {
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  const recoveredCount = flags.filter((f) => f.from_raw_fallback).length;
  return (
    <div className="border border-line rounded-sm">
      <button
        type="button"
        className="w-full text-left flex items-center justify-between"
        style={{ padding: "10px 14px", background: "var(--c-panel)" }}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="min-w-0 flex-1">
          <span className="hint">
            {open ? "▾" : "▸"} {t("rc_na_rules_section").replace("{count}", String(flags.length))}
          </span>
          {recoveredCount > 0 ? (
            <div
              className="mono text-[10.5px] text-warn"
              style={{ marginTop: 2 }}
              title={t("rc_na_fallback_title")}
            >
              ⓘ {t("rc_na_rules_raw_fallback").replace("{count}", String(recoveredCount))}
            </div>
          ) : null}
        </div>
        <span className="mono text-[11px] text-ink-3">{open ? t("rc_show_less") : t("rc_show_more")}</span>
      </button>
      {open ? (
        <div className="flex flex-col" style={{ padding: "4px 0 8px" }}>
          {flags.map((f) => (
            <div
              key={f.flag_id}
              style={{
                borderTop: "1px solid var(--c-line)",
              }}
            >
              <div className="flex items-start" style={{ padding: "8px 14px", gap: 10 }}>
                <span className="mono text-[11px] text-ink-3" style={{ minWidth: 50 }}>
                  {f.rule_id}
                </span>
                <div style={{ flex: 1 }}>
                  <div className="text-[12px] text-ink-1 flex items-center gap-2">
                    <span>{f.rule_name_snapshot}</span>
                    {f.from_raw_fallback ? (
                      <span
                        className="mono text-[9.5px] text-warn border border-warn rounded-sm"
                        style={{ padding: "1px 4px" }}
                        title={t("rc_na_raw_fallback_tag_title")}
                      >
                        raw fallback
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[11.5px] text-ink-2" style={{ marginTop: 2, lineHeight: 1.55 }}>
                    <span className="text-ink-3">{t("rc_na_rule_llm_verdict")}</span>
                    {f.evidence || t("rc_evidence_no_llm_short")}
                  </div>
                  <div className="text-[11px] text-ink-3" style={{ marginTop: 2, lineHeight: 1.5 }}>
                    {t("rc_na_rule_not_triggered")
                      .replace("{name}", ctx.name)
                      .replace("{jr}", ctx.jrTitle)}
                  </div>
                </div>
              </div>
              {/* 可点击展开看 Neo4j 上的原规则定义 */}
              <RuleDefinitionPanel ruleId={f.rule_id} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 候选人画像面板 — 把 parsed_resume_full / job_requisition_full 关键字段抠出来
 * 一目了然显示"这是谁,跟岗位匹不匹"。
 */
function CandidateProfileCard({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  const r = (detail.parsed_resume_full ?? {}) as Record<string, unknown>;
  const j = (detail.job_requisition_full ?? {}) as Record<string, unknown>;

  // 从 parsed_resume 抠候选人画像
  const name = pickStr(r.name);
  const gender = pickStr(r.gender);
  const marital = pickStr(r.marital_status);
  const nationality = pickStr(r.nationality);
  const address = pickStr(r.address);
  const phone = pickStr(r.phone);
  const expectedSalary = pickStr(r.expected_salary_range);

  // education
  const edu = Array.isArray(r.education) ? (r.education as Array<Record<string, unknown>>) : [];
  const edu0 = edu[0] ?? {};
  const degree = pickStr(edu0.degree);
  const school = pickStr(edu0.institution);
  const major = pickStr(edu0.field);
  const eduStart = pickStr(edu0.startDate);
  const eduEnd = pickStr(edu0.endDate);

  // experience
  const exp = Array.isArray(r.experience) ? (r.experience as Array<Record<string, unknown>>) : [];
  const totalYears = exp.length > 0 ? `${exp.length} (${exp.slice(0, 3).map((e) => `${pickStr(e.company) || '?'}/${pickStr(e.role) || pickStr(e.title) || '?'}`).join(' / ')})` : null;

  // JR 画像
  const jrTitle = pickStr(j.client_job_title);
  const jrDept = pickStr(j.first_level_department);
  const jrCity = pickStr(j.work_city) || pickStr(j.city);
  const jrSalary = pickStr(j.salary_range);
  const jrDegreeReq = pickStr(j.degree_requirement) || pickStr(j.education_requirement);

  if (!detail.parsed_resume_full && !detail.job_requisition_full) {
    return null;
  }

  return (
    <div
      className="border border-line rounded-sm grid"
      style={{
        padding: "12px 14px",
        background: "color-mix(in oklab, var(--c-accent) 5%, var(--c-bg))",
        gridTemplateColumns: "1fr 1fr",
        gap: "10px 18px",
      }}
    >
      {/* Candidate profile */}
      <div>
        <div className="hint" style={{ marginBottom: 6 }}>
          👤 {t("rc_candidate_profile_title")}
        </div>
        <div className="text-[13px] text-ink-1 font-semibold" style={{ marginBottom: 4 }}>
          {name || t("rc_candidate_no_name")}
          {gender ? ` · ${gender}` : ""}
          {marital ? ` · ${marital}` : ""}
          {nationality ? ` · ${nationality}` : ""}
        </div>
        <div className="text-[11.5px] text-ink-2" style={{ lineHeight: 1.6 }}>
          {degree || school || major ? (
            <div>
              <span className="hint">{t("rc_edu_label")}</span> {degree}
              {school ? ` · ${school}` : ""}
              {major ? ` · ${major}` : ""}
              {eduEnd ? ` · ${eduStart || "?"} → ${eduEnd}` : ""}
            </div>
          ) : null}
          {totalYears ? (
            <div>
              <span className="hint">{t("rc_exp_label")}</span> {totalYears}
            </div>
          ) : null}
          {address || phone ? (
            <div className="text-ink-3">
              {address ? `${address}` : ""}
              {phone ? ` · 📞 ${phone.slice(0, 3)}****${phone.slice(-2)}` : ""}
            </div>
          ) : null}
          {expectedSalary ? (
            <div>
              <span className="hint">{t("rc_salary_label")}</span> {expectedSalary}
            </div>
          ) : null}
        </div>
      </div>

      {/* Position profile */}
      <div>
        <div className="hint" style={{ marginBottom: 6 }}>
          💼 {t("rc_jr_profile_title")}
        </div>
        <div className="text-[13px] text-ink-1 font-semibold" style={{ marginBottom: 4 }}>
          {jrTitle || t("rc_jr_no_title")}
          {jrDept ? ` · ${jrDept}` : ""}
        </div>
        <div className="text-[11.5px] text-ink-2" style={{ lineHeight: 1.6 }}>
          {jrCity ? <div><span className="hint">{t("rc_city_label")}</span> {jrCity}</div> : null}
          {jrSalary ? <div><span className="hint">{t("rc_salary_range_label")}</span> {jrSalary}</div> : null}
          {jrDegreeReq ? <div><span className="hint">{t("rc_degree_req_label")}</span> {jrDegreeReq}</div> : null}
          <div className="text-ink-3">
            client_id: {detail.client_name || "?"}{detail.business_group ? ` × ${detail.business_group}` : ""}
          </div>
        </div>
      </div>

      {/* Gating rule conflicts (from failure_reasons) */}
      {detail.failure_reasons.length > 0 ? (
        <div style={{ gridColumn: "1 / -1", paddingTop: 4, borderTop: "1px solid var(--c-line)" }}>
          <div className="hint" style={{ marginBottom: 4 }}>
            ⚠ {t("rc_failure_hit")}
          </div>
          <div className="text-[12px] text-err" style={{ lineHeight: 1.5 }}>
            {detail.failure_reasons.join(" · ")}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function pickStr(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim();
}

/**
 * A1 — Inference Chain 卡片
 * 把每条 flag 渲染成"因果链":LLM evidence → next_action → 对整体决策影响
 *
 * step 3 文案带候选人 / JD 上下文,让 leader / 客户能看到"是谁因为什么不通过/通过"。
 */
/** 规则三层归属 → i18n 标签。 */
function tierLabel(tier: string, t: (k: string) => string): string {
  if (tier === "general") return t("rc_tier_general");
  if (tier === "client") return t("rc_tier_client");
  if (tier === "department") return t("rc_tier_department");
  return tier;
}

function InferenceChainCard({
  flag,
  auditId,
  ctx,
  provenance,
}: {
  flag: {
    flag_id: string;
    rule_id: string;
    rule_name_snapshot: string;
    severity: string;
    applicable: boolean;
    result: string;
    evidence: string;
    next_action: string;
  };
  auditId: string;
  ctx: CandidateContext;
  provenance: { tier: string; reason: string } | null;
}) {
  const { t } = useApp();
  const isBottomLine = flag.severity === "terminal" || flag.severity === "needs_human";
  const isFail = flag.result === "FAIL";
  const blocks = isBottomLine && isFail;
  // 是否是整体 FAIL 的真正原因(命中 failure_reasons)— 用于 step 3 强调
  const isFailureCause = ctx.failureRuleIds.has(flag.rule_id);

  // 顶部颜色编码:阻断的 FAIL 红 / 提示 FAIL 黄 / PASS 绿 / NA 灰
  const headerBg = blocks
    ? "color-mix(in oklab, var(--c-err) 10%, var(--c-bg))"
    : isFail
      ? "color-mix(in oklab, var(--c-warn) 10%, var(--c-bg))"
      : flag.result === "PASS"
        ? "color-mix(in oklab, var(--c-ok) 8%, var(--c-bg))"
        : "var(--c-panel)";

  // step 3 — 一句话总结对整体决策的影响,引用候选人 + JD + evidence 摘要
  const impactSentence = buildImpactSentence({
    blocks,
    isFail,
    isBottomLine,
    isFailureCause,
    name: ctx.name,
    jrTitle: ctx.jrTitle,
    evidence: flag.evidence,
    t,
  });

  return (
    <div
      className="border border-line rounded-sm overflow-hidden"
      style={{ background: "var(--c-bg)" }}
    >
      {/* 头部:rule_id · name · severity · result · 跳 Neo4j */}
      <div
        className="flex items-center gap-2"
        style={{ padding: "10px 14px", background: headerBg }}
      >
        <span className="mono text-[12.5px] text-ink-1 font-semibold">
          {flag.rule_id}
        </span>
        <span className="text-[12px] text-ink-1 flex-1 truncate">
          {flag.rule_name_snapshot}
        </span>
        <span title={`ontology severity: ${flag.severity}`}>
          <Badge variant={isBottomLine ? "err" : "default"}>
            {flag.severity === "flag_only" ? t("rc_flag_severity_tip") : t("rc_flag_severity_bottomline")}
          </Badge>
        </span>
        <Badge variant={flag.result === "PASS" ? "ok" : flag.result === "FAIL" ? "err" : "default"}>
          {flag.result}
        </Badge>
      </div>

      {/* Candidate + JD context row */}
      <div
        className="text-[11px] text-ink-3"
        style={{ padding: "6px 14px 0", lineHeight: 1.5 }}
      >
        {t("rc_candidate_context_line")
          .replace("{name}", ctx.name)
          .replace("{jr}", ctx.jrTitle)}
      </div>

      {/* 为何抓取此规则 — 三层归属 + 纳入证据(替代原独立"抓取链路"卡片) */}
      {provenance ? (
        <div
          className="flex items-center gap-2 flex-wrap"
          style={{ padding: "8px 14px 0" }}
        >
          <span className="hint">🔗 {t("rc_why_fetched")}</span>
          <Badge variant="default">{tierLabel(provenance.tier, t)}</Badge>
          <span className="text-[11.5px] text-ink-3">{provenance.reason}</span>
        </div>
      ) : null}

      {/* Inference chain: 3 steps */}
      <div className="flex flex-col" style={{ padding: "10px 14px", gap: 6 }}>
        {flag.applicable ? (
          <>
            <ChainStep
              step="1"
              label={t("rc_chain_step1_evidence")}
              ok={flag.result === "PASS"}
              warn={flag.result === "FAIL"}
              content={flag.evidence || t("rc_evidence_no_llm")}
            />
            <ChainStep
              step="2"
              label={isBottomLine ? t("rc_flag_step2_bottomline") : t("rc_flag_step2_tip")}
              ok={flag.next_action === "continue"}
              warn={flag.next_action === "block"}
              content={
                flag.next_action === "block"
                  ? t("rc_chain_step2_block")
                  : flag.next_action === "continue"
                    ? t("rc_chain_step2_continue")
                    : flag.next_action === "supplement"
                      ? t("rc_chain_step2_supplement")
                      : flag.next_action === "review"
                        ? t("rc_chain_step2_review")
                        : flag.next_action || t("rc_chain_step2_not_given")
              }
            />
            <ChainStep
              step="3"
              label={t("rc_chain_step3_label")}
              ok={!blocks}
              warn={blocks}
              content={impactSentence}
            />
          </>
        ) : (
          <ChainStep
            step="—"
            label={t("rc_chain_na_label")}
            ok
            content={t("rc_chain_na_content")
              .replace("{name}", ctx.name)
              .replace("{jr}", ctx.jrTitle)}
          />
        )}
      </div>

      {/* 可展开:点开看 Neo4j 上的原规则定义(submissionCriteria / 判定逻辑等)*/}
      <RuleDefinitionPanel ruleId={flag.rule_id} />
    </div>
  );
}

/**
 * step 3 一句话总结:把候选人 / JD / evidence 摘要 / 决策影响串起来,leader 一眼看懂。
 * 4 种分支:底线 FAIL(决定整体 FAIL)/ 底线 FAIL(被 failure_reasons 漏掉 — 罕见)/
 *          提示 FAIL(仅 augmentation 标注)/ PASS(本规则通过)
 */
function buildImpactSentence(args: {
  blocks: boolean;
  isFail: boolean;
  isBottomLine: boolean;
  isFailureCause: boolean;
  name: string;
  jrTitle: string;
  evidence: string;
  t: (k: string) => string;
}): string {
  const { blocks, isFail, isBottomLine, isFailureCause, name, jrTitle, evidence, t } = args;
  const ev = summarizeEvidence(evidence, t);
  if (blocks) {
    const key = isFailureCause ? "rc_impact_bottomline_fail_cause" : "rc_impact_bottomline_fail";
    return t(key)
      .replace("{name}", name)
      .replace("{jr}", jrTitle)
      .replace("{ev}", ev);
  }
  if (isFail) {
    return t("rc_impact_flag_only_fail")
      .replace("{name}", name)
      .replace("{jr}", jrTitle)
      .replace("{ev}", ev);
  }
  if (isBottomLine) {
    return t("rc_impact_bottomline_pass")
      .replace("{name}", name)
      .replace("{jr}", jrTitle)
      .replace("{ev}", ev);
  }
  return t("rc_impact_flag_only_pass")
    .replace("{name}", name)
    .replace("{jr}", jrTitle)
    .replace("{ev}", ev || "");
}

/**
 * 把 LLM evidence 浓缩成一句"理由摘要",拼到 impact sentence 里:
 *   - 砍掉重复的"候选人 X..."前缀(impact sentence 已经写过姓名了)
 *   - 取头一句(到第一个句号 / 分号 / 换行)
 *   - 超长截到 80 字加 …
 */
function summarizeEvidence(evidence: string, t: (k: string) => string): string {
  if (!evidence) return t("rc_evidence_no_llm");
  let s = evidence.trim().replace(/^候选人[^,。:]{1,6}[,。:]?\s*/, "");
  const cut = s.search(/[。;\n]/);
  if (cut > 0) s = s.slice(0, cut);
  if (s.length > 80) s = s.slice(0, 80) + "…";
  return s;
}

function ChainStep({
  step,
  label,
  content,
  ok = false,
  warn = false,
}: {
  step: string;
  label: string;
  content: string;
  ok?: boolean;
  warn?: boolean;
}) {
  const color = warn ? "var(--c-err)" : ok ? "var(--c-ok)" : "var(--c-ink-3)";
  return (
    <div className="flex items-start" style={{ gap: 10, lineHeight: 1.55 }}>
      <span
        className="mono text-[10.5px] font-semibold flex-none"
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          background: color,
          color: "var(--c-bg)",
          textAlign: "center",
          lineHeight: "18px",
        }}
      >
        {step}
      </span>
      <div className="flex-1 min-w-0">
        <span className="hint" style={{ marginRight: 6 }}>
          {label}
        </span>
        <span className="text-[12px] text-ink-1">{content}</span>
      </div>
    </div>
  );
}

function ResponseTab({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  return (
    <div className="flex flex-col gap-4">
      <CandidateProfileCard detail={detail} />
      {detail.resume_augmentation ? (
        <div>
          <div className="hint flex items-center" style={{ gap: 8, marginBottom: 6 }}>
            <span>{t("rc_resume_aug_title")}</span>
            <CopyBtn text={detail.resume_augmentation} />
          </div>
          <pre
            className="mono text-[11.5px] text-ink-1 bg-panel border border-line rounded-sm whitespace-pre-wrap"
            style={{ padding: "12px 14px" }}
          >
            {detail.resume_augmentation}
          </pre>
        </div>
      ) : null}
      <div>
        <div className="hint flex items-center" style={{ gap: 8, marginBottom: 6 }}>
          <span>{t("rc_llm_raw_response")}</span>
          <span className="mono text-ink-3 text-[10.5px]">
            {detail.llm_raw_text?.length ?? 0} chars
          </span>
          {detail.llm_raw_text ? (
            <CopyBtn text={detail.llm_raw_text} />
          ) : null}
        </div>
        <pre
          className="mono text-[11.5px] text-ink-1 bg-panel border border-line rounded-sm whitespace-pre-wrap"
          style={{ padding: "12px 14px" }}
        >
          {detail.llm_raw_text ?? t("rc_llm_raw_missing")}
        </pre>
      </div>
    </div>
  );
}

function InstancesTab({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  const fullMissing =
    detail.parsed_resume_full === null && detail.job_requisition_full === null;
  return (
    <div className="flex flex-col gap-5">
      {/* ① Allmeta 实时读 — 证明 AO 能经 Allmeta API 拿 Neo4j 数据 */}
      <AllmetaLiveSnapshot detail={detail} />
      <div>
        <div
          className="hint flex items-center"
          style={{ gap: 8, marginBottom: 8 }}
        >
          <span>{t("rc_instances_full_input_title")}</span>
        </div>
        {fullMissing ? (
          <div
            className="border border-line bg-panel rounded-sm text-[11.5px] text-ink-2"
            style={{ padding: "10px 14px", lineHeight: 1.6 }}
          >
            <span className="text-warn font-semibold">⚠ {t("rc_instances_full_missing_warn")}</span>
            {" — "}{t("rc_instances_full_missing_body")}
            <br />
            <span className="text-ink-3">
              {t("rc_instances_full_missing_new")} <strong> 🔁 {t("rc_replay")} </strong>
            </span>
            <br />
            <span className="text-ink-3">
              {t("rc_instances_full_missing_anchor")}
            </span>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <InstanceCard
              title={t("rc_instance_parsed_resume_title")}
              data={detail.parsed_resume_full}
              note={t("rc_instance_parsed_resume_note")}
            />
            <InstanceCard
              title={t("rc_instance_jr_title")}
              data={detail.job_requisition_full}
              note={t("rc_instance_jr_note")}
            />
          </div>
        )}
      </div>
      <div>
        <div
          className="hint flex items-center"
          style={{ gap: 8, marginBottom: 8 }}
        >
          <span>{t("rc_anchor_title")}</span>
        </div>
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <InstanceCard
            title={t("rc_snapshot_candidate")}
            data={detail.candidate_snapshot}
            note={t("rc_anchor_candidate_note")}
          />
          <InstanceCard
            title={t("rc_snapshot_resume")}
            data={detail.resume_snapshot}
            note={t("rc_anchor_resume_note")}
          />
          <InstanceCard
            title={t("rc_snapshot_jr")}
            data={detail.jr_snapshot}
            note={t("rc_anchor_jr_note")}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Allmeta 实时快照面板 — 经 `/api/allmeta/instance` 反查 Neo4j 数据,
 * 证明 AO 在用 Allmeta API 路径(不是直连 Bolt)。每条带可粘 Cypher。
 */
function AllmetaLiveSnapshot({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  const targets = [
    { label: 'Candidate', pk: detail.candidate_id, displayName: ':Candidate' },
    { label: 'Resume', pk: detail.resume_id, displayName: ':Resume' },
    { label: 'Job_Requisition', pk: detail.job_requisition_id, displayName: ':Job_Requisition' },
  ];
  return (
    <div>
      <div
        className="hint flex items-center"
        style={{ gap: 8, marginBottom: 8 }}
      >
        <span>🛰️ {t("rc_allmeta_title")}</span>
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
        {targets.map((t) => (
          <AllmetaInstanceCard key={t.label} label={t.label} pk={t.pk} title={t.displayName} />
        ))}
      </div>
    </div>
  );
}

type AllmetaCardResponse =
  | {
      ok: true;
      label: string;
      pk_field: string;
      pk_value: string;
      instance: Record<string, unknown>;
      verify: { cypher: string; api_path: string; domain: string };
    }
  | {
      ok: false;
      reason: string;
      status?: number;
      details?: unknown;
      verify?: { cypher: string; api_path: string };
    };

function AllmetaInstanceCard({
  label,
  pk,
  title,
}: {
  label: string;
  pk: string;
  title: string;
}) {
  const { t } = useApp();
  const [data, setData] = React.useState<AllmetaCardResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!pk) {
      setLoading(false);
      return;
    }
    fetchJson<AllmetaCardResponse>(
      `/api/allmeta/instance?label=${encodeURIComponent(label)}&pk=${encodeURIComponent(pk)}`,
    )
      .then(setData)
      .catch(() => setData({ ok: false, reason: 'fetch_failed' }))
      .finally(() => setLoading(false));
  }, [label, pk]);

  return (
    <div
      className="border border-line bg-panel rounded-sm"
      style={{ padding: "10px 12px" }}
    >
      <div
        className="hint mono text-[10.5px] flex items-center"
        style={{ marginBottom: 6, gap: 8 }}
      >
        <span>{title}</span>
        {data?.ok ? (
          <>
            <Badge variant="ok">Allmeta OK</Badge>
            <span className="text-ink-3 text-[10px]">
              {t("rc_allmeta_fields").replace("{count}", String(Object.keys(data.instance).length))}
            </span>
            <CopyBtn text={JSON.stringify(data.instance, null, 2)} />
          </>
        ) : data ? (
          <Badge variant="err">{data.reason}</Badge>
        ) : null}
      </div>
      <div className="mono text-[10px] text-ink-3" style={{ marginBottom: 6 }}>
        pk: {pk?.slice(0, 36) || t("rc_allmeta_no_pk")}
      </div>

      {loading ? (
        <div className="text-ink-3 text-[11px]">{t("rc_allmeta_loading")}</div>
      ) : !data ? (
        <div className="text-ink-3 text-[11px]">{t("rc_cell_unloaded")}</div>
      ) : data.ok ? (
        <>
          <pre
            className="mono text-[10.5px] text-ink-2 whitespace-pre-wrap"
            style={{ lineHeight: 1.5, maxHeight: 280, overflow: "auto" }}
          >
            {JSON.stringify(data.instance, null, 2)}
          </pre>
          {/* Cypher snippet kept for dev verification of written instances
              (per 2026-05-25 user clarification — hide graph-engine entry
              jumps but keep the read-only Cypher for copy + paste). */}
          <div
            className="mono text-[10px] text-ink-3"
            style={{
              marginTop: 6,
              padding: "6px 8px",
              background: "var(--c-bg)",
              borderRadius: 3,
            }}
          >
            <div className="text-ink-3 mb-1">📋 验证 Cypher (开发用):</div>
            <CypherSnippet cypher={data.verify.cypher} />
            <div className="mt-2 text-ink-3 text-[9.5px]">
              Allmeta API: {data.verify.api_path}
            </div>
          </div>
        </>
      ) : (
        <div className="text-[11px] text-err">
          {data.reason}
          {data.status ? ` (HTTP ${data.status})` : ""}
          {data.details ? (
            <div className="mono text-[10.5px] text-ink-3" style={{ marginTop: 4 }}>
              {String(data.details).slice(0, 200)}
            </div>
          ) : null}
          {data.verify ? (
            <div
              className="mono text-[10px] text-ink-3"
              style={{ marginTop: 6, padding: "6px 8px", background: "var(--c-bg)", borderRadius: 3 }}
            >
              <div className="text-ink-3 mb-1">📋 直查 Cypher (开发用):</div>
              <CypherSnippet cypher={data.verify.cypher} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// CypherSnippet — read-only display of the cypher used to verify a
// written instance. Per 2026-05-25 user clarification: hide direct-entry
// jumps to the graph engine but keep the Cypher text for dev verification.
function CypherSnippet({ cypher }: { cypher: string }) {
  return (
    <div className="flex items-start" style={{ gap: 6 }}>
      <pre
        className="mono text-[10.5px] text-ink-1 whitespace-pre-wrap"
        style={{ flex: 1, lineHeight: 1.4 }}
      >
        {cypher}
      </pre>
      <CopyBtn text={cypher} />
    </div>
  );
}

function InstanceCard({
  title,
  data,
  note,
}: {
  title: string;
  data: Record<string, unknown> | null;
  note?: string;
}) {
  const { t } = useApp();
  const text = data ? JSON.stringify(data, null, 2) : "";
  return (
    <div
      className="border border-line bg-panel rounded-sm"
      style={{ padding: "10px 12px" }}
    >
      <div
        className="hint mono text-[10.5px] flex items-center"
        style={{ marginBottom: 6, gap: 8 }}
      >
        <span>{title}</span>
        {data ? (
          <>
            <span className="text-ink-3">·</span>
            <span className="text-ink-3 text-[10px]">
              {t("rc_allmeta_fields").replace("{count}", String(Object.keys(data).length))}
            </span>
            <CopyBtn text={text} />
          </>
        ) : null}
      </div>
      {note ? (
        <div
          className="text-ink-3 text-[10.5px]"
          style={{ marginBottom: 6, lineHeight: 1.4 }}
        >
          {note}
        </div>
      ) : null}
      {!data ? (
        <div className="text-ink-3 text-[11.5px]">{t("rc_cell_unloaded")}</div>
      ) : (
        <pre
          className="mono text-[10.5px] text-ink-2 whitespace-pre-wrap"
          style={{ lineHeight: 1.5, maxHeight: 480, overflow: "auto" }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

// 2026-05-25 cleanup per user request: AO no longer offers DIRECT-ENTRY
// jumps into the graph engine browser. Removed:
//   - Neo4jLinkBtn (clickable "open in Neo4j Browser" + clipboard cypher)
// Kept (dev verification):
//   - CypherSnippet (read-only Cypher display + copy button) — see
//     definition further up. User can copy + run elsewhere to verify
//     writes, but AO itself never navigates to the graph engine.

function CopyBtn({ text }: { text: string }) {
  const { t } = useApp();
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="mono text-[10.5px] text-ink-3 border-0 bg-transparent cursor-pointer hover:text-ink-1"
      style={{ padding: 0 }}
    >
      {copied ? t("rc_copied_btn") : t("rc_copy_btn")}
    </button>
  );
}

/**
 * 单条规则详情面板 — 懒加载,从 /api/ontology/rules/[ruleId] 拉 Neo4j 原始
 * Rule 节点字段。给 InferenceChainCard / NotApplicableRulesSection 嵌入用。
 *
 * 展开时 fetch,close 不释放(已加载的 rule 缓存在 state 里);切换不同 rule_id
 * 由 React key 重建组件,自然清缓存。
 */
function RuleDefinitionPanel({ ruleId }: { ruleId: string }) {
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
  rule: import("@/lib/rule-check/types").Rule;
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
