"use client";
import React from "react";
import { usePoll } from "@/lib/monitor/usePoll";
import { InstanceCard } from "./InstanceCard";
import { ClaudeChip, ClaudeBadge, ClaudeButton } from "./atoms";
import { useApp } from "@/lib/i18n";
import { formatRelativeTime, statusLabel } from "./i18n-utils";
import type { InstanceCard as InstanceCardType, MonitorInstancesResponse } from "@/lib/monitor/types";

// ── Batch action types ──────────────────────────────────────────────────────

type BatchAction = "cancel" | "pause" | "resume";

// ── BatchActionButton ───────────────────────────────────────────────────────

function BatchActionButton({
  action,
  runIds,
  onComplete,
}: {
  action: BatchAction;
  runIds: string[];
  onComplete: () => void;
}) {
  const { t } = useApp();
  const [confirming, setConfirming] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  const labelKey = `monitor_batch_${action}_all` as const;
  const actionLabel =
    action === "cancel" ? t("manage_action_cancel")
    : action === "pause" ? t("manage_action_pause")
    : t("manage_action_resume");

  const handleConfirm = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/manage/runs/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, runIds, reason: reason.trim() || undefined }),
      });
      const json = (await res.json()) as { results?: { runId: string; ok: boolean }[] };
      const results = json.results ?? [];
      const ok = results.filter((r) => r.ok).length;
      const fail = results.filter((r) => !r.ok).length;
      const msg = t("monitor_batch_success")
        .replace("{ok}", String(ok))
        .replace("{fail}", String(fail));
      setToast(msg);
      setTimeout(() => setToast(null), 3000);
      onComplete();
    } catch {
      setToast("Error calling batch API");
      setTimeout(() => setToast(null), 3000);
    } finally {
      setLoading(false);
      setConfirming(false);
      setReason("");
    }
  };

  return (
    <>
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 px-4 py-2 rounded-[8px] bg-claude-accent text-white text-[13px] shadow-lg">
          {toast}
        </div>
      )}

      {confirming && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/30"
          onClick={() => setConfirming(false)}
        >
          <div
            className="bg-claude-surface border border-claude-line rounded-[12px] p-5 shadow-xl w-[360px]"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[14px] text-claude-ink-1 font-medium mb-3">
              {t("monitor_batch_confirm")
                .replace("{n}", String(runIds.length))
                .replace("{action}", actionLabel)}
            </p>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("manage_reason_placeholder")}
              className="w-full border border-claude-line rounded-[6px] px-3 py-1.5 text-[12.5px] bg-claude-surface text-claude-ink-1 focus:outline-none mb-3"
            />
            <div className="flex justify-end gap-2">
              <ClaudeButton size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                {t("manage_cancel_btn")}
              </ClaudeButton>
              <ClaudeButton size="sm" variant="primary" onClick={handleConfirm} disabled={loading}>
                {loading ? "…" : t("manage_confirm_btn")}
              </ClaudeButton>
            </div>
          </div>
        </div>
      )}

      <ClaudeButton size="sm" onClick={() => setConfirming(true)}>
        {t(labelKey)}
      </ClaudeButton>
    </>
  );
}

// ── Group-by logic ─────────────────────────────────────────────────

type GroupBy = 'status' | 'trigger' | 'client' | 'candidate' | 'jd';

const STATUS_ORDER = ['running', 'paused', 'suspended', 'failed', 'completed'];

function groupItems(
  items: InstanceCardType[],
  groupBy: GroupBy,
  t: (key: string) => string,
): Array<{ label: string; cards: InstanceCardType[] }> {
  const map = new Map<string, InstanceCardType[]>();

  for (const card of items) {
    let key: string;
    if (groupBy === 'status') key = card.status;
    else if (groupBy === 'trigger') key = card.triggerEvent;
    else if (groupBy === 'candidate') key = card.candidateName ?? card.candidateId ?? t('status_unknown');
    else if (groupBy === 'jd') key = card.jdTitle ?? card.jdId ?? t('status_unknown');
    else key = card.client ?? t('status_unknown');

    const list = map.get(key) ?? [];
    list.push(card);
    map.set(key, list);
  }

  // Sort groups: status uses canonical order; others alphabetical
  let keys: string[];
  if (groupBy === 'status') {
    keys = STATUS_ORDER.filter((s) => map.has(s));
    // append any unexpected statuses at the end
    for (const k of map.keys()) {
      if (!keys.includes(k)) keys.push(k);
    }
  } else {
    keys = Array.from(map.keys()).sort((a, b) => a.localeCompare(b));
  }

  return keys.map((k) => ({
    label: groupBy === 'status' ? statusLabel(k, t) : k,
    cards: map.get(k)!,
  }));
}

