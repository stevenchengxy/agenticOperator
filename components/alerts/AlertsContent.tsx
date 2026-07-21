"use client";

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import type { Alert, AlertCategory, AlertSeverity } from "@/lib/api/types";
import { fetchJson } from "@/lib/api/client";
import { paginationFrom, readPage, readPageSize, setPaginationParams } from "@/lib/api/pagination";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { Pagination } from "@/components/shared/Pagination";

type PersistentAlert = Alert & {
  status?: string | null;
  description?: string | null;
  source?: string | null;
  resolvedAt?: string | null;
  updatedAt?: string | null;
  metadata?: unknown;
};

type AlertsEnvelope = {
  alerts?: unknown[];
  items?: unknown[];
  rows?: unknown[];
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  pagination?: { page?: number; pageSize?: number; total?: number; totalPages?: number };
  meta?: {
    partial?: string[];
    generatedAt?: string;
    page?: number;
    pageSize?: number;
    total?: number;
    totalPages?: number;
  };
};

const CATEGORIES: Array<{ id: "all" | AlertCategory; labelKey: string }> = [
  { id: "all", labelKey: "alx_ch_all" },
  { id: "rate", labelKey: "alx_ch_event" },
  { id: "quality", labelKey: "alx_ch_quality" },
  { id: "sla", labelKey: "alx_ch_sla" },
  { id: "infra", labelKey: "alx_ch_infra" },
  { id: "dlq", labelKey: "alx_ch_dlq" },
];
export function AlertsContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const { t } = useApp();
  const category = (sp.get("category") ?? "all") as "all" | AlertCategory;
  const includeResolved = sp.get("resolved") !== "0";
  const selectedId = sp.get("alert");
  const page = readPage(sp.get("page"));
  const pageSize = readPageSize(sp.get("pageSize"), [20, 50, 100], 50);

  const setUrl = React.useCallback((mutate: (params: URLSearchParams) => void) => {
    const next = new URLSearchParams(sp.toString());
    mutate(next);
    router.replace(`/alerts${next.toString() ? `?${next.toString()}` : ""}`);
  }, [router, sp]);

  const [alerts, setAlerts] = React.useState<PersistentAlert[] | null>(null);
  const [total, setTotal] = React.useState<number | null>(null);
  const [totalPages, setTotalPages] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [partial, setPartial] = React.useState<string[]>([]);
  const [generatedAt, setGeneratedAt] = React.useState<string | null>(null);
  const requestSeq = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const request = ++requestSeq.current;
    const params = new URLSearchParams();
    setPaginationParams(params, page, pageSize);
    if (category !== "all") params.set("category", category);
    params.set("includeResolved", includeResolved ? "1" : "0");
    setLoading(true);
    try {
      const body = await fetchJson<AlertsEnvelope>(`/api/alerts?${params.toString()}`, {
        cache: "no-store",
        timeoutMs: 10_000,
      });
      if (request !== requestSeq.current) return;
      const rawRows = body.alerts ?? body.items ?? body.rows ?? [];
      const rows = rawRows.map(normalizeAlert).filter((item): item is PersistentAlert => item != null);
      const pagination = paginationFrom(body, { page, pageSize, rowCount: rows.length });
      setAlerts(rows);
      setTotal(pagination.total);
      setTotalPages(pagination.totalPages);
      setPartial(Array.isArray(body.meta?.partial) ? body.meta.partial : []);
      setGeneratedAt(body.meta?.generatedAt ?? new Date().toISOString());
      setError(null);
    } catch (cause) {
      if (request !== requestSeq.current) return;
      setError(errorMessage(cause));
      setAlerts((previous) => previous ?? []);
    } finally {
      if (request === requestSeq.current) setLoading(false);
    }
  }, [category, includeResolved, page, pageSize]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, page === 1 ? 10_000 : 30_000);
    return () => { requestSeq.current += 1; clearInterval(timer); };
  }, [page, refresh]);

  React.useEffect(() => {
    if (totalPages != null && page > totalPages) {
      setUrl((params) => {
        if (totalPages <= 1) params.delete("page");
        else params.set("page", String(totalPages));
        params.delete("alert");
      });
    }
  }, [page, setUrl, totalPages]);

  const selected = alerts?.find((item) => item.id === selectedId) ?? alerts?.[0] ?? null;
  const setFilter = (key: "category", value: string) => setUrl((params) => {
    if (value === "all") params.delete(key); else params.set(key, value);
    params.delete("page");
    params.delete("alert");
  });

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-bg">
      <header className="border-b border-line bg-surface flex items-center gap-3" style={{ padding: "14px 22px" }}>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-tight flex items-center gap-2">
            {t("alx_title")}
            {total != null && <Badge variant="info">{total}</Badge>}
            {partial.length > 0 && <Badge variant="warn" dot>{t("ui_partial_data")}</Badge>}
          </div>
          <div className="text-ink-3 text-[12px] mt-px">{t("alx_persistent_subtitle")}</div>
        </div>
        <div className="flex-1" />
        {generatedAt && <span className="mono text-[10.5px] text-ink-4">{t("alx_last_synced")} {formatDate(generatedAt)}</span>}
        <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(event) => setUrl((params) => {
              if (event.target.checked) params.delete("resolved"); else params.set("resolved", "0");
              params.delete("page"); params.delete("alert");
            })}
          />
          {t("alx_include_resolved")}
        </label>
        <Btn size="sm" onClick={() => void refresh()} disabled={loading}><Ic.bolt /> {t("evx_refresh")}</Btn>
      </header>

      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "220px minmax(0, 1fr) 340px" }}>
        <aside className="border-r border-line bg-bg overflow-auto" style={{ padding: "14px 12px" }}>
          <FilterSection label={t("alx_rail_rule_channels")}>
            {CATEGORIES.map((item) => (
              <FilterButton key={item.id} active={category === item.id} onClick={() => setFilter("category", item.id)}>
                {t(item.labelKey)}
              </FilterButton>
            ))}
          </FilterSection>
          <div className="mt-5 text-[11px] leading-relaxed text-ink-4">{t("alx_persistence_hint")}</div>
        </aside>

        <main className="min-w-0 min-h-0 flex flex-col bg-surface">
          {error && alerts && alerts.length > 0 && (
            <div className="border-b border-line bg-warn-bg text-[11.5px] flex items-center gap-2" style={{ padding: "8px 12px", color: "oklch(0.5 0.14 75)" }}>
              <Ic.alert /><span className="truncate flex-1">{t("alx_load_failed")}: {error}</span>
              <button className="text-accent hover:underline" onClick={() => void refresh()}>{t("alx_retry")}</button>
            </div>
          )}
          <div className="flex-1 overflow-auto min-h-0">
            {loading && alerts == null && <div className="h-full grid place-items-center text-ink-3 text-[12px]">{t("evx_loading")}</div>}
            {!loading && alerts?.length === 0 && !error && <EmptyState icon={<Ic.alert />} title={t("alx_empty")} hint={t("alx_empty_hint")} />}
            {alerts?.length === 0 && error && (
              <EmptyState icon={<Ic.alert />} title={t("alx_load_failed")} hint={error} variant="warn" action={<Btn size="sm" onClick={() => void refresh()}>{t("alx_retry")}</Btn>} />
            )}
            {alerts && alerts.length > 0 && <AlertsTable alerts={alerts} selectedId={selected?.id ?? null} onSelect={(id) => setUrl((params) => params.set("alert", id))} />}
          </div>
          <Pagination
            page={page} pageSize={pageSize} rowCount={alerts?.length ?? 0} total={total} totalPages={totalPages} loading={loading}
            onPageChange={(nextPage) => setUrl((params) => { if (nextPage <= 1) params.delete("page"); else params.set("page", String(nextPage)); params.delete("alert"); })}
            onPageSizeChange={(nextSize) => setUrl((params) => { if (nextSize === 50) params.delete("pageSize"); else params.set("pageSize", String(nextSize)); params.delete("page"); params.delete("alert"); })}
          />
        </main>
        <AlertDetail alert={selected} />
      </div>
    </div>
  );
}

