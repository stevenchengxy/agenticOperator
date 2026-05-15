"use client";
import React from "react";
import { useSearchParams } from "next/navigation";
import { ClaudeCard, ClaudeBadge, ClaudeButton, ClaudeChip } from "./atoms";
import { useApp } from "@/lib/i18n";
import { formatRelativeTime, formatTime } from "./i18n-utils";

// ── Types ──────────────────────────────────────────────────────────────────

type AuditRow = {
  id: string;
  action: string;
  traceId: string | null;
  payload: unknown;
  source: string | null;
  createdAt: string;
};

type AuditResponse = {
  rows: AuditRow[];
  total: number;
  limit: number;
  offset: number;
};

// ── Constants ──────────────────────────────────────────────────────────────

const ALL_ACTIONS = [
  "manage.run.restart",
  "manage.run.cancel",
  "manage.run.pause",
  "manage.run.resume",
  "manage.event.replay",
  "manage.agent.config",
  "manage.agent.throttle",
  "manage.runs.batch",
];

const TIME_WINDOWS = [
  { label: "1h",  ms: 1 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "7d",  ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "All", ms: null },
];

const PAGE_SIZE = 50;
const AUTO_REFRESH_MS = 8_000;

// ── Action badge tone ──────────────────────────────────────────────────────

function actionTone(action: string): "accent" | "warn" | "neutral" {
  if (action.startsWith("manage.run")) return "accent";
  if (action.startsWith("manage.agent")) return "warn";
  return "neutral";
}

// ── Time formatting helpers ────────────────────────────────────────────────

// ── Row expansion ──────────────────────────────────────────────────────────

