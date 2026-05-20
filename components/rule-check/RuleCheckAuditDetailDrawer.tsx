"use client";
import React from "react";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
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

export function RuleCheckAuditDetailDrawer({
  auditId,
  onClose,
}: {
  auditId: string;
  onClose: () => void;
}) {
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
        setReplayMsg(`已重发 — 新 event ${r.new_event_id?.slice(0, 12)}…(等 30-60s 看新 audit)`);
      } else {
        setReplayMsg(`重发失败: ${r.error}`);
      }
    } catch (e) {
      setReplayMsg(`重发出错: ${(e as Error).message.slice(0, 80)}`);
    } finally {
      setIsReplaying(false);
      setTimeout(() => setReplayMsg(null), 8000);
    }
  }, [auditId, isReplaying]);

  // ESC to close
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

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
        <div
          className="border-b border-line flex items-center gap-3"
          style={{ padding: "12px 18px" }}
        >
          <Ic.shield />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold tracking-tight truncate">
              Rule Check Audit
            </div>
            <div className="mono text-[11px] text-ink-3 truncate">{auditId}</div>
          </div>
          <Neo4jLinkBtn
            label="🔗 Neo4j"
            title="复制查询并跳 Neo4j Browser"
            cypher={`MATCH (a:RuleCheckAudit {audit_id: "${auditId}"})\nOPTIONAL MATCH (a)-[r]->(n)\nRETURN a, r, n`}
          />
          <Btn size="sm" onClick={onClose}>
            关闭 (Esc)
          </Btn>
        </div>

        {loading && !data ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState title="加载中…" hint="" />
          </div>
        ) : !data ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={<Ic.alert />}
              title="加载失败"
              hint="后端无响应"
            />
          </div>
        ) : !data.ok ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={<Ic.alert />}
              title={
                data.reason === "not_found"
                  ? "audit 不存在"
                  : "读取出错"
              }
              hint={data.reason === "error" ? data.error ?? "" : ""}
              variant="info"
            />
          </div>
        ) : (
          <>
            <DetailHeader
              detail={data.detail}
              onReplay={onReplay}
              isReplaying={isReplaying}
            />
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
                User Prompt
              </TabBtn>
              <TabBtn active={tab === "rules"} onClick={() => setTab("rules")}>
                Rule Flags ({data.detail.flags.length})
              </TabBtn>
              <TabBtn active={tab === "response"} onClick={() => setTab("response")}>
                LLM Response
              </TabBtn>
              <TabBtn active={tab === "instances"} onClick={() => setTab("instances")}>
                实例数据 (anchors)
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
      </div>
    </div>
  );
}