function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className="mb-5"><div className="hint mb-2 px-2">{label}</div><div className="flex flex-col gap-1">{children}</div></section>;
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="w-full text-left rounded-md text-[12px] transition-colors" style={{ padding: "6px 9px", color: active ? "var(--c-accent)" : "var(--c-ink-2)", background: active ? "var(--c-accent-bg)" : "transparent", fontWeight: active ? 600 : 400 }}>
      {children}
    </button>
  );
}

function AlertsTable({ alerts, selectedId, onSelect }: { alerts: PersistentAlert[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const { t, lang } = useApp();
  return (
    <table className="tbl" style={{ minWidth: 840, tableLayout: "fixed" }}>
      <colgroup><col style={{ width: 68 }} /><col style={{ width: 92 }} /><col /><col style={{ width: 150 }} /><col style={{ width: 166 }} /></colgroup>
      <thead><tr><th>{t("alx_col_severity")}</th><th>{t("alx_col_state")}</th><th>{t("alx_th_alert")}</th><th>{t("alx_th_impact")}</th><th>{t("alx_meta_started")}</th></tr></thead>
      <tbody>
        {alerts.map((alert) => (
          <tr key={alert.id} onClick={() => onSelect(alert.id)} className="cursor-pointer" style={{ background: alert.id === selectedId ? "var(--c-accent-bg)" : undefined }}>
            <td><SeverityBadge severity={alert.severity} /></td>
            <td><StateBadge alert={alert} /></td>
            <td><div className="font-semibold text-[12.5px] text-ink-1 truncate" title={alert.title}>{alert.title}</div><div className="mono text-[10.5px] text-ink-4 truncate">{alert.id} · {alert.category}</div></td>
            <td className="text-[11.5px] text-ink-2 truncate" title={alert.affected}>{alert.affected || "—"}</td>
            <td className="mono text-[11px] text-ink-3">{formatDate(alert.triggeredAt, lang)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AlertDetail({ alert }: { alert: PersistentAlert | null }) {
  const { t, lang } = useApp();
  if (!alert) return <aside className="border-l border-line bg-bg grid place-items-center text-center px-6 text-ink-3 text-[12px]">{t("alx_pick_alert")}</aside>;
  return (
    <aside className="border-l border-line bg-bg overflow-auto" style={{ padding: "18px" }}>
      <div className="flex items-center gap-2 mb-3"><SeverityBadge severity={alert.severity} /><StateBadge alert={alert} /></div>
      <h2 className="m-0 text-[16px] leading-snug font-semibold text-ink-1">{alert.title}</h2>
      <div className="mono text-[10.5px] text-ink-4 mt-1 break-all">{alert.id}</div>
      {alert.description && <div className="mt-4 text-[12.5px] leading-relaxed text-ink-2">{alert.description}</div>}
      <dl className="mt-5 grid gap-y-2 text-[11.5px]" style={{ gridTemplateColumns: "96px 1fr" }}>
        <dt className="text-ink-3">{t("alx_detail_category")}</dt><dd className="m-0 text-ink-1">{alert.category}</dd>
        <dt className="text-ink-3">{t("alx_meta_started")}</dt><dd className="m-0 mono text-ink-1">{formatDate(alert.triggeredAt, lang)}</dd>
        <dt className="text-ink-3">{t("alx_th_impact")}</dt><dd className="m-0 text-ink-1 break-all">{alert.affected || "—"}</dd>
        <dt className="text-ink-3">{t("alx_meta_source")}</dt><dd className="m-0 text-ink-1 break-all">{alert.source || alert.category}</dd>
        <dt className="text-ink-3">{t("alx_meta_assignee")}</dt><dd className="m-0 text-ink-1">{alert.ackedBy || t("alx_unassigned")}</dd>
        {alert.updatedAt && <><dt className="text-ink-3">{t("alx_last_updated")}</dt><dd className="m-0 mono text-ink-1">{formatDate(alert.updatedAt, lang)}</dd></>}
        {alert.resolvedAt && <><dt className="text-ink-3">{t("alx_resolved_at")}</dt><dd className="m-0 mono text-ink-1">{formatDate(alert.resolvedAt, lang)}</dd></>}
      </dl>
      {alert.metadata != null && <div className="mt-5"><div className="hint mb-2">{t("alx_metadata")}</div><pre className="m-0 rounded-md border border-line bg-surface text-ink-2 whitespace-pre-wrap break-words overflow-auto" style={{ padding: 10, maxHeight: 320, fontFamily: "var(--f-mono)", fontSize: 10.5 }}>{safeStringify(alert.metadata)}</pre></div>}
    </aside>
  );
}

function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const tone = severityTone(severity);
  return <Badge variant={tone.variant}>{severityLabel(severity)}</Badge>;
}

function StateBadge({ alert }: { alert: PersistentAlert }) {
  const { t } = useApp();
  const state = alert.status?.toLowerCase() ?? (alert.resolvedAt ? "resolved" : alert.acked ? "ack" : "firing");
  if (state === "resolved" || state === "closed") return <Badge variant="ok" dot>{t("alx_state_resolved")}</Badge>;
  if (state === "ack" || state === "acknowledged") return <Badge variant="info" dot>{t("alx_state_ack")}</Badge>;
  return <Badge variant="err" dot pulse>{t("alx_state_firing")}</Badge>;
}

function severityTone(severity: AlertSeverity): { color: string; variant: "err" | "warn" | "info" | "default" } {
  if (severity === "critical") return { color: "var(--c-err)", variant: "err" };
  if (severity === "high") return { color: "var(--c-warn)", variant: "warn" };
  if (severity === "medium") return { color: "var(--c-info)", variant: "info" };
  return { color: "var(--c-ink-3)", variant: "default" };
}
function severityLabel(severity: AlertSeverity): string { return severity === "critical" ? "P1" : severity === "high" ? "P2" : severity === "medium" ? "P3" : "P4"; }

function normalizeAlert(value: unknown): PersistentAlert | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = stringValue(row.id);
  const title = stringValue(row.title) || stringValue(row.message);
  if (!id || !title) return null;
  const status = stringValue(row.status) || null;
  return {
    id,
    category: normalizeCategory(row.category),
    severity: normalizeSeverity(row.severity),
    title,
    affected: stringValue(row.affected) || stringValue(row.source),
    triggeredAt: stringValue(row.triggeredAt) || stringValue(row.createdAt) || stringValue(row.timestamp),
    acked: Boolean(row.acked) || status === "ack" || status === "acknowledged",
    ackedBy: stringValue(row.ackedBy) || null,
    status,
    description: stringValue(row.description) || stringValue(row.detail) || null,
    source: stringValue(row.source) || null,
    resolvedAt: stringValue(row.resolvedAt) || null,
    updatedAt: stringValue(row.updatedAt) || null,
    metadata: row.metadata ?? null,
  };
}
function normalizeCategory(value: unknown): AlertCategory {
  const category = stringValue(value);
  return category === "sla" || category === "rate" || category === "quality" || category === "infra" || category === "dlq" ? category : "infra";
}
function normalizeSeverity(value: unknown): AlertSeverity {
  const severity = stringValue(value).toLowerCase();
  if (severity === "critical" || severity === "p1") return "critical";
  if (severity === "high" || severity === "p2") return "high";
  if (severity === "medium" || severity === "p3") return "medium";
  return "low";
}
function stringValue(value: unknown): string { return typeof value === "string" ? value : value == null ? "" : String(value); }
function errorMessage(value: unknown): string { return value && typeof value === "object" && "message" in value ? String((value as { message: unknown }).message) : String(value); }
function formatDate(value: string, lang?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}
function safeStringify(value: unknown): string { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