// For candidate/jd groups: collect distinct trigger events in the group
function groupTriggers(cards: InstanceCardType[]): string[] {
  const seen = new Set<string>();
  for (const c of cards) seen.add(c.triggerEvent);
  return Array.from(seen);
}

// Most recent activity timestamp in the group
function groupLatestActivity(cards: InstanceCardType[]): string | null {
  let latest: string | null = null;
  for (const c of cards) {
    if (!latest || c.lastActivityAt > latest) latest = c.lastActivityAt;
  }
  return latest;
}

// ── Component ──────────────────────────────────────────────────────

export function InstanceCardsSection({
  paused = false,
  searchQuery = '',
  compact = false,
}: {
  paused?: boolean;
  searchQuery?: string;
  /** When true, shows top cards in a horizontal scroll strip instead of the full 3-col grid. */
  compact?: boolean;
}) {
  const { t, lang } = useApp();
  const [scope, setScope] = React.useState<'live' | 'recent'>('live');
  const [groupBy, setGroupBy] = React.useState<GroupBy>('status');
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const apiUrl = `/api/monitor/instances?scope=${scope}&limit=60`;
  const { data, error, refresh } = usePoll<MonitorInstancesResponse>(
    apiUrl,
    6_000,
    paused,
  );

  // Filter items by search query
  const allItems: InstanceCardType[] = data?.items ?? [];
  const filteredItems = React.useMemo(() => {
    if (!searchQuery.trim()) return allItems;
    const q = searchQuery.toLowerCase().trim();
    return allItems.filter(c =>
      c.runId.toLowerCase().includes(q) ||
      c.triggerEvent.toLowerCase().includes(q) ||
      (c.client?.toLowerCase().includes(q)) ||
      (c.jdTitle?.toLowerCase().includes(q)) ||
      (c.jdId?.toLowerCase().includes(q)) ||
      (c.candidateName?.toLowerCase().includes(q)) ||
      (c.candidateId?.toLowerCase().includes(q)) ||
      (c.resumeId?.toLowerCase().includes(q)) ||
      (c.currentAgent?.toLowerCase().includes(q))
    );
  }, [allItems, searchQuery]);

  // In compact mode: flatten all items, take top 6, show as horizontal scroll
  const compactItems = React.useMemo(() => filteredItems.slice(0, 6), [filteredItems]);

  const groups = React.useMemo(() => groupItems(filteredItems, groupBy, t), [filteredItems, groupBy, t]);
  const total = data?.total ?? 0;
  const isFiltered = searchQuery.trim().length > 0;

  const showEntityBadges = groupBy === 'candidate' || groupBy === 'jd';

  // In compact mode render a minimal horizontal strip with no controls
  if (compact) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="flex items-center justify-between mb-2 flex-shrink-0">
          <h2 className="text-[12px] font-medium text-claude-ink-2 uppercase tracking-[0.08em]">
            {t("monitor_instances_title")}
          </h2>
          {total > 0 && (
            <ClaudeBadge tone={scope === 'live' ? 'accent' : 'neutral'} size="xs">
              {total}
            </ClaudeBadge>
          )}
        </div>
        {error && (
          <p className="text-claude-err text-[11px] mb-1 flex-shrink-0">{t('monitor_polling_error')} {error}</p>
        )}
        {compactItems.length === 0 ? (
          <div className="text-claude-ink-4 text-[12px] py-4 text-center flex-1">
            {scope === 'live' ? t('monitor_empty_live_instances') : t('monitor_empty_recent_runs')}
          </div>
        ) : (
          <div className="flex gap-2 overflow-x-auto flex-1 pb-1">
            {compactItems.map((card) => (
              <div key={card.runId} className="min-w-[180px] max-w-[200px] flex-shrink-0">
                <InstanceCard card={card} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mb-6">
      {/* Batch action bar */}
      {selectedIds.size > 0 && (
        <div className="sticky top-0 z-10 mb-3 rounded-[10px] border border-claude-line bg-claude-accent-bg p-3 flex items-center gap-3 flex-wrap">
          <span className="text-[13px] font-medium text-claude-accent">
            {t("monitor_batch_selected").replace("{n}", String(selectedIds.size))}
          </span>
          <BatchActionButton action="cancel" runIds={Array.from(selectedIds)} onComplete={clearSelection} />
          <BatchActionButton action="pause"  runIds={Array.from(selectedIds)} onComplete={clearSelection} />
          <BatchActionButton action="resume" runIds={Array.from(selectedIds)} onComplete={clearSelection} />
          <ClaudeButton variant="ghost" size="sm" onClick={clearSelection}>{t("monitor_batch_clear")}</ClaudeButton>
        </div>
      )}

      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-medium text-claude-ink-2">{t("monitor_instances_title")}</h2>
          {total > 0 && (
            <ClaudeBadge tone={scope === 'live' ? 'accent' : 'neutral'} size="xs">
              {total} {scope === 'live' ? t("monitor_instances_live").toLowerCase() : t("monitor_instances_recent").toLowerCase()}
            </ClaudeBadge>
          )}
        </div>
        <button
          type="button"
          onClick={refresh}
          title={t('monitor_refresh_now')}
          className="text-claude-ink-4 hover:text-claude-ink-2 transition-colors text-[14px] leading-none"
        >
          ↺
        </button>
      </div>

      {/* Tabs + group-by */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          <ClaudeChip active={scope === 'live'} onClick={() => setScope('live')}>
            {t("monitor_instances_live")} {data?.scope === 'live' ? `(${total})` : ''}
          </ClaudeChip>
          <ClaudeChip active={scope === 'recent'} onClick={() => setScope('recent')}>
            {t("monitor_instances_recent")} {data?.scope === 'recent' ? `(${total})` : ''}
          </ClaudeChip>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11.5px] text-claude-ink-4">{t("monitor_instances_group_by")}</span>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            className="text-[12px] border border-claude-line rounded-[6px] px-2 py-0.5 bg-claude-surface text-claude-ink-2 focus:outline-none"
          >
            <option value="status">{t("monitor_instances_group_status")}</option>
            <option value="trigger">{t("monitor_instances_group_trigger")}</option>
            <option value="client">{t("monitor_instances_group_client")}</option>
            <option value="candidate">{t("monitor_instances_group_candidate")}</option>
            <option value="jd">{t("monitor_instances_group_jd")}</option>
          </select>
        </div>
      </div>

      {/* Filtered indicator */}
      {isFiltered && (
        <div className="text-[12px] text-claude-ink-3 mb-3 flex items-center gap-2">
          <span>
            {t("monitor_instances_filtered")}: {filteredItems.length} {t("monitor_instances_of")} {allItems.length}
          </span>
          <button
            type="button"
            onClick={() => {/* caller controls search state */}}
            className="text-claude-accent underline text-[12px]"
            // The parent controls searchQuery — clear is done by clearing the input above
            // We emit nothing here since MonitorContent owns the state
          >
          </button>
        </div>
      )}

      {error && (
        <p className="text-claude-err text-[12px] mb-3">
          {t('monitor_polling_error')} {error}
        </p>
      )}

      {/* Empty state */}
      {allItems.length === 0 && !error && (
        <div className="text-claude-ink-4 text-[13px] py-8 text-center border border-dashed border-claude-line rounded-[10px]">
          {scope === 'live'
            ? t('monitor_empty_live_instances_cta')
            : t('monitor_empty_recent_runs_hour')}
        </div>
      )}

      {/* Filtered empty state */}
      {allItems.length > 0 && filteredItems.length === 0 && (
        <div className="text-claude-ink-4 text-[13px] py-8 text-center border border-dashed border-claude-line rounded-[10px]">
          {t('monitor_empty_no_match').replace('{q}', searchQuery)}
        </div>
      )}

      {/* Groups */}
      {groups.map((group) => {
        const triggers = showEntityBadges ? groupTriggers(group.cards) : [];
        const latestAt = showEntityBadges ? groupLatestActivity(group.cards) : null;
        return (
          <div key={group.label} className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <div className="text-[11px] uppercase tracking-[0.12em] text-claude-ink-4 font-medium">
                {group.label.toUpperCase()}
              </div>
              {showEntityBadges && (
                <>
                  <ClaudeBadge tone="accent" size="xs">
                    {group.cards.length} {t("monitor_instances_in_flight")}
                  </ClaudeBadge>
                  {latestAt && (
                    <span className="text-[10.5px] text-claude-ink-4">{formatRelativeTime(latestAt, lang, false)}</span>
                  )}
                  {triggers.map(ev => (
                    <ClaudeBadge key={ev} tone="neutral" size="xs">{ev}</ClaudeBadge>
                  ))}
                </>
              )}
              {!showEntityBadges && (
                <span className="text-[11px] text-claude-ink-4">· {group.cards.length}</span>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {group.cards.map((card) => (
                <InstanceCard
                  key={card.runId}
                  card={card}
                  selected={selectedIds.has(card.runId)}
                  onToggleSelect={() => toggle(card.runId)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