function DetailHeader({
  detail,
  onReplay,
  isReplaying,
}: {
  detail: RuleCheckAuditDetail;
  onReplay: () => void;
  isReplaying: boolean;
}) {
  // A5 — 一句话决策摘要(给 leader / 客户最直观看的)
  const summary = buildDecisionSummary(detail);
  return (
    <>
      <DecisionBanner detail={detail} summary={summary} onReplay={onReplay} isReplaying={isReplaying} />
      <div
        className="border-b border-line bg-panel grid"
        style={{
          padding: "12px 18px",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: "8px 18px",
        }}
      >
      <Kv label="decision">
        <Badge variant={detail.decision === "PASS" ? "ok" : "err"}>
          {detail.decision}
        </Badge>
        {detail.llm_decision !== detail.decision ? (
          <span className="text-ink-3 mono text-[10.5px] ml-2">
            (llm: {detail.llm_decision})
          </span>
        ) : null}
      </Kv>
      <Kv label="client × bg × studio">
        <span className="mono text-[11.5px]">
          {detail.client_name || "—"}
          {detail.business_group ? ` × ${detail.business_group}` : ""}
          {detail.studio ? ` × ${detail.studio}` : ""}
        </span>
      </Kv>
      <Kv label="model · latency">
        <span className="mono text-[11.5px]">
          {detail.llm_model || "—"} · {detail.llm_duration_ms}ms
        </span>
      </Kv>
      <Kv label="tokens (in/out)">
        <span className="mono text-[11.5px]">
          {detail.llm_prompt_tokens ?? "—"} / {detail.llm_completion_tokens ?? "—"}
        </span>
      </Kv>
      <Kv label="candidate_id">
        <span className="mono text-[11px]">{detail.candidate_id || "—"}</span>
      </Kv>
      <Kv label="job_requisition_id">
        <span className="mono text-[11px]">{detail.job_requisition_id || "—"}</span>
      </Kv>
      <Kv label="rules_evaluated">
        <span
          className="mono text-[11.5px]"
          title={`ontology ${detail.rules_total_in_ontology} 条 → 经 client/business_group filter → LLM 应用 ${detail.rules_evaluated} 条 → 其中 ${detail.flags.filter((f) => f.applicable).length} 条 applicable=true、${detail.flags.filter((f) => !f.applicable).length} 条 applicable=false`}
        >
          ontology {detail.rules_total_in_ontology} → 评估 {detail.rules_evaluated}
          {" → "}applicable={detail.flags.filter((f) => f.applicable).length} · NOT_APPLICABLE={detail.flags.filter((f) => !f.applicable).length}
        </span>
        <Badge variant="default">{detail.rule_source}</Badge>
      </Kv>
      <Kv label="trace_id">
        <span className="mono text-[11px]">{detail.trace_id || "—"}</span>
      </Kv>
      {detail.failure_reasons.length > 0 ? (
        <div className="col-span-4 mt-2">
          <span className="hint">failure_reasons</span>
          <div
            className="mono text-[11.5px] text-err"
            style={{ marginTop: 2 }}
          >
            {detail.failure_reasons.join(", ")}
          </div>
        </div>
      ) : null}
      {detail.parse_error ? (
        <div className="col-span-4 mt-2">
          <span className="hint">parse_error</span>
          <div
            className="mono text-[11px] text-warn"
            style={{ marginTop: 2 }}
          >
            {detail.parse_error}
          </div>
        </div>
      ) : null}
      </div>
    </>
  );
}

// A5 — 决策摘要 banner
function DecisionBanner({
  detail,
  summary,
  onReplay,
  isReplaying,
}: {
  detail: RuleCheckAuditDetail;
  summary: string;
  onReplay: () => void;
  isReplaying: boolean;
}) {
  const pass = detail.decision === "PASS";
  const bgColor = pass
    ? "color-mix(in oklab, var(--c-ok) 12%, var(--c-bg))"
    : "color-mix(in oklab, var(--c-err) 12%, var(--c-bg))";
  const borderColor = pass ? "var(--c-ok)" : "var(--c-err)";
  return (
    <div
      className="border-b border-line flex items-center gap-4"
      style={{
        padding: "14px 22px",
        background: bgColor,
        borderLeft: `4px solid ${borderColor}`,
      }}
    >
      <div
        className="font-bold tracking-tight"
        style={{
          fontSize: 28,
          color: borderColor,
          minWidth: 90,
          lineHeight: 1,
        }}
      >
        {detail.decision}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-ink-1" style={{ lineHeight: 1.5 }}>
          {summary}
        </div>
        <div
          className="text-ink-3 mono text-[10.5px] mt-1 truncate"
          style={{ marginTop: 4 }}
        >
          {detail.candidate_id?.slice(0, 8)} · {detail.job_requisition_id?.split("-").pop() || "?"}
          {detail.client_name ? ` · ${detail.client_name}` : ""}
          {detail.business_group ? ` × ${detail.business_group}` : ""}
        </div>
      </div>
      <Btn size="sm" onClick={onReplay} disabled={isReplaying}>
        {isReplaying ? "重跑中…" : "🔁 Replay"}
      </Btn>
    </div>
  );
}

function buildDecisionSummary(detail: RuleCheckAuditDetail): string {
  if (detail.decision === "PASS") {
    return `所有底线规则放行(评估 ${detail.rules_evaluated}/${detail.rules_total_in_ontology} 条)。下一步:发 MATCH_RULE_CHECK_PASSED 事件 → matchResume 调 RoboHire /match-resume`;
  }
  // FAIL
  const reasons = detail.failure_reasons.length
    ? detail.failure_reasons.join("、")
    : "(LLM 解析失败)";
  return `底线规则触发 FAIL → 中止流程,跳过 matchResume。命中:${reasons}`;
}

