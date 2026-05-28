"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { AuditResponse, AuditLogRow } from "@/app/api/audit/route";
import type { RunAuditResponse, RunAuditSummary } from "@/app/api/audit/runs/route";
import { describeLogKind } from "@/lib/monitor-step-descriptor";

type Tab = "runs" | "events" | "ops";

export function AuditContent() {
  const { t } = useApp();
  const [tab, setTab] = React.useState<Tab>("runs");

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        className="border-b border-line bg-surface flex items-center"
        style={{ padding: "14px 22px", gap: 18 }}
      >
        <div>
          <div className="text-[15px] font-semibold tracking-tight">{t("adx_title")}</div>
          <div className="text-ink-3 text-[12px] mt-px">
            {t("adx_subtitle")}
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1 bg-panel rounded-md p-0.5 border border-line">
          <TabButton active={tab === "runs"} onClick={() => setTab("runs")}>
            {t("adx_tab_runs")}
          </TabButton>
          <TabButton active={tab === "events"} onClick={() => setTab("events")}>
            {t("adx_tab_events")}
          </TabButton>
          <TabButton active={tab === "ops"} onClick={() => setTab("ops")}>
            {t("adx_tab_ops")}
          </TabButton>
        </div>
      </div>
      {tab === "runs" ? <RunAuditTab /> : tab === "events" ? <EventAuditTab /> : <OpsAuditTab />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Tab 3 — 操作审计(运维写操作:取消/暂停/恢复/重放/批量/改配置)
// ════════════════════════════════════════════════════════════════════════

function OpsAuditTab() {
  const { t } = useApp();
  const [data, setData] = React.useState<AuditResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    // source=manage-api → 只看 AO 运维写操作(writeManageAudit 写的行)
    fetchJson<AuditResponse>(`/api/audit?source=manage-api&limit=200`)
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-line bg-surface/60 flex items-center" style={{ padding: "10px 22px", gap: 14 }}>
        <span className="text-ink-3 text-[11.5px]">
          {t("adx_ops_bar")}
          {data ? ` · ${data.total} ${t("adx_unit_rows")}` : ""}
        </span>
      </div>
      <div className="flex-1 overflow-auto" style={{ padding: "16px 22px" }}>
        {loading && !data ? (
          <EmptyState title={t("adx_loading")} hint="" />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={<Ic.book />}
            title={t("adx_ops_empty_title")}
            hint={t("adx_ops_empty_hint")}
            variant="info"
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {data.rows.map((r) => (
              <OpsAuditRow key={r.id} row={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const OPS_ACTION_LABEL_KEY: Record<string, string> = {
  "manage.run.cancel": "adx_ops_act_run_cancel",
  "manage.run.pause": "adx_ops_act_run_pause",
  "manage.run.resume": "adx_ops_act_run_resume",
  "manage.run.restart": "adx_ops_act_run_restart",
  "manage.run.replay": "adx_ops_act_run_replay",
  "manage.event.replay": "adx_ops_act_event_replay",
  "manage.runs.batch": "adx_ops_act_runs_batch",
  "manage.agent.config": "adx_ops_act_agent_config",
  "manage.agent.throttle": "adx_ops_act_agent_throttle",
  "manage.agent.enable": "adx_ops_act_agent_enable",
  "manage.agent.disable": "adx_ops_act_agent_disable",
};

function OpsAuditRow({ row }: { row: AuditLogRow }) {
  const { t: tr } = useApp();
  const [open, setOpen] = React.useState(false);
  const t = new Date(row.createdAt);
  const time = `${t.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} ${t.toLocaleTimeString(undefined, { hour12: false })}`;
  const labelKey = OPS_ACTION_LABEL_KEY[row.eventName];
  const label = labelKey ? tr(labelKey) : row.eventName;
  let parsed: { actor?: string; reason?: string; before?: unknown; after?: unknown } = {};
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    /* keep empty */
  }
  let prettyPayload = row.payload ?? "";
  try {
    prettyPayload = JSON.stringify(JSON.parse(row.payload), null, 2);
  } catch {
    /* keep raw */
  }
  return (
    <div className="border border-line rounded-sm bg-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left hover:bg-panel/50"
      >
        <span className={`text-[9px] text-ink-4 transition-transform ${open ? "rotate-90 inline-block" : ""}`}>▶</span>
        <span className="mono text-[11px] text-ink-3 tabular-nums shrink-0">{time}</span>
        <span className="text-[11.5px] text-ink-1 font-medium shrink-0">{label}</span>
        {parsed.actor && <span className="mono text-[10.5px] text-ink-3 shrink-0">{tr("adx_ops_actor")} {parsed.actor}</span>}
        {row.traceId && row.traceId !== "—" && (
          <span className="mono text-[10.5px] text-ink-4 shrink-0">{tr("adx_ops_target")} {row.traceId.slice(0, 18)}…</span>
        )}
        <span className="flex-1" />
        {parsed.reason && <span className="text-[10.5px] text-ink-3 truncate max-w-[200px]">{parsed.reason}</span>}
      </button>
      {open && (
        <pre
          className="mono text-[10.5px] text-ink-1 whitespace-pre-wrap break-words border-t border-line bg-bg"
          style={{ margin: 0, padding: "8px 10px", maxHeight: 400, overflow: "auto", lineHeight: 1.55 }}
        >
          {prettyPayload || tr("adx_no_payload")}
        </pre>
      )}
    </div>
  );
}

function TabButton({
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
      className={`text-[12px] px-3 py-1 rounded-sm transition-colors ${
        active ? "bg-surface text-ink-1 font-medium shadow-sm" : "text-ink-3 hover:text-ink-1"
      }`}
    >
      {children}
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Tab 1 — 运行完整日志审计(每次运行 = 一行,展开看全量 in/out)
// ════════════════════════════════════════════════════════════════════════

function RunAuditTab() {
  const { t } = useApp();
  const [data, setData] = React.useState<RunAuditResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [agent, setAgent] = React.useState("");
  const [candidateId, setCandidateId] = React.useState("");
  const [runId, setRunId] = React.useState("");

  const load = React.useCallback(() => {
    setLoading(true);
    const sp = new URLSearchParams();
    if (agent) sp.set("agent", agent);
    if (candidateId) sp.set("candidate_id", candidateId);
    if (runId) sp.set("run_id", runId);
    sp.set("days", "7");
    fetchJson<RunAuditResponse>(`/api/audit/runs?${sp.toString()}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [agent, candidateId, runId]);

  React.useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        className="border-b border-line bg-surface/60 flex items-center"
        style={{ padding: "10px 22px", gap: 14 }}
      >
        <FilterInput label={t("adx_filter_agent")} value={agent} onChange={setAgent} placeholder="interviewInviter | resumeParser | ruleCheck" width={240} />
        <FilterInput label={t("adx_filter_candidate")} value={candidateId} onChange={setCandidateId} placeholder="candidate_id" width={220} />
        <FilterInput label="run_id" value={runId} onChange={setRunId} placeholder="01K..." width={180} />
        <div className="flex-1" />
        <Btn size="sm" onClick={load} disabled={loading}>
          {t("adx_refresh")}
        </Btn>
        {data && (
          <span className="text-ink-4 text-[11px] mono">
            {data.total} {t("adx_runs_scanned").replace("{files}", String(data.scanned_files))}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto" style={{ padding: "16px 22px" }}>
        {loading && !data ? (
          <EmptyState title={t("adx_loading")} hint="" />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={<Ic.book />}
            title={t("adx_runs_empty_title")}
            hint={t("adx_runs_empty_hint")}
            variant="info"
          />
        ) : (
          <div className="flex flex-col gap-2">
            {data.rows.map((r) => (
              <RunAuditCard key={r.run_id} run={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type AgentLogEvent = {
  ts: string;
  agent: string;
  run_id: string;
  kind: string;
  anchors?: Record<string, unknown>;
  payload?: unknown;
};

function RunAuditCard({ run }: { run: RunAuditSummary }) {
  const { t } = useApp();
  const [expanded, setExpanded] = React.useState(false);
  const [events, setEvents] = React.useState<AgentLogEvent[] | null>(null);
  const [loadingEvents, setLoadingEvents] = React.useState(false);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && events == null && !loadingEvents) {
      setLoadingEvents(true);
      fetchJson<{ events: AgentLogEvent[] }>(`/api/inngest-admin/runs/${run.run_id}/agent-log`)
        .then((b) => setEvents(b.events ?? []))
        .catch(() => setEvents([]))
        .finally(() => setLoadingEvents(false));
    }
  };

  const dur = new Date(run.ended_at).getTime() - new Date(run.started_at).getTime();
  const startLocal = new Date(run.started_at).toLocaleString(undefined, { hour12: false });

  return (
    <div className="border border-line rounded bg-surface overflow-hidden">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-panel/50"
      >
        <span
          className={`text-[10px] text-ink-4 transition-transform ${expanded ? "rotate-90 inline-block" : ""}`}
        >
          ▶
        </span>
        <Badge variant={run.has_error ? "warn" : "default"}>{run.agent}</Badge>
        {run.has_error && <span className="text-err text-[10.5px] shrink-0">{t("adx_has_failed_step")}</span>}
        <span className="text-ink-2 text-[12px] truncate min-w-0">
          {run.event_name ?? "—"}
        </span>
        {run.anchors.candidate_id && (
          <span className="mono text-[10.5px] text-ink-3 shrink-0" title={t("adx_candidate_id")}>
            {t("adx_candidate")} {run.anchors.candidate_id.slice(0, 12)}…
          </span>
        )}
        <span className="flex-1" />
        <span className="mono text-[10.5px] text-ink-4">{run.event_count} {t("adx_unit_steps")}</span>
        <span className="mono text-[10.5px] text-ink-4 tabular-nums">{Math.round(dur)}ms</span>
        <span className="mono text-[10.5px] text-ink-3 tabular-nums">{startLocal}</span>
      </button>
      <div className="px-3 pb-1 flex items-center gap-1.5 flex-wrap" style={{ paddingLeft: 38 }}>
        <span className="mono text-[10px] text-ink-4">run {run.run_id.slice(0, 18)}…</span>
        {run.kinds.slice(0, 8).map((k) => (
          <span key={k} className="text-[9.5px] mono text-ink-4 bg-panel px-1 py-px rounded-sm">
            {RUN_KIND_LABEL_KEY[k] ? t(RUN_KIND_LABEL_KEY[k]) : describeLogKind(k)}
          </span>
        ))}
      </div>

      {expanded && (
        <div className="border-t border-line bg-panel/30 p-2">
          {loadingEvents ? (
            <div className="text-ink-4 text-[11px] italic px-2 py-3">{t("adx_loading_full_log")}</div>
          ) : !events || events.length === 0 ? (
            <div className="text-ink-4 text-[11px] italic px-2 py-3">
              {t("adx_no_file_log")}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {events.map((e, i) => (
                <LogEventRow key={`${e.ts}-${i}`} event={e} index={i + 1} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LogEventRow({ event, index }: { event: AgentLogEvent; index: number }) {
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const from = typeof p.from === "string" ? p.from : null;
  const to = typeof p.to === "string" ? p.to : null;
  // 已知 kind 走 i18n;未知(api.RoboHire.* / rule-fetch.* 等)走 describeLogKind
  // 前缀兜底,避免显示裸 kind 名。
  const label = RUN_KIND_LABEL_KEY[event.kind] ? t(RUN_KIND_LABEL_KEY[event.kind]) : describeLogKind(event.kind);
  const hasPayload = event.payload != null;

  return (
    <div className="border border-line rounded-sm bg-surface">
      <button
        onClick={() => hasPayload && setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-panel/50"
        style={{ cursor: hasPayload ? "pointer" : "default" }}
      >
        {hasPayload && (
          <span className={`text-[9px] text-ink-4 transition-transform ${open ? "rotate-90 inline-block" : ""}`}>▶</span>
        )}
        <span className="mono text-[10.5px] text-ink-4 tabular-nums shrink-0">{index}</span>
        <span className="text-[11.5px] text-ink-1 font-medium truncate">{label}</span>
        {(from || to) && (
          <span className="mono text-[10px] text-accent bg-accent-bg/40 px-1 py-px rounded-sm shrink-0">
            {from ?? "?"} → {to ?? "?"}
          </span>
        )}
        <span className="flex-1" />
        <span className="mono text-[10px] text-ink-4 tabular-nums shrink-0">{event.ts.slice(11, 23)}</span>
      </button>
      {open && hasPayload && (
        <pre
          className="mono text-[10.5px] text-ink-1 whitespace-pre-wrap break-words border-t border-line bg-bg"
          style={{ margin: 0, padding: "8px 10px", maxHeight: 400, overflow: "auto", lineHeight: 1.55 }}
        >
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

const RUN_KIND_LABEL_KEY: Record<string, string> = {
  "handler.start": "adx_kind_handler_start",
  "handler.raw_input": "adx_kind_handler_raw_input",
  "handler.done": "adx_kind_handler_done",
  "backfill.resume.ok": "adx_kind_backfill_resume",
  "backfill.jd.ok": "adx_kind_backfill_jd",
  "emit.invitation-sent": "adx_kind_emit_invite_sent",
  "emit.invitation-failed": "adx_kind_emit_invite_failed",
  "emit.resume-processed": "adx_kind_emit_resume_processed",
  "save-candidate.ok": "adx_kind_save_candidate_ok",
  "save-candidate.failed": "adx_kind_save_candidate_failed",
  "step.start": "adx_kind_step_start",
  "step.end": "adx_kind_step_end",
  "diag.invite-input.preview": "adx_kind_diag_invite_preview",
  "llm.request": "adx_kind_llm_request",
  "llm.response": "adx_kind_llm_response",
  "llm.failed": "adx_kind_llm_failed",
  "runRuleCheck.start": "adx_kind_rulecheck_start",
  "rule-fetch.failed": "adx_kind_rule_fetch_failed",
};

// ════════════════════════════════════════════════════════════════════════
// Tab 2 — 事件发布审计(em.publish WORM)
// ════════════════════════════════════════════════════════════════════════

function EventAuditTab() {
  const { t } = useApp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const eventName = searchParams.get("eventName") ?? "";
  const traceId = searchParams.get("traceId") ?? "";
  const source = searchParams.get("source") ?? "";

  const [data, setData] = React.useState<AuditResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    const sp = new URLSearchParams();
    if (eventName) sp.set("eventName", eventName);
    if (traceId) sp.set("traceId", traceId);
    if (source) sp.set("source", source);
    const qs = sp.toString();
    fetchJson<AuditResponse>(`/api/audit${qs ? "?" + qs : ""}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [eventName, traceId, source]);

  const setFilter = (k: "eventName" | "traceId" | "source", v: string) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (v) sp.set(k, v);
    else sp.delete(k);
    router.replace(`/audit?${sp.toString()}`);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-line bg-surface/60 flex items-center" style={{ padding: "10px 22px", gap: 14 }}>
        <span className="text-ink-3 text-[11.5px]">
          {t("adx_event_bar")}{data ? ` · ${data.total.toLocaleString()} ${t("adx_unit_rows")}` : ""}
        </span>
        <div className="flex-1" />
        <FilterInput label={t("adx_filter_event_name")} value={eventName} onChange={(v) => setFilter("eventName", v)} placeholder="EVENT_NAME" width={180} />
        <FilterInput label="trace_id" value={traceId} onChange={(v) => setFilter("traceId", v)} placeholder="trace-..." width={180} />
        <FilterInput label={t("adx_filter_source")} value={source} onChange={(v) => setFilter("source", v)} placeholder="ws | em | external" width={140} />
      </div>
      <div className="flex-1 overflow-auto" style={{ padding: "16px 22px" }}>
        {loading && !data ? (
          <EmptyState title={t("adx_loading")} hint="" />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={<Ic.book />}
            title={data?.meta.empty ? t("adx_event_empty_title") : t("adx_no_match")}
            hint={
              data?.meta.empty
                ? t("adx_event_empty_hint")
                : t("adx_try_clear_filter")
            }
            variant={data?.meta.empty ? "info" : "default"}
            action={
              !data?.meta.empty ? (
                <Btn size="sm" onClick={() => router.replace("/audit")}>
                  {t("adx_clear_filter")}
                </Btn>
              ) : undefined
            }
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {data.rows.map((r) => (
              <EventAuditRow key={r.id} row={r} onCopy={(v) => navigator.clipboard?.writeText(v)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
  width = 180,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  width?: number;
}) {
  return (
    <label className="flex flex-col gap-px">
      <span className="hint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 border border-line bg-panel rounded-sm mono text-[11.5px] text-ink-1 outline-none"
        style={{ padding: "0 8px", width }}
      />
    </label>
  );
}

function EventAuditRow({ row, onCopy }: { row: AuditLogRow; onCopy: (v: string) => void }) {
  const { t: tr } = useApp();
  const [open, setOpen] = React.useState(false);
  const t = new Date(row.createdAt);
  const time = `${t.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} ${t.toLocaleTimeString(undefined, { hour12: false })}`;
  const sourceVariant: "info" | "warn" | "default" =
    row.source === "ws" ? "info" : row.source === "em" ? "default" : "warn";
  // 完整 payload 美化(展开看全量审计内容)
  let prettyPayload = row.payload ?? "";
  try {
    prettyPayload = JSON.stringify(JSON.parse(row.payload), null, 2);
  } catch {
    /* 保持原样 */
  }
  return (
    <div className="border border-line rounded-sm bg-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left hover:bg-panel/50"
      >
        <span className={`text-[9px] text-ink-4 transition-transform ${open ? "rotate-90 inline-block" : ""}`}>▶</span>
        <span className="mono text-[11px] text-ink-3 tabular-nums shrink-0">{time}</span>
        <span className="mono text-[11.5px] text-ink-1 truncate min-w-0">{row.eventName}</span>
        <Badge variant={sourceVariant}>{row.source}</Badge>
        <span className="flex-1" />
        <span
          onClick={(e) => { e.stopPropagation(); onCopy(row.traceId); }}
          className="mono text-[10.5px] text-ink-4 hover:text-ink-2 shrink-0"
          title={tr("adx_copy_trace")}
        >
          {row.traceId === "—" || !row.traceId ? "" : `trace ${row.traceId.slice(0, 16)}…`}
        </span>
      </button>
      {open && (
        <pre
          className="mono text-[10.5px] text-ink-1 whitespace-pre-wrap break-words border-t border-line bg-bg"
          style={{ margin: 0, padding: "8px 10px", maxHeight: 400, overflow: "auto", lineHeight: 1.55 }}
        >
          {prettyPayload || tr("adx_no_payload")}
        </pre>
      )}
    </div>
  );
}
