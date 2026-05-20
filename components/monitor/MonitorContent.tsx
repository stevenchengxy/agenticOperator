"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Ic } from "@/components/shared/Ic";
import { SystemStatusCards } from "./SystemStatusCards";
import { INNGEST_REAL_SHORTS } from "@/lib/agent-mapping";
import { WSID_TO_INNGEST_SLUG } from "@/lib/api/inngest-live-overlay";
import {
  RunDetailExpansion,
  fetchRunDetail,
  STATUS_ZH,
  statusDotColor,
  relTime,
  type RunRow,
  type RunDetail,
  type RunStatus,
} from "@/components/shared/RunTrace";

// /monitor — 运行监控
//
// Job: "What's running / has run? Show me the trace of any individual run."
// Plus: infrastructure status cards (event mgr / RAAS API / Ontology / Inngest).
//
// Per IA spec (2026-05-19):
//   - Run-level execution only (no agent registry → /fleet, no event stream → /events)
//   - Infrastructure status preserved per user explicit request
//
// Removed from the old multi-tab page:
//   - InngestAgentsTab → owned by /fleet
//   - InngestEventsTab → owned by /events
//   - DLQ tab → /alerts (future)
//   - MonitorGraph / RuntimeTopologyView → deferred

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

const REAL_AGENT_SHORTS = Array.from(INNGEST_REAL_SHORTS);

type StatusFilter = "all" | RunStatus;
type WindowId = "1h" | "24h" | "7d";

export function MonitorContent() {
  const router = useRouter();
  const sp = useSearchParams();

  const agentFilter = sp.get("agent");
  const statusFilter = (sp.get("status") ?? "all") as StatusFilter;
  const windowId = (sp.get("window") ?? "24h") as WindowId;
  const eventName = sp.get("event");
  const runIdParam = sp.get("run");

  const setUrl = React.useCallback((mut: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(sp.toString());
    mut(next);
    router.replace(`/monitor${next.toString() ? `?${next.toString()}` : ""}`);
  }, [router, sp]);

  const agentSlug = React.useMemo(() => {
    if (!agentFilter) return null;
    return shortToSlug(agentFilter);
  }, [agentFilter]);

  const [runs, setRuns] = React.useState<RunRow[] | null>(null);
  const [lastRefresh, setLastRefresh] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const url = agentSlug
          ? `/api/inngest-admin/runs?fn=${encodeURIComponent(agentSlug)}&limit=200`
          : `/api/inngest-admin/runs?limit=200`;
        const res = await fetch(url);
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        setRuns(body.runs ?? []);
        setLastRefresh(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      } catch { /* soft */ }
    }
    load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [agentSlug]);

  const filtered = React.useMemo(() => {
    if (!runs) return [];
    let xs = runs;
    if (statusFilter !== "all") xs = xs.filter((r) => r.status === statusFilter);
    if (eventName) xs = xs.filter((r) => r.eventName === eventName);
    const windowMs = windowId === "1h" ? 3600_000 : windowId === "24h" ? 86400_000 : 7 * 86400_000;
    const cutoff = Date.now() - windowMs;
    xs = xs.filter((r) => {
      if (!r.startedAt) return true;
      return new Date(r.startedAt).getTime() >= cutoff;
    });
    return xs;
  }, [runs, statusFilter, eventName, windowId]);

  const counts = React.useMemo(() => {
    const c = { running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const r of filtered) {
      if (r.status === "Running") c.running++;
      else if (r.status === "Completed") c.completed++;
      else if (r.status === "Failed") c.failed++;
      else if (r.status === "Cancelled") c.cancelled++;
    }
    return c;
  }, [filtered]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-auto bg-bg">
      <div className="border-b border-line" style={{ padding: "28px 32px 18px" }}>
        <div className="flex items-start gap-6">
          <div className="flex-1 min-w-0">
            <h1 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontWeight: 500, fontSize: 26, letterSpacing: "-0.015em", lineHeight: 1.15 }}>
              运行监控
            </h1>
            <div className="text-ink-2 mt-1.5" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
              基础设施健康 · 每一次 agent 运行的详情与 trace
            </div>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <LiveDot lastRefresh={lastRefresh} />
          </div>
        </div>

        <div className="flex items-center gap-x-7 gap-y-1.5 mt-4 flex-wrap">
          <CountChip label="总" value={String(filtered.length)} tone="muted" />
          <CountChip
            label="运行中"
            value={String(counts.running)}
            tone={counts.running > 0 ? "ok" : "muted"}
            active={statusFilter === "Running"}
            onClick={() => setUrl((p) => statusFilter === "Running" ? p.delete("status") : p.set("status", "Running"))}
          />
          <CountChip
            label="已完成"
            value={String(counts.completed)}
            tone="muted"
            active={statusFilter === "Completed"}
            onClick={() => setUrl((p) => statusFilter === "Completed" ? p.delete("status") : p.set("status", "Completed"))}
          />
          <CountChip
            label="失败"
            value={String(counts.failed)}
            tone={counts.failed > 0 ? "err" : "muted"}
            active={statusFilter === "Failed"}
            onClick={() => setUrl((p) => statusFilter === "Failed" ? p.delete("status") : p.set("status", "Failed"))}
          />
          <div className="flex-1" />
          <WindowSelector value={windowId} onChange={(v) => setUrl((p) => v === "24h" ? p.delete("window") : p.set("window", v))} />
        </div>
      </div>

      {/* infrastructure status — preserved per user request 2026-05-19 */}
      <div style={{ padding: "16px 32px 0" }}>
        <div className="text-ink-3 mb-2 flex items-baseline gap-2" style={{ fontSize: 12 }}>
          基础设施
        </div>
        <SystemStatusCards />
      </div>

      {/* secondary filter toolbar */}
      <div className="flex items-center gap-3 mt-4 flex-wrap" style={{ padding: "10px 32px", fontSize: 12.5 }}>
        <span className="text-ink-3">智能体</span>
        <AgentFilter
          value={agentFilter}
          onChange={(v) => setUrl((p) => v ? p.set("agent", v) : p.delete("agent"))}
        />
        {(agentFilter || eventName || statusFilter !== "all") && (
          <button
            onClick={() => setUrl((p) => { p.delete("agent"); p.delete("event"); p.delete("status"); })}
            className="text-ink-3 hover:text-ink-1"
          >
            清空筛选
          </button>
        )}
        {eventName && (
          <span className="inline-flex items-center gap-1.5 text-ink-2 rounded border border-line bg-surface" style={{ padding: "3px 9px", fontSize: 12 }}>
            <span className="text-ink-3">事件</span> {eventName}
            <button onClick={() => setUrl((p) => p.delete("event"))} className="text-ink-3 hover:text-ink-1 ml-1">×</button>
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0" style={{ padding: "8px 32px 48px" }}>
        {runs === null && (
          <div className="text-ink-3 text-[13px] text-center py-16">加载中…</div>
        )}
        {runs !== null && filtered.length === 0 && (
          <div className="text-ink-3 text-[13px] text-center py-16">
            没有匹配当前筛选的运行记录
          </div>
        )}
        {runs !== null && filtered.length > 0 && (
          <RunsList runs={filtered} initialExpandedId={runIdParam} />
        )}
      </div>
    </div>
  );
}

