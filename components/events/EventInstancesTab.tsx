"use client";
import React from "react";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";
import { fetchJson } from "@/lib/api/client";
import type {
  EventInstanceRow,
  EventInstancesResponse,
} from "@/app/api/em/event-instances/route";

// Three flavors of the same table — driven by which `query` we send.
// Keeps the rendering / interaction logic in one place; tab pages just
// pass a different status filter.

export type InstancesQuery = {
  statusIn?: string[];        // e.g. ["rejected_schema"]
  name?: string;
  source?: string;
  causedByEventId?: string;
  q?: string;
};

type Mode = "dlq" | "rejected" | "instances" | "causality";

export function EventInstancesTab({
  mode,
  query,
}: {
  mode: Mode;
  query: InstancesQuery;
}) {
  const { t } = useApp();
  const [data, setData] = React.useState<EventInstancesResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [searchText, setSearchText] = React.useState("");
  const [selected, setSelected] = React.useState<EventInstanceRow | null>(null);

  const refresh = React.useCallback(() => {
    setLoading(true);
    const sp = new URLSearchParams();
    if (query.statusIn?.length) sp.set("statusIn", query.statusIn.join(","));
    if (query.name) sp.set("name", query.name);
    if (query.source) sp.set("source", query.source);
    if (query.causedByEventId) sp.set("causedByEventId", query.causedByEventId);
    if (searchText) sp.set("q", searchText);
    sp.set("limit", "200");
    fetchJson<EventInstancesResponse>(`/api/em/event-instances?${sp.toString()}`)
      .then((r) => {
        setData(r);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [query.statusIn, query.name, query.source, query.causedByEventId, searchText]);

  React.useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const isEmpty = !loading && (!data || data.rows.length === 0);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        className="border-b border-line bg-surface flex items-center"
        style={{ padding: "10px 22px", gap: 12 }}
      >
        <input
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder={
            mode === "instances"
              ? t("evx_search_instances_placeholder")
              : t("evx_filter_name_placeholder")
          }
          className="h-7 border border-line bg-panel rounded-sm mono text-[11.5px] text-ink-1 outline-none w-[280px]"
          style={{ padding: "0 8px" }}
        />
        <div className="flex-1" />
        <span className="text-[11.5px] text-ink-3 mono">
          {data ? `${data.rows.length} / ${data.total.toLocaleString()}` : "—"}
        </span>
        <Btn size="sm" variant="ghost" onClick={refresh}>
          <Ic.bolt /> {t("evx_refresh")}
        </Btn>
      </div>
      {err ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.alert />}
            title={t("evx_load_failed")}
            hint={err}
            variant="warn"
            action={<Btn size="sm" onClick={refresh}>{t("evx_retry")}</Btn>}
          />
        </div>
      ) : isEmpty ? (
        <EmptyForMode mode={mode} hasFilter={!!searchText} t={t} />
      ) : (
        <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: selected ? "1fr 380px" : "1fr" }}>
          <div className="overflow-auto" style={{ padding: "12px 22px" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>{t("evx_col_time")}</th>
                  <th style={{ width: 200 }}>{t("evx_col_event")}</th>
                  <th style={{ width: 120 }}>{t("evx_col_source")}</th>
                  <th>{modeColumn(mode, t)}</th>
                  <th style={{ width: 80 }}>{t("evx_col_status")}</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((r) => (
                  <Row
                    key={r.id}
                    row={r}
                    mode={mode}
                    t={t}
                    active={selected?.id === r.id}
                    onClick={() => setSelected((s) => (s?.id === r.id ? null : r))}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {selected && (
            <DetailPane row={selected} onClose={() => setSelected(null)} mode={mode} onActioned={refresh} t={t} />
          )}
        </div>
      )}
    </div>
  );
}

function modeColumn(mode: Mode, t: (k: string) => string): string {
  switch (mode) {
    case "dlq":
      return t("evx_col_fail_reason");
    case "rejected":
      return t("evx_col_reject_reason");
    case "causality":
      return t("evx_col_upstream_event");
    default:
      return "external_event_id";
  }
}

function EmptyForMode({ mode, hasFilter, t }: { mode: Mode; hasFilter: boolean; t: (k: string) => string }) {
  if (hasFilter) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState title={t("evx_empty_no_match")} hint={t("evx_empty_no_match_hint")} />
      </div>
    );
  }
  switch (mode) {
    case "dlq":
      return (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.alert />}
            title={t("evx_empty_dlq_title")}
            hint={t("evx_empty_dlq_hint")}
            variant="info"
          />
        </div>
      );
    case "rejected":
      return (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.cross />}
            title={t("evx_empty_rejected_title")}
            hint={t("evx_empty_rejected_hint")}
          />
        </div>
      );
    case "instances":
      return (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.search />}
            title={t("evx_empty_instances_title")}
            hint={t("evx_empty_instances_hint")}
            variant="info"
          />
        </div>
      );
    case "causality":
      return (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.branch />}
            title={t("evx_empty_causality_title")}
            hint={t("evx_empty_causality_hint")}
            variant="info"
          />
        </div>
      );
  }
}