function Kv({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="hint">{label}</div>
      <div className="text-ink-1 flex items-center gap-2 truncate" style={{ marginTop: 2 }}>
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
      className="text-[12.5px] border-0 bg-transparent cursor-pointer"
      style={{
        padding: "10px 0 9px",
        color: active ? "var(--c-ink-1)" : "var(--c-ink-3)",
        borderBottom: active
          ? "2px solid var(--c-accent)"
          : "2px solid transparent",
        fontWeight: active ? 600 : 400,
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
  const clientId = detail.client_name || '(未知)';
  const businessGroup = detail.business_group || '(未指定)';

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
            🔍 规则抓取链路证明 · 喂给 LLM 之前的 client/department filter
          </div>
          <div className="mono text-[12px] text-ink-1">
            ontology <b>{ontologyTotal}</b> 条
            {' → '} 跳过 <b>{filteredCount}</b> 条
            {' → '} 喂给 LLM <b>{evaluatedCount}</b> 条
            {' '}
            <span className="text-ink-3">
              (本 audit 维度:client_id=<span className="text-ink-1">{clientId}</span> · business_group=<span className="text-ink-1">{businessGroup}</span>)
            </span>
          </div>
        </div>
        <span className="mono text-[11px] text-ink-3">
          点击{open ? '收起' : '展开'} {filteredCount > 0 ? `(${filteredCount} 条跳过明细)` : ''}
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
                    ? `executor ≠ Agent (${rules.length} 条) — 这些规则由人工执行,不属于 rule-check LLM 范围`
                    : category === 'client'
                      ? `applicableClient 不匹配 (${rules.length} 条) — 这些规则只适用于其他客户`
                      : category === 'department'
                        ? `applicableDepartment 不匹配 (${rules.length} 条) — 这些规则只适用于其他部门 / business_group`
                        : `其他 (${rules.length} 条)`}
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
                          ontology 标注:applicableClient="{f.applicable_client}" · applicableDepartment="{f.applicable_department}" · executor="{f.executor}"
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
          (本 audit 没有任何规则被过滤掉 — ontology 全部 {ontologyTotal} 条都喂给了 LLM)
        </div>
      ) : null}
    </div>
  );
}