// ── runs list with expandable trace ─────────────────────────────

function RunsList({ runs, initialExpandedId }: { runs: RunRow[]; initialExpandedId: string | null }) {
  const [expandedId, setExpandedId] = React.useState<string | null>(initialExpandedId);
  const [details, setDetails] = React.useState<Record<string, RunDetail | "loading" | "error">>({});

  const fetchDetail = React.useCallback(async (runId: string) => {
    if (details[runId] && details[runId] !== "error") return;
    setDetails((m) => ({ ...m, [runId]: "loading" }));
    const result = await fetchRunDetail(runId);
    setDetails((m) => ({ ...m, [runId]: result ?? "error" }));
  }, [details]);

  // If a runId came in via URL, prefetch its detail
  React.useEffect(() => {
    if (initialExpandedId && !details[initialExpandedId]) {
      fetchDetail(initialExpandedId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialExpandedId]);

  const toggle = (run: RunRow) => {
    const next = expandedId === run.id ? null : run.id;
    setExpandedId(next);
    if (next) fetchDetail(run.id);
  };

  return (
    <>
      <div
        className="grid gap-4 text-ink-3 border-b border-line"
        style={{ gridTemplateColumns: "200px minmax(0, 1fr) 110px 90px 80px 18px", padding: "8px 12px", fontSize: 11.5 }}
      >
        <span>智能体</span>
        <span>触发事件</span>
        <span>状态</span>
        <span style={{ textAlign: "right" }}>开始</span>
        <span style={{ textAlign: "right" }}>耗时</span>
        <span />
      </div>
      {runs.map((r) => {
        const expanded = expandedId === r.id;
        const agentShort = slugToShort(r.function?.slug);
        return (
          <div key={r.id} className="border-b border-line">
            <button
              onClick={() => toggle(r)}
              className="w-full grid items-center gap-4 hover:bg-panel transition-colors text-left cursor-pointer"
              style={{ padding: "12px 12px", gridTemplateColumns: "200px minmax(0, 1fr) 110px 90px 80px 18px" }}
            >
              <span className="text-ink-1 truncate" style={{ fontSize: 13, fontWeight: 500 }}>
                {agentShort ?? r.function?.slug ?? "—"}
              </span>
              <span className="text-ink-3 truncate" style={{ fontSize: 12 }}>
                {r.eventName ?? "—"}
              </span>
              <span className="flex items-center gap-2">
                <span className="rounded-full inline-block" style={{ width: 7, height: 7, background: statusDotColor(r.status) }} />
                <span style={{ fontSize: 12.5, color: r.status === "Failed" ? "var(--c-err)" : "var(--c-ink-1)" }}>
                  {STATUS_ZH[r.status]}
                </span>
              </span>
              <span className="text-ink-3 tabular-nums" style={{ textAlign: "right", fontSize: 12 }}>
                {relTime(r.startedAt)}
              </span>
              <span className="text-ink-3 tabular-nums" style={{ textAlign: "right", fontSize: 12 }}>
                {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "—"}
              </span>
              <span className="text-ink-4 flex justify-center" style={{ fontSize: 11 }}>
                <Ic.chev style={{ width: 10, height: 10, transition: "transform 0.15s", transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }} />
              </span>
            </button>
            {expanded && (
              <RunDetailExpansion
                run={r}
                detail={details[r.id]}
                agentShortForLinks={agentShort ?? undefined}
                showAgentLink
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function shortToSlug(short: string): string | null {
  if (short === "JDGenerator") return WSID_TO_INNGEST_SLUG["4"];
  if (short === "ResumeParser") return WSID_TO_INNGEST_SLUG["9-1"];
  if (short === "Matcher") return WSID_TO_INNGEST_SLUG["10"];
  if (short === "RuleCheck") return WSID_TO_INNGEST_SLUG["10-5"];
  return null;
}

function slugToShort(slug: string | undefined): string | null {
  if (!slug) return null;
  if (slug.includes("create-jd")) return "JDGenerator";
  if (slug.includes("resume-parser")) return "ResumeParser";
  if (slug.includes("match-resume")) return "Matcher";
  if (slug.includes("rule-check")) return "RuleCheck";
  return null;
}

// ── controls ────────────────────────────────────────────────────

function CountChip({
  label, value, tone, active, onClick,
}: {
  label: string;
  value: string;
  tone?: "ok" | "err" | "muted";
  active?: boolean;
  onClick?: () => void;
}) {
  const color =
    tone === "ok"    ? "var(--c-ok)" :
    tone === "err"   ? "var(--c-err)" :
    tone === "muted" ? "var(--c-ink-2)" :
    "var(--c-ink-1)";
  const Tag: React.ElementType = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={"flex items-baseline gap-2 transition-opacity " + (onClick ? "cursor-pointer hover:opacity-75" : "")}
      style={{
        borderBottom: active ? "1.5px solid var(--c-ink-1)" : "1.5px solid transparent",
        paddingBottom: 2,
      }}
    >
      <span className="text-ink-3" style={{ fontSize: 12 }}>{label}</span>
      <span className="font-semibold tabular-nums" style={{ fontSize: 18, color, letterSpacing: "-0.015em" }}>{value}</span>
    </Tag>
  );
}

function WindowSelector({ value, onChange }: { value: WindowId; onChange: (v: WindowId) => void }) {
  const opts: { id: WindowId; label: string }[] = [
    { id: "1h", label: "近 1h" },
    { id: "24h", label: "近 24h" },
    { id: "7d", label: "近 7d" },
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

function AgentFilter({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <button
        onClick={() => onChange(null)}
        className="transition-colors rounded"
        style={{
          padding: "3px 9px", fontSize: 12.5,
          color: value === null ? "var(--c-ink-1)" : "var(--c-ink-3)",
          background: value === null ? "var(--c-panel)" : "transparent",
          fontWeight: value === null ? 500 : 400,
        }}
      >
        全部
      </button>
      {REAL_AGENT_SHORTS.map((short) => (
        <button
          key={short}
          onClick={() => onChange(short)}
          className="transition-colors rounded"
          style={{
            padding: "3px 9px", fontSize: 12.5,
            color: value === short ? "var(--c-ink-1)" : "var(--c-ink-3)",
            background: value === short ? "var(--c-panel)" : "transparent",
            fontWeight: value === short ? 500 : 400,
          }}
        >
          {short}
        </button>
      ))}
    </div>
  );
}

function LiveDot({ lastRefresh }: { lastRefresh: string | null }) {
  const live = !!lastRefresh;
  return (
    <span
      className="flex items-center gap-1.5 text-ink-3"
      title={live ? `最后刷新 ${lastRefresh}` : "正在连接 Inngest…"}
      style={{ fontSize: 11.5 }}
    >
      <span
        className={live ? "rounded-full anim-pulse" : "rounded-full"}
        style={{ width: 6, height: 6, background: live ? "var(--c-ok)" : "var(--c-ink-4)" }}
      />
      {live ? "实时" : "连接中"}
    </span>
  );
}