function PayloadExpansion({ payload }: { payload: unknown }) {
  const { t } = useApp();
  const parsed: Record<string, unknown> | null = React.useMemo(() => {
    if (typeof payload === "string") {
      try { return JSON.parse(payload) as Record<string, unknown>; }
      catch { return null; }
    }
    if (typeof payload === "object" && payload !== null) {
      return payload as Record<string, unknown>;
    }
    return null;
  }, [payload]);

  if (!parsed) {
    return (
      <div className="mt-1 mb-2 ml-[60px] pl-3 border-l-2 border-claude-accent/40 bg-claude-panel/30 rounded-r py-2 pr-3">
        <pre className="text-[11.5px] text-claude-ink-2 whitespace-pre-wrap break-all">
          {String(payload)}
        </pre>
      </div>
    );
  }

  const before = parsed.before as Record<string, unknown> | undefined;
  const after = parsed.after as Record<string, unknown> | undefined;
  const hasDiff = before != null || after != null;

  return (
    <div className="mt-1 mb-2 ml-[60px] border-l-2 border-claude-accent/40 pl-3 bg-claude-panel/30 rounded-r py-2 pr-3">
      {hasDiff ? (
        <div className="flex gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-[10.5px] uppercase tracking-wide text-claude-ink-4 font-medium mb-1">{t("monitor_detail_before")}</div>
            <pre className="text-[11px] text-claude-ink-2 whitespace-pre-wrap break-all">
              {JSON.stringify(before ?? null, null, 2)}
            </pre>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10.5px] uppercase tracking-wide text-claude-ink-4 font-medium mb-1">{t("monitor_detail_after")}</div>
            <pre className="text-[11px] text-claude-ink-2 whitespace-pre-wrap break-all">
              {JSON.stringify(after ?? null, null, 2)}
            </pre>
          </div>
        </div>
      ) : (
        <pre className="text-[11.5px] text-claude-ink-2 whitespace-pre-wrap break-all">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function AuditContent() {
  const { t, lang } = useApp();
  const searchParams = useSearchParams();

  // Pre-populate traceId filter from URL param
  const initialTrace = searchParams?.get("traceId") ?? "";

  const [action, setAction] = React.useState<string>("");
  const [timeWindow, setTimeWindow] = React.useState<string>("All");
  const [traceInput, setTraceInput] = React.useState<string>(initialTrace);
  const [traceFilter, setTraceFilter] = React.useState<string>(initialTrace);
  const [offset, setOffset] = React.useState<number>(0);
  const [autoRefresh, setAutoRefresh] = React.useState<boolean>(false);
  const [data, setData] = React.useState<AuditResponse | null>(null);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  // ── Build fetch URL ────────────────────────────────────────────────────

  const buildUrl = React.useCallback(() => {
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (traceFilter) params.set("traceId", traceFilter);
    const tw = TIME_WINDOWS.find((w) => w.label === timeWindow);
    if (tw?.ms != null) {
      params.set("since", new Date(Date.now() - tw.ms).toISOString());
    }
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    return `/api/manage/audit?${params.toString()}`;
  }, [action, traceFilter, timeWindow, offset]);

  // ── Fetch ──────────────────────────────────────────────────────────────

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(buildUrl());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AuditResponse;
      setData(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [buildUrl]);

  // Fetch on filter/page change
  React.useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Auto-refresh
  React.useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => { void fetchData(); }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, fetchData]);

  // ── Trace filter submit ────────────────────────────────────────────────

  const applyTrace = () => {
    setTraceFilter(traceInput.trim());
    setOffset(0);
  };

  const onTraceKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") applyTrace();
  };

  // ── Copy trace ID ──────────────────────────────────────────────────────

  const copyTrace = (id: string) => {
    void navigator.clipboard.writeText(id).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  // ── Pagination ─────────────────────────────────────────────────────────

  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const rows = data?.rows ?? [];

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      {/* Hero */}
      <div className="mb-6">
        <h1 className="text-[24px] font-medium leading-tight">{t("monitor_audit_title")}</h1>
        <p className="text-[13px] text-claude-ink-3 mt-0.5">{t("monitor_audit_subtitle")}</p>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Action dropdown */}
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] text-claude-ink-4 shrink-0">{t("monitor_audit_filter_action")}:</span>
          <select
            value={action}
            onChange={(e) => { setAction(e.target.value); setOffset(0); }}
            className="text-[12px] border border-claude-line rounded-[6px] px-2 py-1 bg-claude-surface text-claude-ink-2 focus:outline-none"
          >
            <option value="">{t("monitor_audit_all")}</option>
            {ALL_ACTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>

        {/* Time window */}
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] text-claude-ink-4 shrink-0">{t("monitor_audit_filter_time")}:</span>
          <div className="flex gap-1">
            {TIME_WINDOWS.map((tw) => (
              <ClaudeChip
                key={tw.label}
                active={timeWindow === tw.label}
                onClick={() => { setTimeWindow(tw.label); setOffset(0); }}
              >
                {tw.label}
              </ClaudeChip>
            ))}
          </div>
        </div>

        {/* Trace ID search */}
        <div className="flex items-center gap-1.5 ml-auto">
          <span className="text-[12px] text-claude-ink-4 shrink-0">{t("monitor_audit_filter_trace")}:</span>
          <input
            type="text"
            value={traceInput}
            onChange={(e) => setTraceInput(e.target.value)}
            onKeyDown={onTraceKeyDown}
            placeholder={t("monitor_audit_trace_placeholder")}
            className="text-[12px] border border-claude-line rounded-[6px] px-2 py-1 bg-claude-surface text-claude-ink-2 focus:outline-none w-[200px]"
          />
          <ClaudeButton size="sm" onClick={applyTrace}>
            {t("search")}
          </ClaudeButton>
          {traceFilter && (
            <ClaudeButton
              size="sm"
              variant="ghost"
              onClick={() => { setTraceInput(""); setTraceFilter(""); setOffset(0); }}
            >
              ✕
            </ClaudeButton>
          )}
        </div>

        {/* Refresh controls */}
        <ClaudeButton size="sm" onClick={() => void fetchData()} disabled={loading}>
          {loading ? "…" : t("monitor_audit_refresh")}
        </ClaudeButton>
        <label className="flex items-center gap-1.5 text-[12px] text-claude-ink-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-[var(--c-accent)]"
          />
          {t("monitor_audit_auto")}
        </label>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-3 text-[12.5px] text-claude-err">
          {t("monitor_audit_error")} {error}
        </div>
      )}

      {/* Table */}
      <ClaudeCard className="p-0 overflow-hidden">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-claude-line">
              <th className="text-left py-2.5 px-4 text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 font-medium w-[110px]">
                {t("monitor_audit_col_time")}
              </th>
              <th className="text-left py-2.5 px-3 text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 font-medium">
                {t("monitor_audit_col_action")}
              </th>
              <th className="text-left py-2.5 px-3 text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 font-medium w-[130px]">
                {t("monitor_audit_col_trace")}
              </th>
              <th className="text-left py-2.5 px-3 text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 font-medium w-[120px]">
                {t("monitor_audit_col_source")}
              </th>
              <th className="text-left py-2.5 px-3 text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 font-medium w-[100px]">
                {t("monitor_audit_col_actor")}
              </th>
              <th className="text-left py-2.5 px-3 text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 font-medium">
                {t("monitor_audit_col_reason")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="py-12 text-center text-claude-ink-4 text-[13px]">
                  {t("monitor_audit_empty")}
                </td>
              </tr>
            )}
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-12 text-center text-claude-ink-4 text-[13px]">
                  {t("monitor_loading")}
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const isExpanded = expandedId === row.id;
              const parsed: Record<string, unknown> | null = React.useMemo(() => {
                if (typeof row.payload === "string") {
                  try { return JSON.parse(row.payload) as Record<string, unknown>; }
                  catch { return null; }
                }
                return typeof row.payload === "object" && row.payload !== null
                  ? (row.payload as Record<string, unknown>)
                  : null;
              }, [row.payload]);

              const actor = parsed?.actor as string | undefined;
              const reason = parsed?.reason as string | undefined;

              return (
                <React.Fragment key={row.id}>
                  <tr
                    className={
                      "border-t border-claude-line cursor-pointer transition-colors " +
                      (isExpanded ? "bg-claude-panel/40" : "hover:bg-claude-panel/20")
                    }
                    onClick={() => setExpandedId(isExpanded ? null : row.id)}
                  >
                    {/* Time */}
                    <td className="py-2.5 px-4 align-top">
                      <div className="text-[12px] text-claude-ink-2 tabular-nums">{formatTime(row.createdAt, lang)}</div>
                      <div className="text-[10.5px] text-claude-ink-4">{formatRelativeTime(row.createdAt, lang)}</div>
                    </td>

                    {/* Action badge */}
                    <td className="py-2.5 px-3 align-top">
                      <ClaudeBadge tone={actionTone(row.action)} size="xs">
                        {row.action}
                      </ClaudeBadge>
                    </td>

                    {/* Trace ID */}
                    <td className="py-2.5 px-3 align-top">
                      {row.traceId ? (
                        <button
                          type="button"
                          title={row.traceId}
                          onClick={(e) => {
                            e.stopPropagation();
                            copyTrace(row.traceId!);
                          }}
                          className="font-mono text-[11px] text-claude-accent hover:underline truncate max-w-[120px] inline-block"
                        >
                          {copiedId === row.traceId ? "Copied!" : row.traceId.slice(0, 12) + "…"}
                        </button>
                      ) : (
                        <span className="text-claude-ink-4">—</span>
                      )}
                    </td>

                    {/* Source */}
                    <td className="py-2.5 px-3 align-top">
                      <span className="text-claude-ink-3 truncate max-w-[110px] inline-block">
                        {row.source ?? "—"}
                      </span>
                    </td>

                    {/* Actor */}
                    <td className="py-2.5 px-3 align-top">
                      <span className="text-claude-ink-2">
                        {actor ?? "—"}
                      </span>
                    </td>

                    {/* Reason */}
                    <td className="py-2.5 px-3 align-top">
                      <span className="text-claude-ink-3 truncate max-w-[300px] inline-block">
                        {reason ? reason.slice(0, 80) + (reason.length > 80 ? "…" : "") : "—"}
                      </span>
                      <span className="ml-2 text-[10px] text-claude-ink-4">{isExpanded ? "▴" : "▾"}</span>
                    </td>
                  </tr>

                  {/* Expansion row */}
                  {isExpanded && (
                    <tr className="bg-claude-panel/30">
                      <td colSpan={6} className="px-4 py-0 pb-2">
                        <PayloadExpansion payload={row.payload} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </ClaudeCard>

      {/* Pagination */}
      {total > 0 && (
        <div className="mt-4 flex items-center justify-between text-[12.5px] text-claude-ink-3">
          <span>
            {total} {total === 1 ? "entry" : "entries"} · page {currentPage} of {Math.max(1, totalPages)}
          </span>
          <div className="flex items-center gap-2">
            <ClaudeButton
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              ← Prev
            </ClaudeButton>
            <ClaudeButton
              size="sm"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next →
            </ClaudeButton>
          </div>
        </div>
      )}
    </div>
  );
}
