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

type Tab = "runs" | "events" | "ops" | "log" | "terminal";

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
          <TabButton active={tab === "log"} onClick={() => setTab("log")}>
            {t("adx_tab_log")}
          </TabButton>
          <TabButton active={tab === "terminal"} onClick={() => setTab("terminal")}>
            {t("adx_tab_terminal")}
          </TabButton>
        </div>
      </div>
      {tab === "runs" ? (
        <RunAuditTab />
      ) : tab === "events" ? (
        <EventAuditTab />
      ) : tab === "ops" ? (
        <OpsAuditTab />
      ) : tab === "log" ? (
        <LogEventTab />
      ) : (
        <TerminalLogTab />
      )}
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

// ════════════════════════════════════════════════════════════════════════
// Tab 4 — 运行日志 (unified audit log; reads LogEvent via /api/log-events).
// Everything every agent does (lifecycle / tool / event / error), queryable by
// level / agent / run / text — the 审计日志全可查 surface.
// ════════════════════════════════════════════════════════════════════════

type LogEventRow = {
  id: string;
  ts: string;
  level: string;
  category: string;
  source: string;
  agent: string | null;
  runId: string | null;
  traceId: string | null;
  eventName: string | null;
  message: string;
  durationMs: number | null;
  payloadPreview: string | null;
};
type LogEventsResponse = { logs: LogEventRow[]; nextCursor: string | null };

const LOG_LEVELS = ["error", "warn", "notice", "info"];
const LEVEL_INK: Record<string, string> = {
  critical: "var(--c-err)",
  error: "var(--c-err)",
  warn: "oklch(0.62 0.15 70)",
  notice: "var(--c-accent)",
  info: "var(--c-ink-3)",
};

