"use client";
import React from "react";
import Link from "next/link";
import clsx from "clsx";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";
import type { AgentDraftRow, AgentDraftsResponse, DraftLifecycle } from "@/lib/ontology-generator/types";

// 部署智能体 — the Fleet draft store. A right-side drawer holding the ontology-
// generated SHELL agents (across business domains): drafts to deploy, and
// deployed shells to bring online / offline / send back to draft. Everything
// here is sandboxed (capturedFrom='ontology-gen'); it never affects the real
// production agents.
export function DraftStorePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, lang } = useApp();
  const { getById, domain } = useDomain();
  const [rows, setRows] = React.useState<AgentDraftRow[] | null>(null);
  const [recycled, setRecycled] = React.useState<AgentDraftRow[]>([]);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  // Bulk selection: a single set of row ids spanning the drafts + recycle-bin
  // sections (ids are globally unique). Each section toggles/acts on its own
  // ids, so deploy/delete (drafts) and restore (recycle bin) never cross over.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);

  // Scoped to the active business domain — switching domains shows that
  // domain's agents. Loads both the live set and the recycle bin (archived).
  // Any selection is cleared on (re)load: ids may have moved sections or be gone.
  const load = React.useCallback(async () => {
    const d = encodeURIComponent(domain);
    try {
      const [live, bin] = await Promise.all([
        fetch(`/api/agent-drafts?domain=${d}`, { cache: "no-store" }).then((r) => r.json() as Promise<AgentDraftsResponse>),
        fetch(`/api/agent-drafts?domain=${d}&recycled=1`, { cache: "no-store" }).then((r) => r.json() as Promise<AgentDraftsResponse>),
      ]);
      setRows(live.rows ?? []);
      setRecycled(bin.rows ?? []);
    } catch {
      setRows([]);
      setRecycled([]);
    } finally {
      setSelected(new Set());
    }
  }, [domain]);

  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Raw fetch helpers (no reload) — shared by the single-row and bulk actions.
  const transitionRaw = (id: string, to: DraftLifecycle) =>
    fetch(`/api/agent-drafts/${encodeURIComponent(id)}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    });
  const deleteRaw = (id: string) => fetch(`/api/agent-drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
  const restoreRaw = (id: string) => fetch(`/api/agent-drafts/${encodeURIComponent(id)}/restore`, { method: "POST" });

  async function transition(row: AgentDraftRow, to: DraftLifecycle) {
    setBusyId(row.id);
    try {
      await transitionRaw(row.id, to);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: AgentDraftRow) {
    if (!window.confirm(t("dst_delete_confirm").replace("{name}", lang === "zh" ? row.nameZh : row.nameEn))) {
      return;
    }
    setBusyId(row.id);
    try {
      await deleteRaw(row.id);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function restore(row: AgentDraftRow) {
    setBusyId(row.id);
    try {
      await restoreRaw(row.id);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  // Selection helpers.
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  // Bulk actions — fire all requests, then a single reload (which clears selection).
  async function runBulk(ids: string[], op: (id: string) => Promise<Response>) {
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all(ids.map(op));
      await load();
    } finally {
      setBulkBusy(false);
    }
  }
  const bulkTransition = (ids: string[], to: DraftLifecycle) => runBulk(ids, (id) => transitionRaw(id, to));
  const bulkDeploy = (ids: string[]) => bulkTransition(ids, "active");
  const bulkRestore = (ids: string[]) => runBulk(ids, restoreRaw);
  async function bulkDelete(ids: string[]) {
    if (ids.length === 0) return;
    if (!window.confirm(t("dst_bulk_delete_confirm").replace("{n}", String(ids.length)))) return;
    await runBulk(ids, deleteRaw);
  }

  if (!open) return null;

  const drafts = (rows ?? []).filter((r) => r.status === "draft");
  const deployed = (rows ?? []).filter((r) => r.status === "active" || r.status === "offline");
  const nameOf = (r: AgentDraftRow) => (lang === "zh" ? r.nameZh : r.nameEn);
  // Resolve the business-domain display name from the app domain system so the
  // drawer stays in sync with the AppBar switcher (falls back to the raw id).
  const domainName = (id: string) => getById(id)?.name ?? id;

  const draftIds = drafts.map((r) => r.id);
  const deployedIds = deployed.map((r) => r.id);
  const recycledIds = recycled.map((r) => r.id);
  const selDraftIds = draftIds.filter((id) => selected.has(id));
  const selDeployedIds = deployedIds.filter((id) => selected.has(id));
  const selRecycledIds = recycledIds.filter((id) => selected.has(id));

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: "color-mix(in oklab, var(--c-ink-1) 32%, transparent)" }} aria-hidden />
      <aside
        className="relative h-full w-full max-w-[460px] bg-surface border-l border-line shadow-sh-3 flex flex-col og-card-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-line">
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold text-ink-1">{t("dst_title")}</div>
            <div className="text-[12px] text-ink-3 mt-0.5">{t("dst_subtitle")}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-none w-7 h-7 grid place-items-center rounded-md text-ink-3 hover:bg-panel hover:text-ink-1"
            aria-label={t("flx_close")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {rows === null ? (
            <div className="text-[12px] text-ink-4 text-center py-10">…</div>
          ) : (
            <>
              {/* Drafts (草稿) */}
              <section>
                <SectionHead text={t("dst_section_drafts")} count={drafts.length} ids={draftIds} selected={selected} onToggleAll={toggleAll} t={t} />
                {drafts.length === 0 ? (
                  <EmptyHint text={t("dst_drafts_empty")} />
                ) : (
                  <>
                    {selDraftIds.length > 0 && (
                      <BulkBar count={selDraftIds.length} onClear={() => toggleAll(draftIds, false)} t={t}>
                        <ActionBtn kind="primary" busy={bulkBusy} onClick={() => bulkDeploy(selDraftIds)} label={t("dst_bulk_deploy")} />
                        <ActionBtn kind="danger" busy={bulkBusy} onClick={() => bulkDelete(selDraftIds)} label={t("dst_bulk_delete")} />
                      </BulkBar>
                    )}
                    <div className="flex flex-col gap-2.5 mt-2">
                      {drafts.map((r) => (
                        <ShellCard
                          key={r.id}
                          row={r}
                          name={nameOf(r)}
                          domainName={domainName(r.domain)}
                          t={t}
                          selected={selected.has(r.id)}
                          onToggleSelect={() => toggleOne(r.id)}
                        >
                          <ActionBtn kind="primary" busy={busyId === r.id || bulkBusy} onClick={() => transition(r, "active")} label={t("dst_deploy")} />
                          <ActionBtn kind="danger" busy={busyId === r.id || bulkBusy} onClick={() => remove(r)} label={t("dst_delete")} />
                        </ShellCard>
                      ))}
                    </div>
                  </>
                )}
              </section>

              {/* Deployed (已部署) */}
              <section>
                <SectionHead text={t("dst_section_deployed")} count={deployed.length} ids={deployedIds} selected={selected} onToggleAll={toggleAll} t={t} />
                {deployed.length === 0 ? (
                  <EmptyHint text={t("dst_deployed_empty")} />
                ) : (
                  <>
                    {selDeployedIds.length > 0 && (
                      <BulkBar count={selDeployedIds.length} onClear={() => toggleAll(deployedIds, false)} t={t}>
                        <ActionBtn kind="primary" busy={bulkBusy} onClick={() => bulkTransition(selDeployedIds, "active")} label={t("dst_bulk_online")} />
                        <ActionBtn busy={bulkBusy} onClick={() => bulkTransition(selDeployedIds, "offline")} label={t("dst_bulk_offline")} />
                        <ActionBtn busy={bulkBusy} onClick={() => bulkTransition(selDeployedIds, "draft")} label={t("dst_bulk_to_draft")} />
                        <ActionBtn kind="danger" busy={bulkBusy} onClick={() => bulkDelete(selDeployedIds)} label={t("dst_bulk_delete")} />
                      </BulkBar>
                    )}
                    <div className="flex flex-col gap-2.5 mt-2">
                      {deployed.map((r) => (
                        <ShellCard
                          key={r.id}
                          row={r}
                          name={nameOf(r)}
                          domainName={domainName(r.domain)}
                          t={t}
                          selected={selected.has(r.id)}
                          onToggleSelect={() => toggleOne(r.id)}
                          badge={<StatusBadge online={r.status === "active"} t={t} />}
                        >
                          {r.status === "active" ? (
                            <ActionBtn busy={busyId === r.id || bulkBusy} onClick={() => transition(r, "offline")} label={t("dst_offline")} />
                          ) : (
                            <ActionBtn kind="primary" busy={busyId === r.id || bulkBusy} onClick={() => transition(r, "active")} label={t("dst_online")} />
                          )}
                          <ActionBtn busy={busyId === r.id || bulkBusy} onClick={() => transition(r, "draft")} label={t("dst_to_draft")} />
                        </ShellCard>
                      ))}
                    </div>
                  </>
                )}
              </section>

              {/* Recycle bin (回收站) — soft-deleted agents, restorable */}
              {recycled.length > 0 && (
                <section>
                  <SectionHead text={t("dst_section_recycled")} count={recycled.length} ids={recycledIds} selected={selected} onToggleAll={toggleAll} t={t} />
                  {selRecycledIds.length > 0 && (
                    <BulkBar count={selRecycledIds.length} onClear={() => toggleAll(recycledIds, false)} t={t}>
                      <ActionBtn kind="primary" busy={bulkBusy} onClick={() => bulkRestore(selRecycledIds)} label={t("dst_bulk_restore")} />
                    </BulkBar>
                  )}
                  <div className="flex flex-col gap-2.5 mt-2">
                    {recycled.map((r) => (
                      <ShellCard
                        key={r.id}
                        row={r}
                        name={nameOf(r)}
                        domainName={domainName(r.domain)}
                        t={t}
                        selected={selected.has(r.id)}
                        onToggleSelect={() => toggleOne(r.id)}
                        badge={
                          <span className="text-[11px] px-2 py-0.5 rounded-full text-ink-4 bg-panel border border-line">
                            {t("dst_archived")}
                          </span>
                        }
                      >
                        <ActionBtn kind="primary" busy={busyId === r.id || bulkBusy} onClick={() => restore(r)} label={t("dst_restore")} />
                      </ShellCard>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-line flex items-center justify-between gap-3">
          <span className="text-[11px] text-ink-4">{t("dst_footer_hint")}</span>
          <Link
            href="/behavior/ontology-generator"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium text-white"
            style={{ background: "var(--c-accent)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="3.2" /></svg>
            {t("dst_generate_more")}
          </Link>
        </div>
      </aside>
    </div>
  );
}

// Section header with a count and a select-all toggle for its rows.
function SectionHead({
  text,
  count,
  ids,
  selected,
  onToggleAll,
  t,
}: {
  text: string;
  count: number;
  ids: string[];
  selected: Set<string>;
  onToggleAll: (ids: string[], on: boolean) => void;
  t: (k: string) => string;
}) {
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const some = !all && ids.some((id) => selected.has(id));
  return (
    <div className="flex items-center gap-2">
      <SectionLabel text={text} count={count} />
      {ids.length > 0 && (
        <button
          type="button"
          onClick={() => onToggleAll(ids, !all)}
          className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-ink-3 hover:text-ink-1"
        >
          <CheckMark checked={all} indeterminate={some} />
          {t(all ? "dst_deselect_all" : "dst_select_all")}
        </button>
      )}
    </div>
  );
}

// Bulk-action toolbar shown above a section's list when ≥1 row is selected.
function BulkBar({
  count,
  onClear,
  t,
  children,
}: {
  count: number;
  onClear: () => void;
  t: (k: string) => string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel/60 px-2.5 py-1.5">
      <span className="text-[11px] text-ink-3 mr-auto">{t("dst_selected_n").replace("{n}", String(count))}</span>
      {children}
      <button type="button" onClick={onClear} className="h-7 px-2 rounded-md text-[12px] text-ink-3 hover:text-ink-1">
        {t("dst_deselect_all")}
      </button>
    </div>
  );
}

function SectionLabel({ text, count }: { text: string; count: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-ink-4 font-semibold">
      {text}
      <span className="mono text-ink-3 normal-case tracking-normal px-1.5 rounded border border-line">{count}</span>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="mt-2 text-[12px] text-ink-4 rounded-lg border border-dashed border-line px-3 py-4 text-center">{text}</div>;
}

// Presentational checkbox glyph (non-interactive — wrap in a button to make it clickable).
function CheckMark({ checked, indeterminate }: { checked: boolean; indeterminate?: boolean }) {
  return (
    <span
      className="flex-none w-[18px] h-[18px] rounded-[5px] border grid place-items-center transition-colors"
      style={
        checked || indeterminate
          ? { background: "var(--c-accent)", borderColor: "var(--c-accent)" }
          : { borderColor: "var(--c-line)" }
      }
    >
      {checked ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
      ) : indeterminate ? (
        <span className="w-2 h-[2px] rounded-full bg-white" />
      ) : null}
    </span>
  );
}

function StatusBadge({ online, t }: { online: boolean; t: (k: string) => string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10.5px] px-2 py-0.5 rounded-full border"
      style={
        online
          ? { color: "var(--c-ok)", background: "var(--c-ok-bg)", borderColor: "color-mix(in oklab, var(--c-ok) 25%, transparent)" }
          : { color: "var(--c-ink-3)", borderColor: "var(--c-line)" }
      }
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: online ? "var(--c-ok)" : "var(--c-ink-4)" }} />
      {online ? t("dst_status_online") : t("dst_status_offline")}
    </span>
  );
}

function ShellCard({
  row,
  name,
  domainName,
  t,
  badge,
  children,
  selected,
  onToggleSelect,
}: {
  row: AgentDraftRow;
  name: string;
  domainName: string;
  t: (k: string) => string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const selectable = !!onToggleSelect;
  return (
    <div className={clsx("rounded-xl border p-3 transition-colors", selected ? "border-accent bg-accent-bg" : "border-line bg-panel/40")}>
      <div className="flex items-start gap-3">
        {selectable && (
          <button
            type="button"
            role="checkbox"
            aria-checked={!!selected}
            onClick={onToggleSelect}
            className="flex-none mt-0.5"
            aria-label={t(selected ? "dst_deselect_all" : "dst_select_all")}
          >
            <CheckMark checked={!!selected} />
          </button>
        )}
        <div className="flex-none w-9 h-9 rounded-lg grid place-items-center text-[14px] font-semibold text-white" style={{ background: row.iconColor }}>
          {row.iconChar}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-ink-1 truncate">{name}</span>
            {badge}
            <span className="ml-auto flex-none text-[10px] px-1.5 py-0.5 rounded border border-line text-ink-4">{domainName}</span>
          </div>
          <div className="mono text-[10.5px] text-ink-4 truncate mt-0.5">{row.agentId}</div>
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            <span className="mono text-[10px] px-1.5 py-0.5 rounded bg-surface border border-line text-ink-2">{row.triggerEvent}</span>
            <span className="text-ink-4 text-[10px]">→</span>
            <span className="mono text-[10px] px-1.5 py-0.5 rounded bg-surface border border-line text-ink-2">{row.emitEvent}</span>
            <span className="ml-auto text-[10.5px] font-medium" style={{ color: row.confidence >= 90 ? "var(--c-ok)" : "oklch(0.6 0.14 75)" }}>
              {t("og_confidence_short").replace("{n}", String(row.confidence))}
            </span>
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-end gap-2">{children}</div>
    </div>
  );
}

function ActionBtn({
  label,
  onClick,
  busy,
  kind = "default",
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  kind?: "default" | "primary" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={clsx(
        "h-7 px-3 rounded-md text-[12px] font-medium transition-colors disabled:opacity-50",
        kind === "primary"
          ? "text-white"
          : kind === "danger"
            ? "bg-surface border hover:bg-panel"
            : "bg-surface border border-line text-ink-2 hover:bg-panel",
      )}
      style={
        kind === "primary"
          ? { background: "var(--c-accent)" }
          : kind === "danger"
            ? { borderColor: "var(--c-bad, oklch(0.6 0.2 25))", color: "var(--c-bad, oklch(0.6 0.2 25))" }
            : undefined
      }
    >
      {busy ? "…" : label}
    </button>
  );
}
