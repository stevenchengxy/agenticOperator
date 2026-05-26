"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { AuditResponse, AuditLogRow } from "@/app/api/audit/route";
import type { RunAuditResponse, RunAuditSummary } from "@/app/api/audit/runs/route";

type Tab = "runs" | "events" | "ops";

export function AuditContent() {
  const [tab, setTab] = React.useState<Tab>("runs");

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        className="border-b border-line bg-surface flex items-center"
        style={{ padding: "14px 22px", gap: 18 }}
      >
        <div>
          <div className="text-[15px] font-semibold tracking-tight">审计日志</div>
          <div className="text-ink-3 text-[12px] mt-px">
            每次运行的完整信息 + 全量 log 数据 · WORM (write-once) · 不可篡改
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1 bg-panel rounded-md p-0.5 border border-line">
          <TabButton active={tab === "runs"} onClick={() => setTab("runs")}>
            运行完整日志
          </TabButton>
          <TabButton active={tab === "events"} onClick={() => setTab("events")}>
            事件发布审计
          </TabButton>
          <TabButton active={tab === "ops"} onClick={() => setTab("ops")}>
            操作审计
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
          运维写操作审计(取消 / 暂停 / 恢复运行 · 重放事件 · 批量操作 · 改 agent 配置)
          {data ? ` · ${data.total} 条` : ""}
        </span>
      </div>
      <div className="flex-1 overflow-auto" style={{ padding: "16px 22px" }}>
        {loading && !data ? (
          <EmptyState title="加载中…" hint="" />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={<Ic.book />}
            title="暂无运维操作记录"
            hint="每次在监控页对运行执行取消 / 暂停 / 恢复 / 重放 / 批量操作 / 改 agent 配置时,都会在此留下不可篡改的审计行(操作者 · 原因 · 操作前后状态)。"
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

const OPS_ACTION_LABEL: Record<string, string> = {
  "manage.run.cancel": "🛑 取消运行",
  "manage.run.pause": "⏸ 暂停运行",
  "manage.run.resume": "▶ 恢复运行",
  "manage.run.restart": "🔄 重启运行",
  "manage.run.replay": "🔁 重放运行",
  "manage.event.replay": "🔁 重放事件",
  "manage.runs.batch": "📦 批量操作",
  "manage.agent.config": "⚙ 改 agent 配置",
  "manage.agent.throttle": "🚦 调 agent 限流",
};

function OpsAuditRow({ row }: { row: AuditLogRow }) {
  const [open, setOpen] = React.useState(false);
  const t = new Date(row.createdAt);
  const time = `${t.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} ${t.toLocaleTimeString(undefined, { hour12: false })}`;
  const label = OPS_ACTION_LABEL[row.eventName] ?? row.eventName;
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
        {parsed.actor && <span className="mono text-[10.5px] text-ink-3">操作者 {parsed.actor}</span>}
        {row.traceId && row.traceId !== "—" && (
          <span className="mono text-[10.5px] text-ink-4">目标 {row.traceId.slice(0, 18)}…</span>
        )}
        <span className="flex-1" />
        {parsed.reason && <span className="text-[10.5px] text-ink-3 truncate max-w-[200px]">{parsed.reason}</span>}
      </button>
      {open && (
        <pre
          className="mono text-[10.5px] text-ink-1 whitespace-pre-wrap break-words border-t border-line bg-bg"
          style={{ margin: 0, padding: "8px 10px", maxHeight: 400, overflow: "auto", lineHeight: 1.55 }}
        >
          {prettyPayload || "(无 payload)"}
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
        <FilterInput label="智能体" value={agent} onChange={setAgent} placeholder="interviewInviter | resumeParser | ruleCheck" width={240} />
        <FilterInput label="候选人 ID" value={candidateId} onChange={setCandidateId} placeholder="candidate_id" width={220} />
        <FilterInput label="run_id" value={runId} onChange={setRunId} placeholder="01K..." width={180} />
        <div className="flex-1" />
        <Btn size="sm" onClick={load} disabled={loading}>
          刷新
        </Btn>
        {data && (
          <span className="text-ink-4 text-[11px] mono">
            {data.total} 次运行 · 扫了 {data.scanned_files} 个日志文件
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto" style={{ padding: "16px 22px" }}>
        {loading && !data ? (
          <EmptyState title="加载中…" hint="" />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={<Ic.book />}
            title="暂无运行记录"
            hint="运行日志由各智能体在执行时写入 logs/ 目录。触发一次智能体运行后,这里会出现完整的逐步 in/out 审计。"
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
        {run.has_error && <span className="text-err text-[10.5px]">含失败步骤</span>}
        <span className="text-ink-2 text-[12px]">
          {run.event_name ?? "—"}
        </span>
        {run.anchors.candidate_id && (
          <span className="mono text-[10.5px] text-ink-3" title="候选人 ID">
            候选人 {run.anchors.candidate_id.slice(0, 12)}…
          </span>
        )}
        <span className="flex-1" />
        <span className="mono text-[10.5px] text-ink-4">{run.event_count} 步</span>
        <span className="mono text-[10.5px] text-ink-4 tabular-nums">{Math.round(dur)}ms</span>
        <span className="mono text-[10.5px] text-ink-3 tabular-nums">{startLocal}</span>
      </button>
      <div className="px-3 pb-1 flex items-center gap-1.5 flex-wrap" style={{ paddingLeft: 38 }}>
        <span className="mono text-[10px] text-ink-4">run {run.run_id.slice(0, 18)}…</span>
        {run.kinds.slice(0, 8).map((k) => (
          <span key={k} className="text-[9.5px] mono text-ink-4 bg-panel px-1 py-px rounded-sm">
            {RUN_KIND_LABEL[k] ?? k}
          </span>
        ))}
      </div>

      {expanded && (
        <div className="border-t border-line bg-panel/30 p-2">
          {loadingEvents ? (
            <div className="text-ink-4 text-[11px] italic px-2 py-3">加载完整日志…</div>
          ) : !events || events.length === 0 ? (
            <div className="text-ink-4 text-[11px] italic px-2 py-3">
              该运行无 file log(可能是 dev server 重启前的旧 run,或非本机运行)。
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
  const [open, setOpen] = React.useState(false);
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const from = typeof p.from === "string" ? p.from : null;
  const to = typeof p.to === "string" ? p.to : null;
  const label = RUN_KIND_LABEL[event.kind] ?? event.kind;
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

const RUN_KIND_LABEL: Record<string, string> = {
  "handler.start": "▶ 开始处理",
  "handler.raw_input": "📥 完整入参 (上游 → 智能体)",
  "handler.done": "✅ 处理完成",
  "backfill.resume.ok": "🔄 回查简历正文",
  "backfill.jd.ok": "🔄 回查 JD 文本",
  "emit.invitation-sent": "📡 回发「邀约已送达」",
  "emit.invitation-failed": "📡 回发「邀约失败」",
  "emit.resume-processed": "📡 回发「简历已解析」",
  "save-candidate.ok": "💾 保存候选人 + 简历",
  "save-candidate.failed": "❌ 保存候选人失败",
  "step.start": "▶ 步骤开始",
  "step.end": "■ 步骤结束",
  "diag.invite-input.preview": "🔎 邀约入参预览",
  "llm.request": "🧠 大模型入参 (prompt)",
  "llm.response": "🧠 大模型出参 (回复)",
  "llm.failed": "❌ 大模型调用失败",
  "runRuleCheck.start": "▶ 规则检查开始",
  "rule-fetch.failed": "❌ 规则拉取失败",
};

// ════════════════════════════════════════════════════════════════════════
// Tab 2 — 事件发布审计(em.publish WORM)
// ════════════════════════════════════════════════════════════════════════

function EventAuditTab() {
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
          EM 库 publish 全量审计{data ? ` · ${data.total.toLocaleString()} 条` : ""}
        </span>
        <div className="flex-1" />
        <FilterInput label="事件名" value={eventName} onChange={(v) => setFilter("eventName", v)} placeholder="EVENT_NAME" width={180} />
        <FilterInput label="trace_id" value={traceId} onChange={(v) => setFilter("traceId", v)} placeholder="trace-..." width={180} />
        <FilterInput label="来源" value={source} onChange={(v) => setFilter("source", v)} placeholder="ws | em | external" width={140} />
      </div>
      <div className="flex-1 overflow-auto" style={{ padding: "16px 22px" }}>
        {loading && !data ? (
          <EmptyState title="加载中…" hint="" />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={<Ic.book />}
            title={data?.meta.empty ? "暂无事件审计记录" : "无匹配项"}
            hint={
              data?.meta.empty
                ? "AuditLog 由 EM 库的 em.publish 写入。每次发布都会在此留下不可篡改的审计行。"
                : "尝试清空筛选条件"
            }
            variant={data?.meta.empty ? "info" : "default"}
            action={
              !data?.meta.empty ? (
                <Btn size="sm" onClick={() => router.replace("/audit")}>
                  清空筛选
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
        <span className="mono text-[11.5px] text-ink-1 truncate">{row.eventName}</span>
        <Badge variant={sourceVariant}>{row.source}</Badge>
        <span className="flex-1" />
        <span
          onClick={(e) => { e.stopPropagation(); onCopy(row.traceId); }}
          className="mono text-[10.5px] text-ink-4 hover:text-ink-2 shrink-0"
          title="点击复制 trace_id"
        >
          {row.traceId === "—" || !row.traceId ? "" : `trace ${row.traceId.slice(0, 16)}…`}
        </span>
      </button>
      {open && (
        <pre
          className="mono text-[10.5px] text-ink-1 whitespace-pre-wrap break-words border-t border-line bg-bg"
          style={{ margin: 0, padding: "8px 10px", maxHeight: 400, overflow: "auto", lineHeight: 1.55 }}
        >
          {prettyPayload || "(无 payload)"}
        </pre>
      )}
    </div>
  );
}