function LogEventTab() {
  const { t } = useApp();
  const [data, setData] = React.useState<LogEventsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [level, setLevel] = React.useState<string>("");
  const [agent, setAgent] = React.useState("");
  const [runId, setRunId] = React.useState("");
  const [q, setQ] = React.useState("");

  const load = React.useCallback(async () => {
    const qs = new URLSearchParams();
    if (level) qs.set("level", level);
    if (agent.trim()) qs.set("agent", agent.trim());
    if (runId.trim()) qs.set("runId", runId.trim());
    if (q.trim()) qs.set("q", q.trim());
    qs.set("limit", "200");
    try {
      setData(await fetchJson<LogEventsResponse>(`/api/log-events?${qs.toString()}`));
    } catch {
      setData({ logs: [], nextCursor: null });
    } finally {
      setLoading(false);
    }
  }, [level, agent, runId, q]);

  React.useEffect(() => {
    setLoading(true);
    const id = setTimeout(load, 250); // debounce text inputs
    return () => clearTimeout(id);
  }, [load]);

  const rows = data?.logs ?? [];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 flex-wrap border-b border-line bg-panel" style={{ padding: "10px 22px" }}>
        <div className="flex items-center gap-1 bg-surface rounded-md p-0.5 border border-line">
          <FilterPill active={level === ""} onClick={() => setLevel("")}>{t("adx_log_all_levels")}</FilterPill>
          {LOG_LEVELS.map((lv) => (
            <FilterPill key={lv} active={level === lv} onClick={() => setLevel(lv)}>
              <span style={{ color: LEVEL_INK[lv] }}>●</span> {lv}
            </FilterPill>
          ))}
        </div>
        <input
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          placeholder="agent"
          className="text-[12px] px-2 py-1 rounded-md border border-line bg-surface text-ink-1 w-[120px]"
        />
        <input
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
          placeholder="run id"
          className="text-[12px] px-2 py-1 rounded-md border border-line bg-surface text-ink-1 w-[160px] mono"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("adx_log_search")}
          className="text-[12px] px-2 py-1 rounded-md border border-line bg-surface text-ink-1 flex-1 min-w-[160px]"
        />
        <span className="text-[11px] text-ink-3">{rows.length}</span>
      </div>

      <div className="flex-1 overflow-auto" style={{ padding: "8px 16px" }}>
        {loading && !data ? (
          <div className="text-ink-3 text-[12px] py-12 text-center">…</div>
        ) : rows.length === 0 ? (
          <EmptyState icon="book" title={t("adx_log_empty")} />
        ) : (
          <div className="flex flex-col">
            {rows.map((r) => (
              <LogEventRowView key={r.id} row={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11.5px] px-2 py-1 rounded ${active ? "bg-accent-bg text-accent font-medium" : "text-ink-3 hover:text-ink-1"}`}
    >
      {children}
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Tab 5 — 实时终端 (live tail over LogEvent via /api/log-events order=asc).
// 终端视觉:固定深色(不随主题翻转)、mono、ANSI 式 level 配色。每 2s 增量拉取
// (since=lastTs inclusive + id 去重),滚到底自动跟随,上滚即暂停跟随。
// ════════════════════════════════════════════════════════════════════════

const TERM_BG = "oklch(0.17 0.012 260)";
const TERM_INK: Record<string, string> = {
  critical: "oklch(0.72 0.19 25)",
  error: "oklch(0.72 0.19 25)",
  warn: "oklch(0.82 0.14 85)",
  notice: "oklch(0.8 0.1 200)",
  info: "oklch(0.78 0.01 260)",
  debug: "oklch(0.55 0.01 260)",
};
const TERM_DIM = "oklch(0.55 0.015 260)";
const TERM_AGENT = "oklch(0.75 0.11 320)";
const TERM_MAX_LINES = 2000;

function TerminalLogTab() {
  const { t } = useApp();
  const [lines, setLines] = React.useState<LogEventRow[]>([]);
  const [paused, setPaused] = React.useState(false);
  const [follow, setFollow] = React.useState(true);
  const [level, setLevel] = React.useState("");
  const [agentInput, setAgentInput] = React.useState("");
  const [agent, setAgent] = React.useState("");
  const lastTsRef = React.useRef<string | null>(null);
  // id → ts。since 是含端点的,只有 ts === lastTs 的行需要去重;每轮把 Map
  // 修剪到这个边界,持续 tail 几小时也不会无界涨内存。独立于 lines 缓冲,
  // 所以"清屏"不影响去重正确性。
  const seenRef = React.useRef<Map<string, string>>(new Map());
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const followRef = React.useRef(true);
  followRef.current = follow;

  // agent 是精确匹配,逐键清屏重拉太抖 — 250ms 防抖(与 tab4 同款)。
  React.useEffect(() => {
    const id = setTimeout(() => setAgent(agentInput.trim()), 250);
    return () => clearTimeout(id);
  }, [agentInput]);

  // 过滤条件变了 → 重置缓冲重新拉。
  React.useEffect(() => {
    setLines([]);
    lastTsRef.current = null;
    seenRef.current = new Map();
  }, [level, agent]);

  React.useEffect(() => {
    if (paused) return;
    let stopped = false;
    const pull = async () => {
      try {
        const qs = new URLSearchParams();
        if (level) qs.set("level", level);
        if (agent) qs.set("agent", agent);
        qs.set("payload", "full"); // 展开视图要 pretty-print 完整 JSON
        let fresh: LogEventRow[];
        if (!lastTsRef.current) {
          // 首屏:最近 200 行(desc 取回后翻转成时间正序)。
          qs.set("limit", "200");
          const r = await fetchJson<LogEventsResponse>(`/api/log-events?${qs.toString()}`);
          fresh = [...r.logs].reverse();
        } else {
          // 增量:since 含端点,靠 id 去重防同毫秒漏行/重行。
          qs.set("order", "asc");
          qs.set("limit", "500");
          qs.set("since", lastTsRef.current);
          const r = await fetchJson<LogEventsResponse>(`/api/log-events?${qs.toString()}`);
          fresh = r.logs;
        }
        if (stopped) return;
        // 同一次外部调用会落两行:'api' lane(完整归属)+ 'tool' lane(file
        // logger 镜像,message 形如 api.RoboHire.parseResume)。终端只留 'api'
        // 那行,免得每次调用刷两行;tab4 运行日志仍能看到全部。
        const add = fresh.filter(
          (l) => !seenRef.current.has(l.id) && !(l.category === "tool" && l.message.startsWith("api.")),
        );
        if (add.length === 0) return;
        for (const l of add) seenRef.current.set(l.id, l.ts);
        lastTsRef.current = add[add.length - 1].ts;
        // 修剪去重 Map:ts < 边界的行服务端不会再返回(since=gte 边界),删掉。
        const boundary = lastTsRef.current;
        for (const [id, ts] of seenRef.current) {
          if (ts !== boundary) seenRef.current.delete(id);
        }
        setLines((prev) => {
          const next = [...prev, ...add];
          return next.length <= TERM_MAX_LINES ? next : next.slice(next.length - TERM_MAX_LINES);
        });
      } catch {
        /* 网络抖动忽略,下一轮再试 */
      }
    };
    pull();
    const id = setInterval(pull, 2000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [paused, level, agent]);

  // 跟随:新行进来时滚到底;用户上滚(离底 >40px)自动停跟随,回底恢复。
  React.useEffect(() => {
    const box = boxRef.current;
    if (box && followRef.current) box.scrollTop = box.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (atBottom !== followRef.current) setFollow(atBottom);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 flex-wrap border-b border-line bg-panel" style={{ padding: "10px 22px" }}>
        <div className="flex items-center gap-1 bg-surface rounded-md p-0.5 border border-line">
          <FilterPill active={level === ""} onClick={() => setLevel("")}>{t("adx_log_all_levels")}</FilterPill>
          {LOG_LEVELS.map((lv) => (
            <FilterPill key={lv} active={level === lv} onClick={() => setLevel(lv)}>
              <span style={{ color: LEVEL_INK[lv] }}>●</span> {lv}
            </FilterPill>
          ))}
        </div>
        <input
          value={agentInput}
          onChange={(e) => setAgentInput(e.target.value)}
          placeholder="agent"
          className="text-[12px] px-2 py-1 rounded-md border border-line bg-surface text-ink-1 w-[120px]"
        />
        <span className="flex-1" />
        <Badge variant={paused ? "warn" : "ok"} dot pulse={!paused}>
          {paused ? t("adx_term_pause") : t("adx_term_conn")}
        </Badge>
        <span className="text-[11px] text-ink-3 mono">{t("adx_term_lines").replace("{n}", String(lines.length))}</span>
        <Btn size="sm" onClick={() => setPaused((p) => !p)}>
          {paused ? t("adx_term_resume") : t("adx_term_pause")}
        </Btn>
        {/* 清屏只清显示缓冲;去重 Map 保留,否则 since 含端点会让边界行立刻重现 */}
        <Btn size="sm" onClick={() => setLines([])}>
          {t("adx_term_clear")}
        </Btn>
      </div>

      <div
        ref={boxRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto mono"
        style={{ background: TERM_BG, padding: "10px 14px", fontSize: 11.5, lineHeight: 1.65 }}
      >
        {lines.length === 0 ? (
          <div style={{ color: TERM_DIM }}>{t("adx_term_empty")}</div>
        ) : (
          lines.map((l) => <TerminalLine key={l.id} row={l} />)
        )}
        {/* 跟随状态提示:不跟随时浮出"回到底部" */}
        {!follow && lines.length > 0 && (
          <button
            onClick={() => {
              const box = boxRef.current;
              if (box) box.scrollTop = box.scrollHeight;
              setFollow(true);
            }}
            className="fixed bottom-8 right-10 text-[11px] px-2.5 py-1.5 rounded-md border"
            style={{ background: TERM_BG, color: TERM_INK.info, borderColor: TERM_DIM }}
          >
            ↓ {t("adx_term_follow")}
          </button>
        )}
      </div>
    </div>
  );
}

function TerminalLine({ row }: { row: LogEventRow }) {
  const [open, setOpen] = React.useState(false);
  const d = new Date(row.ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  const ink = TERM_INK[row.level] ?? TERM_INK.info;
  let payloadPretty: string | null = null;
  if (open && row.payloadPreview) {
    try {
      payloadPretty = JSON.stringify(JSON.parse(row.payloadPreview), null, 2);
    } catch {
      payloadPretty = row.payloadPreview;
    }
  }
  return (
    <div
      onClick={() => row.payloadPreview && setOpen((o) => !o)}
      style={{ cursor: row.payloadPreview ? "pointer" : "default", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
    >
      <span style={{ color: TERM_DIM }}>{hh}:{mm}:{ss}.{ms} </span>
      <span style={{ color: ink, fontWeight: row.level === "error" || row.level === "critical" ? 600 : 400 }}>
        {row.level.toUpperCase().padEnd(6)}
      </span>
      <span style={{ color: TERM_DIM }}>{row.category.padEnd(11)} </span>
      <span style={{ color: TERM_AGENT }}>{row.agent ? `[${row.agent}] ` : ""}</span>
      <span style={{ color: ink }}>{row.message}</span>
      {open && payloadPretty && (
        <div style={{ color: TERM_DIM, paddingLeft: 24, fontSize: 10.5 }}>{payloadPretty}</div>
      )}
    </div>
  );
}

function LogEventRowView({ row }: { row: LogEventRow }) {
  const [open, setOpen] = React.useState(false);
  const ink = LEVEL_INK[row.level] ?? "var(--c-ink-3)";
  const time = new Date(row.ts).toLocaleTimeString();
  return (
    <div className="border-b border-line">
      <button
        onClick={() => row.payloadPreview && setOpen((o) => !o)}
        className="w-full flex items-center gap-3 text-left py-1.5"
      >
        <span className="text-[10.5px] text-ink-4 mono tabular-nums shrink-0 w-[72px]">{time}</span>
        <span className="text-[10px] shrink-0 w-[44px] font-medium" style={{ color: ink }}>
          {row.level}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-raised text-ink-3 shrink-0">{row.category}</span>
        <span className="text-[11px] text-ink-2 mono shrink-0 w-[90px] truncate">{row.agent ?? "—"}</span>
        <span className="text-[12px] text-ink-1 truncate flex-1">{row.message}</span>
        {row.runId && (
          <a
            href={`/monitor/runs/${row.runId}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] text-accent mono shrink-0 hover:underline"
            title={row.runId}
          >
            run
          </a>
        )}
      </button>
      {open && row.payloadPreview && (
        <pre
          className="mono text-[10.5px] text-ink-2 whitespace-pre-wrap break-words bg-bg"
          style={{ margin: 0, padding: "6px 10px", maxHeight: 240, overflow: "auto" }}
        >
          {row.payloadPreview}
        </pre>
      )}
    </div>
  );
}
