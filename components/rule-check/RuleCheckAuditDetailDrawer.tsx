"use client";
import React from "react";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { MiniMarkdown } from "@/components/shared/MiniMarkdown";
import {
  RuleSelectionTab,
  RuleJudgmentTab,
  useVerifyRun,
} from "@/components/rule-check/RuleSelectionVerifyTab";
import { CandidateProfileCard } from "@/components/rule-check/CandidateProfileCard";
import { verdictLabel } from "@/components/rule-check/verdict-label";
import { isInfraFailure } from "@/lib/rule-check/infra-failure";
import { fetchJson } from "@/lib/api/client";
import { useApp } from "@/lib/i18n";
import type {
  RuleCheckAuditDetailResponse,
  RuleCheckAuditDetail,
} from "@/app/api/rule-check-audits/[auditId]/route";

type Tab = "select" | "prompt" | "verify" | "response" | "instances";

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
  const [tab, setTab] = React.useState<Tab>("select");
  const [isReplaying, setIsReplaying] = React.useState(false);
  const [replayMsg, setReplayMsg] = React.useState<string | null>(null);
  // Cross-validation lifecycle owned here so the 规则筛选 (selection-only) and
  // 规则判断 (full) tabs share ONE LLM call. Auto-runs once the audit loads.
  const verify = useVerifyRun(auditId, data?.ok === true);

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
          <IdReveal id={auditId} label={t("rc_audit_id_label")} />
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
            <TabBtn active={tab === "select"} onClick={() => setTab("select")}>
              ✦ {t("rc_tab_select")}
            </TabBtn>
            <TabBtn active={tab === "prompt"} onClick={() => setTab("prompt")}>
              {t("rc_tab_prompt")}
            </TabBtn>
            <TabBtn active={tab === "verify"} onClick={() => setTab("verify")}>
              {t("rc_tab_judge")}
            </TabBtn>
            <TabBtn active={tab === "response"} onClick={() => setTab("response")}>
              {t("rc_tab_response")}
            </TabBtn>
            <TabBtn active={tab === "instances"} onClick={() => setTab("instances")}>
              {t("rc_tab_instances")}
            </TabBtn>
          </div>
          <div className="flex-1 overflow-auto" style={{ padding: "16px 18px" }}>
            <div key={tab} className="rc-fade-in">
              {tab === "select" ? (
                <RuleSelectionTab detail={data.detail} verify={verify} />
              ) : tab === "prompt" ? (
                <PromptTab detail={data.detail} />
              ) : tab === "verify" ? (
                <RuleJudgmentTab detail={data.detail} verify={verify} />
              ) : tab === "response" ? (
                <ResponseTab detail={data.detail} />
              ) : (
                <InstancesTab detail={data.detail} />
              )}
            </div>
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
        className="bg-surface border-l border-line flex flex-col rc-drawer-in"
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

/** 平时只显示一个文字标签(如「标识符」/ 候选人名);点击弹出一个浮层展示完整 ID,
 *  再点浮层复制。让长 cm_ / ULID 不占版面又随时可查/可复制。 */