function Row({
  row,
  mode,
  t,
  active,
  onClick,
}: {
  row: EventInstanceRow;
  mode: Mode;
  t: (k: string) => string;
  active: boolean;
  onClick: () => void;
}) {
  const ts = new Date(row.ts);
  const time = `${ts.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} ${ts.toLocaleTimeString(undefined, { hour12: false })}`;
  const colCell =
    mode === "dlq" || mode === "rejected"
      ? row.rejectionReason
      : mode === "causality"
        ? row.causedByName ?? "—"
        : row.externalEventId ?? "—";
  return (
    <tr
      onClick={onClick}
      style={{
        cursor: "pointer",
        background: active ? "var(--c-accent-bg)" : undefined,
      }}
    >
      <td className="mono text-[11px] text-ink-2">{time}</td>
      <td className="mono text-[11.5px] text-ink-1">{row.name}</td>
      <td className="text-[11.5px] text-ink-3">{row.source}</td>
      <td className="text-[11.5px] mono text-ink-2 truncate">{colCell}</td>
      <td>
        <StatusBadge status={row.status} t={t} />
      </td>
    </tr>
  );
}

function StatusBadge({ status, t }: { status: string; t: (k: string) => string }) {
  const map: Record<
    string,
    { variant: "ok" | "warn" | "err" | "info" | "default"; label: string }
  > = {
    accepted: { variant: "ok", label: "accepted" },
    rejected_schema: { variant: "err", label: t("evx_status_schema_fail") },
    rejected_filter: { variant: "warn", label: t("evx_status_filter_reject") },
    duplicate: { variant: "info", label: "duplicate" },
    meta_rejection: { variant: "warn", label: "meta-rejection" },
    em_degraded: { variant: "warn", label: "em degraded" },
  };
  const m = map[status] ?? { variant: "default" as const, label: status };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

function DetailPane({
  row,
  onClose,
  mode,
  onActioned,
  t,
}: {
  row: EventInstanceRow;
  onClose: () => void;
  mode: Mode;
  onActioned: () => void;
  t: (k: string) => string;
}) {
  const [busy, setBusy] = React.useState<"replay" | "discard" | null>(null);
  const [actionMsg, setActionMsg] = React.useState<string | null>(null);

  const replay = async () => {
    setBusy("replay");
    setActionMsg(null);
    try {
      const r = await fetch(`/api/em/event-instances/${row.id}/replay`, {
        method: "POST",
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setActionMsg(t("evx_replay_done"));
        onActioned();
      } else {
        setActionMsg(`${t("evx_replay_failed")}${j.message ?? r.statusText}`);
      }
    } catch (e) {
      setActionMsg(`${t("evx_replay_failed")}${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="border-l border-line bg-surface flex flex-col min-h-0 overflow-auto">
      <div className="border-b border-line p-3 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="mono text-[12px] font-semibold text-ink-1 break-all">{row.name}</div>
          <div className="mono text-[10.5px] text-ink-3 mt-1">id {row.id.slice(0, 8)}…</div>
        </div>
        <a
          href={`/events/${encodeURIComponent(row.name)}/instances/${encodeURIComponent(row.id)}`}
          className="text-ink-3 hover:text-ink-1 text-[10.5px] mr-1 no-underline"
          title={t("evx_open_full_trail")}
        >
          ↗
        </a>
        <button onClick={onClose} className="text-ink-3 hover:text-ink-1 bg-transparent border-0 cursor-pointer text-[14px]">×</button>
      </div>

      <Section label={t("evx_section_status")}>
        <StatusBadge status={row.status} t={t} />
        {row.schemaVersionUsed && (
          <span className="mono text-[10.5px] text-ink-3 ml-2">v{row.schemaVersionUsed}</span>
        )}
      </Section>

      {row.rejectionReason && (
        <Section label={t("evx_section_reason")}>
          <div className="text-[11.5px] text-ink-2 leading-relaxed">{row.rejectionReason}</div>
          {row.triedVersions && row.triedVersions.length > 0 && (
            <div className="mono text-[10.5px] text-ink-4 mt-2">{t("evx_tried_versions")}{row.triedVersions.join(", ")}</div>
          )}
        </Section>
      )}

      {Array.isArray(row.schemaErrors) && row.schemaErrors.length > 0 && (
        <Section label={t("evx_section_schema_errors")}>
          <ul className="text-[10.5px] mono text-ink-2 leading-relaxed">
            {(row.schemaErrors as Array<{ path: string; code: string; message: string }>).slice(0, 10).map((e, i) => (
              <li key={i}>
                <span className="text-ink-3">{e.path || "(root)"}</span> · {e.message}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {row.externalEventId && (
        <Section label="external_event_id">
          <span className="mono text-[10.5px] text-ink-2 break-all">{row.externalEventId}</span>
        </Section>
      )}

      {row.causedByEventId && (
        <Section label={t("evx_section_upstream")}>
          <a
            href={`/events?subtab=causality&causedByEventId=${encodeURIComponent(row.causedByEventId)}`}
            className="mono text-[10.5px] text-ink-2 break-all no-underline hover:text-ink-1"
          >
            {row.causedByName ?? t("evx_event_fallback")} · {row.causedByEventId.slice(0, 8)}…
          </a>
        </Section>
      )}

      {row.payloadSummary && (
        <Section label={t("evx_section_payload_summary")}>
          <pre
            className="mono text-[10px] text-ink-2 bg-panel border border-line rounded-sm overflow-auto"
            style={{ padding: 8, margin: 0, maxHeight: 220 }}
          >
            {prettyJson(row.payloadSummary)}
          </pre>
        </Section>
      )}

      {mode === "dlq" && (
        <div className="border-t border-line p-3 flex flex-col gap-2 mt-auto">
          <Btn size="sm" disabled={busy === "replay"} onClick={replay}>
            <Ic.play /> {busy === "replay" ? t("evx_replaying") : t("evx_replay")}
          </Btn>
          {actionMsg && (
            <div className="text-[10.5px] text-ink-3">{actionMsg}</div>
          )}
        </div>
      )}
    </aside>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line p-3">
      <div className="hint mb-1">{label}</div>
      {children}
    </div>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