function PromptTab({ detail }: { detail: RuleCheckAuditDetail }) {
  if (!detail.user_prompt) {
    return (
      <EmptyState
        icon={<Ic.alert />}
        title="本条 audit 未保存 prompt"
        hint="本条 audit 在 lib/rule-check/runner.ts 增加 user_prompt 持久化前就写入了 Neo4j。新跑的 audit 会带 prompt。"
        variant="info"
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {/* User Prompt 之前先展示 — 哪些规则被 client/department filter 过滤掉了 + 原因 */}
      <FilteredOutRulesSection detail={detail} />
      <div>
        <div
          className="hint flex items-center"
          style={{ gap: 8, marginBottom: 6 }}
        >
          <span>System Prompt</span>
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
        <div
          className="hint flex items-center"
          style={{ gap: 8, marginBottom: 6 }}
        >
          <span>User Prompt (markdown, 喂给 LLM)</span>
          <span className="mono text-ink-3 text-[10.5px]">
            {detail.user_prompt.length} chars
          </span>
          <CopyBtn text={detail.user_prompt} />
        </div>
        <pre
          className="mono text-[11.5px] text-ink-1 bg-panel border border-line rounded-sm whitespace-pre-wrap"
          style={{ padding: "12px 14px" }}
        >
          {detail.user_prompt}
        </pre>
      </div>
    </div>
  );
}

function RulesTab({ detail }: { detail: RuleCheckAuditDetail }) {
  if (detail.flags.length === 0) {
    return (
      <>
        <CandidateProfileCard detail={detail} />
        <EmptyState
          title="无规则评估记录"
          hint="本条 audit 的 LLM 解析失败,没有任何 rule_flags 输出。"
          variant="info"
        />
      </>
    );
  }
  // 候选人 + JD 上下文 — 让每条 flag 的"对决策影响"文案能引用具体姓名/岗位,
  // 而不是冷冰冰的"无负面影响"。
  const ctx = deriveCandidateContext(detail);

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

  return (
    <div className="flex flex-col gap-3">
      <CandidateProfileCard detail={detail} />

      {/* 抓取链路证明 — 给用户看 51 条 ontology 规则全审视过 */}
      <RuleFetchProvenanceCard detail={detail} />

      {/* ① 已评估的规则(applicable=true)— LLM 实际跑了逻辑判定的 */}
      {orderedApplicable.length > 0 ? (
        <>
          <div className="hint" style={{ marginTop: 4, marginBottom: 2 }}>
            已评估规则({orderedApplicable.length} 条 · applicable=true)
          </div>
          {orderedApplicable.map((f) => (
            <InferenceChainCard
              key={f.flag_id}
              flag={f}
              auditId={detail.audit_id}
              ctx={ctx}
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

function deriveCandidateContext(detail: RuleCheckAuditDetail): CandidateContext {
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
    name: pickStr(r.name) || "(候选人)",
    jrTitle: pickStr(j.client_job_title) || "(本岗位)",
    failureRuleIds,
  };
}

/**
 * 抓取链路证明面板 — 显示规则是从哪来的(neo4j/api/json)+ 链路三段数:
 *   ontology N → 经 filter → LLM 评估 M → applicable=true K
 * 用户看到这个面板,就知道"规则 10-29 在 ontology 里,但本次 applicable=false"。
 */
function RuleFetchProvenanceCard({ detail }: { detail: RuleCheckAuditDetail }) {
  const applicableCount = detail.flags.filter((f) => f.applicable).length;
  const notApplicableCount = detail.flags.filter((f) => !f.applicable).length;
  const ontologyCount = detail.rules_total_in_ontology;
  const evaluatedCount = detail.rules_evaluated;
  const filteredOut = ontologyCount - evaluatedCount;

  const sourceTag =
    detail.rule_source === "neo4j-direct"
      ? "Neo4j 直连 — 实时跟 ontology 同步"
      : detail.rule_source === "ontology-api"
        ? "Allmeta Ontology HTTP API — partner 远程"
        : "JSON 静态副本 — 兜底,跟主仓 rules.json 一致";

  return (
    <div
      className="border border-line rounded-sm bg-panel"
      style={{ padding: "10px 14px" }}
    >
      <div className="hint" style={{ marginBottom: 6 }}>
        🔍 规则抓取链路 — 证明本次 audit 看过全部 {ontologyCount} 条 ontology 规则
      </div>
      <div
        className="grid items-center"
        style={{
          gridTemplateColumns: "auto 1fr auto 1fr auto 1fr auto",
          gap: "0 10px",
          fontSize: 12,
        }}
      >
        <span className="mono text-ink-1 font-semibold">{ontologyCount}</span>
        <span className="text-ink-3">ontology 规则总数</span>
        <span className="text-ink-3">→</span>
        <span className="mono text-ink-1 font-semibold">{evaluatedCount}</span>
        <span className="text-ink-3">经 client/business_group filter 后</span>
        <span className="text-ink-3">→</span>
        <span className="mono text-ink-1 font-semibold">{applicableCount}</span>
      </div>
      <div className="mono text-[11px] text-ink-3" style={{ marginTop: 6 }}>
        过滤掉 {filteredOut} 条(applicableClient / department 不匹配本 audit) · 评估的 {evaluatedCount} 条里 {applicableCount} 条 applicable=true、{notApplicableCount} 条 NOT_APPLICABLE
      </div>
      <div className="mono text-[11px] text-ink-3" style={{ marginTop: 4 }}>
        数据来源:<span className="text-ink-1">{detail.rule_source}</span> — {sourceTag}
      </div>
    </div>
  );
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
            {open ? "▾" : "▸"} 不适用规则({flags.length} 条 · applicable=false,LLM 评估了触发条件但不触发)
          </span>
          {recoveredCount > 0 ? (
            <div
              className="mono text-[10.5px] text-warn"
              style={{ marginTop: 2 }}
              title="这些条目早期 writer 把 applicable=false 过滤掉了,本次从 llm_raw_text 兜底回填"
            >
              ⓘ 其中 {recoveredCount} 条由 llm_raw_text 兜底回填(DB 漏写)
            </div>
          ) : null}
        </div>
        <span className="mono text-[11px] text-ink-3">点击{open ? "收起" : "展开"}</span>
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
                        title="DB 漏写,从 llm_raw_text 兜底回填"
                      >
                        raw fallback
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[11.5px] text-ink-2" style={{ marginTop: 2, lineHeight: 1.55 }}>
                    <span className="text-ink-3">LLM 判定:</span>
                    {f.evidence || "(LLM 未给 evidence — 触发条件未满足)"}
                  </div>
                  <div className="text-[11px] text-ink-3" style={{ marginTop: 2, lineHeight: 1.5 }}>
                    候选人 <span className="text-ink-1">{ctx.name}</span> 在岗位{" "}
                    <span className="text-ink-1">{ctx.jrTitle}</span>{" "}
                    上不触发此规则 → 跳过判定,不参与底线决策。
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
  const totalYears = exp.length > 0 ? `${exp.length} 段 (近 ${exp.slice(0, 3).map((e) => `${pickStr(e.company) || '?'}/${pickStr(e.role) || pickStr(e.title) || '?'}`).join(' / ')})` : null;

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
      {/* 候选人画像 */}
      <div>
        <div className="hint" style={{ marginBottom: 6 }}>
          👤 候选人画像
        </div>
        <div className="text-[13px] text-ink-1 font-semibold" style={{ marginBottom: 4 }}>
          {name || "(无姓名)"}
          {gender ? ` · ${gender}` : ""}
          {marital ? ` · ${marital}` : ""}
          {nationality ? ` · ${nationality}` : ""}
        </div>
        <div className="text-[11.5px] text-ink-2" style={{ lineHeight: 1.6 }}>
          {degree || school || major ? (
            <div>
              <span className="hint">学历:</span> {degree}
              {school ? ` · ${school}` : ""}
              {major ? ` · ${major}` : ""}
              {eduEnd ? ` · ${eduStart || "?"} → ${eduEnd}` : ""}
            </div>
          ) : null}
          {totalYears ? (
            <div>
              <span className="hint">经历:</span> {totalYears}
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
              <span className="hint">期望薪资:</span> {expectedSalary}
            </div>
          ) : null}
        </div>
      </div>

      {/* JR 画像 */}
      <div>
        <div className="hint" style={{ marginBottom: 6 }}>
          💼 岗位画像
        </div>
        <div className="text-[13px] text-ink-1 font-semibold" style={{ marginBottom: 4 }}>
          {jrTitle || "(无岗位名)"}
          {jrDept ? ` · ${jrDept}` : ""}
        </div>
        <div className="text-[11.5px] text-ink-2" style={{ lineHeight: 1.6 }}>
          {jrCity ? <div><span className="hint">城市:</span> {jrCity}</div> : null}
          {jrSalary ? <div><span className="hint">薪资范围:</span> {jrSalary}</div> : null}
          {jrDegreeReq ? <div><span className="hint">学历要求:</span> {jrDegreeReq}</div> : null}
          <div className="text-ink-3">
            client_id: {detail.client_name || "?"}{detail.business_group ? ` × ${detail.business_group}` : ""}
          </div>
        </div>
      </div>

      {/* 匹配冲突高亮(从 failure_reasons 提炼)*/}
      {detail.failure_reasons.length > 0 ? (
        <div style={{ gridColumn: "1 / -1", paddingTop: 4, borderTop: "1px solid var(--c-line)" }}>
          <div className="hint" style={{ marginBottom: 4 }}>
            ⚠ 命中底线规则(决定整体 FAIL):
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
function InferenceChainCard({
  flag,
  auditId,
  ctx,
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
}) {
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
            {flag.severity === "flag_only" ? "提示" : "底线"}
          </Badge>
        </span>
        <Badge variant={flag.result === "PASS" ? "ok" : flag.result === "FAIL" ? "err" : "default"}>
          {flag.result}
        </Badge>
        <Neo4jLinkBtn
          label="🔗"
          title="查这条规则的 ontology 节点 + 该候选人的 JR 关系"
          cypher={`MATCH (r:Rule {id: "${flag.rule_id}"})\nRETURN r`}
        />
      </div>

      {/* 候选人 + JD 上下文一行 — 提醒用户"这是 <name> 在 <jrTitle> 上的判定"  */}
      <div
        className="text-[11px] text-ink-3"
        style={{ padding: "6px 14px 0", lineHeight: 1.5 }}
      >
        候选人 <span className="text-ink-1">{ctx.name}</span> 在岗位{" "}
        <span className="text-ink-1">{ctx.jrTitle}</span> 上的判定
      </div>

      {/* 因果链:3 步(简化版,去掉冗余的"触发条件"步)*/}
      <div className="flex flex-col" style={{ padding: "10px 14px", gap: 6 }}>
        {flag.applicable ? (
          <>
            <ChainStep
              step="1"
              label="LLM evidence"
              ok={flag.result === "PASS"}
              warn={flag.result === "FAIL"}
              content={flag.evidence || "(LLM 未给 evidence)"}
            />
            <ChainStep
              step="2"
              label={isBottomLine ? "底线规则 · next_action" : "提示规则 · next_action"}
              ok={flag.next_action === "continue"}
              warn={flag.next_action === "block"}
              content={
                flag.next_action === "block"
                  ? "阻断:写入 failure_reasons → 跳过 matchResume"
                  : flag.next_action === "continue"
                    ? "继续:不进 failure_reasons"
                    : flag.next_action || "(未给)"
              }
            />
            <ChainStep
              step="3"
              label="对整体决策的影响"
              ok={!blocks}
              warn={blocks}
              content={impactSentence}
            />
          </>
        ) : (
          <ChainStep
            step="—"
            label="不适用"
            ok
            content={`本规则在 ${ctx.name} × ${ctx.jrTitle} 场景的触发条件不满足,无需评估`}
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
}): string {
  const { blocks, isFail, isBottomLine, isFailureCause, name, jrTitle, evidence } = args;
  const ev = summarizeEvidence(evidence);
  if (blocks) {
    // 阻断:底线 + FAIL,这条规则就是整体 FAIL 的原因
    const cause = isFailureCause ? "★ 命中 failure_reasons" : "★ 底线规则失败";
    return `${cause}:${name} 在 ${jrTitle} 上不满足底线 — ${ev}。触发整体 FAIL → emit MATCH_FAILED(含 rule_check_decision=FAIL),跳过 matchResume,不进 Robohire 打分。`;
  }
  if (isFail) {
    // flag_only FAIL — 仅 augmentation 标注
    return `提示规则失败:${name} 在 ${jrTitle} 上存在 ${ev},但 severity=flag_only,只在 resume_augmentation 用 ✗ 标注,不影响整体推进。`;
  }
  if (isBottomLine) {
    // 底线 + PASS
    return `底线规则放行:${name} 在 ${jrTitle} 上通过此条 — ${ev}。不进 failure_reasons,允许继续推进 matchResume。`;
  }
  // 提示 + PASS
  return `提示规则通过:${name} 在 ${jrTitle} 上无 ${ev || "异常"},augmentation 用 ✓ 标注。`;
}

/**
 * 把 LLM evidence 浓缩成一句"理由摘要",拼到 impact sentence 里:
 *   - 砍掉重复的"候选人 X..."前缀(impact sentence 已经写过姓名了)
 *   - 取头一句(到第一个句号 / 分号 / 换行)
 *   - 超长截到 80 字加 …
 */
function summarizeEvidence(evidence: string): string {
  if (!evidence) return "(LLM 未给 evidence)";
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
  return (
    <div className="flex flex-col gap-4">
      <CandidateProfileCard detail={detail} />
      {detail.resume_augmentation ? (
        <div>
          <div className="hint flex items-center" style={{ gap: 8, marginBottom: 6 }}>
            <span>Resume Augmentation (Kenny §3,注入 Robohire resume 顶部)</span>
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
          <span>LLM Raw Response</span>
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
          {detail.llm_raw_text ?? "(no raw text saved — audit 在 llm_raw_text 字段加入前写入)"}
        </pre>
      </div>
    </div>
  );
}

function InstancesTab({ detail }: { detail: RuleCheckAuditDetail }) {
  // 3 段:
  //   ① 经 Allmeta API 拿到的实时 Neo4j 数据(证明 Allmeta 路径通)
  //   ② full snapshot(LLM 决策时看到的 input,从 audit 当时存的 JSON 取)
  //   ③ Bolt 直接查的 anchor 精简版(老路径,验证用)
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
          <span>决策时完整 Input(LLM 实际看到的数据)</span>
        </div>
        {fullMissing ? (
          <div
            className="border border-line bg-panel rounded-sm text-[11.5px] text-ink-2"
            style={{ padding: "10px 14px", lineHeight: 1.6 }}
          >
            <span className="text-warn font-semibold">⚠ 这条 audit 没保存完整 input</span>
            {" — "}创建时间早于 Q1 改动(audit 节点新增 <code>parsed_resume_json</code> / <code>job_requisition_json</code> 字段)。
            <br />
            <span className="text-ink-3">
              改动后产生的 audit 会显示完整 JSON。需要的话可点上方
              <strong> 🔁 Replay </strong>
              重发同一份 input 产生新 audit。
            </span>
            <br />
            <span className="text-ink-3">
              下方 Neo4j Anchor 精简版仍可看(name / 公司 / 学历 / JD 关键字段)。
            </span>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <InstanceCard
              title="Parsed Resume(完整)"
              data={detail.parsed_resume_full}
              note="来自 RESUME_PROCESSED.parsed.data,Robohire 解析的全字段"
            />
            <InstanceCard
              title="Job Requisition(完整)"
              data={detail.job_requisition_full}
              note="来自 RAAS getRequirementsAgentView 单条 item"
            />
          </div>
        )}
      </div>
      <div>
        <div
          className="hint flex items-center"
          style={{ gap: 8, marginBottom: 8 }}
        >
          <span>Neo4j Anchor 节点(图查询友好的精简版)</span>
        </div>
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <InstanceCard
            title=":Candidate"
            data={detail.candidate_snapshot}
            note="snapshot 派生 flags + name/gender/birth_date(剔除 PII)"
          />
          <InstanceCard
            title=":Resume"
            data={detail.resume_snapshot}
            note="companies / skills(拍平)/ highest_degree 等"
          />
          <InstanceCard
            title=":JobRequisition"
            data={detail.jr_snapshot}
            note="must_have_skills / work_years / salary_range 等"
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
        <span>🛰️ Allmeta API 实时读 Neo4j(证明 AO ↔ Allmeta ↔ Neo4j 路径打通)</span>
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
              {Object.keys(data.instance).length} 字段
            </span>
            <CopyBtn text={JSON.stringify(data.instance, null, 2)} />
          </>
        ) : data ? (
          <Badge variant="err">{data.reason}</Badge>
        ) : null}
      </div>
      <div className="mono text-[10px] text-ink-3" style={{ marginBottom: 6 }}>
        pk: {pk?.slice(0, 36) || "(无)"}
      </div>

      {loading ? (
        <div className="text-ink-3 text-[11px]">查询中…</div>
      ) : !data ? (
        <div className="text-ink-3 text-[11px]">未关联</div>
      ) : data.ok ? (
        <>
          <pre
            className="mono text-[10.5px] text-ink-2 whitespace-pre-wrap"
            style={{ lineHeight: 1.5, maxHeight: 280, overflow: "auto" }}
          >
            {JSON.stringify(data.instance, null, 2)}
          </pre>
          <div
            className="mono text-[10px] text-ink-3"
            style={{
              marginTop: 6,
              padding: "6px 8px",
              background: "var(--c-bg)",
              borderRadius: 3,
            }}
          >
            <div className="text-ink-3 mb-1">📋 验证 Cypher(粘到 Neo4j Browser):</div>
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
              <div className="text-ink-3 mb-1">📋 直接查 Neo4j 验证:</div>
              <CypherSnippet cypher={data.verify.cypher} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

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
              {Object.keys(data).length} 字段
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
        <div className="text-ink-3 text-[11.5px]">未关联</div>
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

/**
 * A2 — 一键复制 Cypher 并跳转 Neo4j Browser
 *
 * Neo4j Browser 不直接接 URL query 参数运行 cypher,所以做法是:
 *   1. 把 cypher copy 到剪贴板
 *   2. 在新 tab 打开 Browser
 *   3. 用户粘贴(Cmd+V)即可
 * 短期方案,UX 不完美但比"无源可追"好。长期方案是写个 mini graph viewer。
 */
function Neo4jLinkBtn({
  label = "🔗 Neo4j",
  title,
  cypher,
}: {
  label?: string;
  title?: string;
  cypher: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const browserUrl =
    process.env.NEXT_PUBLIC_NEO4J_BROWSER_URL || "http://localhost:7475/browser/";
  return (
    <button
      title={title || "复制 Cypher + 跳 Neo4j Browser"}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(cypher);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
        window.open(browserUrl, "_blank", "noopener");
      }}
      className="mono text-[10.5px] border border-line bg-panel text-ink-2 rounded-sm cursor-pointer hover:bg-surface hover:text-ink-1"
      style={{ padding: "4px 8px" }}
    >
      {copied ? "✓ cypher 已复制,粘贴运行" : label}
    </button>
  );
}

function CopyBtn({ text }: { text: string }) {
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
      {copied ? "✓ 已复制" : "复制"}
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
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<OntologyRuleResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // 懒加载:第一次展开才 fetch,后续 toggle 用 cache。
  React.useEffect(() => {
    if (!open || data || loading) return;
    setLoading(true);
    setErr(null);
    fetchJson<OntologyRuleResponse>(
      `/api/ontology/rules/${encodeURIComponent(ruleId)}`,
    )
      .then(setData)
      .catch((e) => setErr((e as Error)?.message || "加载失败"))
      .finally(() => setLoading(false));
  }, [open, ruleId, data, loading]);

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
          {open ? "▾" : "▸"} 查看原规则定义(Allmeta Ontology API)
        </span>
        <span className="mono text-[10.5px] text-ink-3">
          {open ? "收起" : "展开"}
        </span>
      </button>
      {open ? (
        <div style={{ padding: "0 14px 12px" }}>
          {loading ? (
            <div className="mono text-[11px] text-ink-3">加载中…</div>
          ) : err ? (
            <div className="mono text-[11px] text-err">加载失败:{err}</div>
          ) : !data ? null : !data.ok ? (
            <div className="mono text-[11px] text-warn">
              {data.reason === "not_found"
                ? `ontology 里找不到 rule_id="${ruleId}" (数据漂移?)`
                : `读取出错:${data.error ?? "(无 message)"}`}
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
              ? "Allmeta Ontology HTTP API — GET /api/v1/ontology/rules/{ruleId}?domain=RAAS-v1"
              : "API 不可达 / 配置缺失,降级读 lib/rule-check/rules.json"
          }
        >
          数据来源:{source}
        </span>
      </div>
      <div className="text-[12.5px] text-ink-1 font-semibold">
        {rule.businessLogicRuleName || "(规则无 businessLogicRuleName)"}
      </div>
      <RuleField label="触发条件 (submissionCriteria)" value={rule.submissionCriteria} />
      <RuleField
        label="判定逻辑 (standardizedLogicRule)"
        value={rule.standardizedLogicRule}
        mono
      />
      {rule.businessBackgroundReason ? (
        <RuleField
          label="业务背景 (businessBackgroundReason)"
          value={rule.businessBackgroundReason}
        />
      ) : null}
      {rule.specificScenarioStage ? (
        <RuleField
          label="场景阶段 (specificScenarioStage)"
          value={rule.specificScenarioStage}
        />
      ) : null}
      {rule.ruleSource ? (
        <RuleField label="规则来源 (ruleSource)" value={rule.ruleSource} />
      ) : null}
      {rule.relatedEntities && rule.relatedEntities.length > 0 ? (
        <RuleField
          label="关联实体 (relatedEntities)"
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