function IdReveal({ id, label }: { id: string; label: string }) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  if (!id) return null;
  return (
    <span className="relative inline-flex" style={{ verticalAlign: "middle" }}>
      <button
        type="button"
        className="mono text-[11px] text-ink-3 hover:text-ink-1"
        style={{ textDecoration: "underline dotted", textUnderlineOffset: 3 }}
        title={id}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
          setCopied(false);
        }}
      >
        {label}
      </button>
      {open ? (
        <span
          className="absolute z-50 mono text-[11px] text-ink-1"
          style={{
            top: "calc(100% + 4px)",
            left: 0,
            padding: "6px 9px",
            background: "var(--c-surface)",
            border: "1px solid var(--c-line)",
            borderRadius: 6,
            whiteSpace: "nowrap",
            boxShadow: "0 6px 18px -8px rgba(0,0,0,0.35)",
            cursor: "pointer",
          }}
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard?.writeText(id).then(
              () => setCopied(true),
              () => {},
            );
          }}
        >
          {id}
          <span className="text-ink-3" style={{ marginLeft: 8 }}>
            {copied ? "✓" : "⧉"}
          </span>
        </span>
      ) : null}
    </span>
  );
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
              {detail.client_display_name || detail.client_name || "—"}
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
                .replace("{evaluated}", String(detail.rules_evaluated))
                .replace("{applicable}", String(detail.flags.filter((f) => f.applicable).length))
                .replace("{na}", String(detail.flags.filter((f) => !f.applicable).length))}
            </span>
            <Badge variant="default">
              {detail.rule_source === "ontology-api"
                ? t("rc_src_live")
                : detail.rule_source === "json-fallback"
                  ? t("rc_src_fallback")
                  : detail.rule_source === "snapshot"
                    ? t("rc_src_snapshot")
                    : detail.rule_source}
            </Badge>
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
  const { t } = useApp();
  const pass = detail.decision === "PASS";
  // Infra park (没钱/故障): show as 未完成 in warn-amber, NOT a red 未通过 — the
  // candidate was not rejected, evaluation just couldn't finish.
  const infra = isInfraFailure(detail.fail_reason);
  const accent = infra ? "var(--c-warn)" : pass ? "var(--c-ok)" : "var(--c-err)";
  return (
    <div
      className="rc-banner-in border-b border-line flex items-center gap-5"
      style={{
        padding: "20px 22px",
        background: `linear-gradient(100deg, color-mix(in oklab, ${accent} 18%, var(--c-bg)) 0%, color-mix(in oklab, ${accent} 7%, var(--c-bg)) 55%, var(--c-bg) 100%)`,
        borderLeft: `4px solid ${accent}`,
        boxShadow: `inset 14px 0 24px -18px ${accent}`,
      }}
    >
      <div
        className="rc-verdict-pop tabular-nums"
        style={{
          fontFamily: SERIF,
          fontSize: 36,
          fontWeight: 500,
          color: accent,
          minWidth: 120,
          lineHeight: 1,
          letterSpacing: "-0.02em",
          textShadow: `0 0 22px color-mix(in oklab, ${accent} 35%, transparent)`,
        }}
      >
        {infra ? t("rc_verdict_parked") : verdictLabel(detail.decision, t)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-ink-1" style={{ fontSize: 14, lineHeight: 1.55 }}>
          {summary}
        </div>
        <div className="text-ink-2 text-[11.5px] mt-2 flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
          {(() => {
            // candidate_name / agent_label 是 ontology 审计源加的扩展字段,不在主 contract 类型上。
            const ext = detail as unknown as {
              candidate_name?: string | null;
              agent_label?: string | null;
              selection?: Record<string, unknown>;
            };
            const sel = (ext.selection ?? {}) as Record<string, unknown>;
            const candName =
              ext.candidate_name ||
              (typeof sel.matchedCandidateName === "string" ? sel.matchedCandidateName : null);
            return candName ? <span className="text-ink-1">{candName}</span> : null;
          })()}
          {(detail as unknown as { agent_label?: string | null }).agent_label ? (
            <span className="text-ink-3">· {(detail as unknown as { agent_label?: string }).agent_label}</span>
          ) : null}
          {detail.client_display_name || detail.client_name ? (
            <span className="text-ink-3">
              · {detail.client_display_name || detail.client_name}
              {detail.business_group ? ` × ${detail.business_group}` : ""}
            </span>
          ) : null}
          {detail.candidate_id ? <IdReveal id={detail.candidate_id} label={t("rc_audit_id_label")} /> : null}
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

function PromptTab({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  const [view, setView] = React.useState<"rendered" | "raw">("rendered");
  // 纯确定性(能源 / 费控)且无大模型提示词时才显示「无 LLM」;混合型(查重:确定性核心
  // + 大模型纳入依据)有 user_prompt → 落到下面正常渲染该提示词。
  if (detail.deterministic && !detail.user_prompt) {
    return (
      <EmptyState
        icon={<Ic.shield />}
        title={t("rc_tab_prompt")}
        hint={t("rc_deterministic_prompt")}
        variant="info"
      />
    );
  }
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

function ResponseTab({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  // 纯确定性(能源 / 费控)且无大模型响应时才显示「无 LLM 响应」;混合型(查重)有
  // llm_raw_text → 落到下面正常渲染大模型纳入依据的原始响应。
  if (detail.deterministic && !detail.llm_raw_text) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          icon={<Ic.shield />}
          title={t("rc_tab_response")}
          hint={t("rc_deterministic_response")}
          variant="info"
        />
        {detail.failure_reasons.length > 0 ? (
          <div
            className="border border-line rounded-sm"
            style={{ padding: "12px 14px", borderLeft: "3px solid var(--c-err)", background: "var(--c-err-bg)" }}
          >
            <div className="hint" style={{ color: "var(--c-err)", marginBottom: 6 }}>
              {t("rc_failure_reasons_label")}
            </div>
            <div className="mono text-[12px] text-err" style={{ lineHeight: 1.6 }}>
              {detail.failure_reasons.join("、")}
            </div>
          </div>
        ) : null}
      </div>
    );
  }
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

// Deterministic ontology rule-check (energy / 费控) instance view: the actual
// values each rule read/compared, drawn from the per-rule evals — NOT the
// recruitment Candidate/Resume/JD graph (there is no candidate here).
function DeterministicInstances({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  const flags = detail.flags ?? [];
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="hint" style={{ marginBottom: 8 }}>{t("rc_deterministic_instances_title")}</div>
        <div
          className="grid"
          style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "10px 22px", marginBottom: 8 }}
        >
          <Kv label={t("rc_kv_candidate_id")}>
            <span className="mono text-[11.5px]">{detail.candidate_id || "—"}</span>
          </Kv>
          <Kv label={t("rc_kv_client_bg_studio")}>
            <span className="text-[12px]">
              {detail.client_name || "—"}
              {detail.business_group ? ` · ${detail.business_group}` : ""}
            </span>
          </Kv>
          <Kv label={t("rc_kv_rules_evaluated")}>
            <span className="mono text-[11.5px]">
              {detail.rules_evaluated} / {detail.rules_total_in_ontology}
            </span>
          </Kv>
        </div>
        <div className="hint" style={{ fontSize: 11 }}>{t("rc_deterministic_instances_hint")}</div>
      </div>
      <div className="flex flex-col" style={{ gap: 6 }}>
        {flags.map((f) => (
          <div
            key={f.flag_id}
            className="border border-line rounded-sm"
            style={{ padding: "8px 10px", background: "var(--c-bg)" }}
          >
            <div className="flex items-center gap-2" style={{ marginBottom: f.evidence ? 4 : 0 }}>
              <span className="mono text-[11.5px] text-ink-1 font-semibold flex-none">{f.rule_id}</span>
              <span className="text-[12px] text-ink-2 flex-1 truncate">{f.rule_name_snapshot}</span>
              <Badge variant={f.result === "PASS" ? "ok" : f.result === "NOT_APPLICABLE" ? "default" : "err"}>
                {verdictLabel(f.result, t)}
              </Badge>
            </div>
            {f.evidence ? (
              <div className="text-[11.5px] text-ink-2" style={{ lineHeight: 1.55 }}>{f.evidence}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function InstancesTab({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  if (detail.deterministic) {
    return <DeterministicInstances detail={detail} />;
  }
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
            <Badge variant="ok">图引擎 OK</Badge>
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
            <div className="text-ink-3 mb-1">📋 {t("rc_verify_cypher_dev")}</div>
            <CypherSnippet cypher={data.verify.cypher} />
            <div className="mt-2 text-ink-3 text-[9.5px]">
              图引擎 API: {data.verify.api_path}
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
              <div className="text-ink-3 mb-1">📋 {t("rc_direct_cypher_dev")}</div>
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

