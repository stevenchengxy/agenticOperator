"use client";
import React from "react";
import { usePoll } from "@/lib/monitor/usePoll";
import { InstanceCard } from "./InstanceCard";
import { ClaudeChip, ClaudeBadge } from "./atoms";
import type { InstanceCard as InstanceCardType, MonitorInstancesResponse } from "@/lib/monitor/types";

// ── Group-by logic ─────────────────────────────────────────────────

type GroupBy = 'status' | 'trigger' | 'client';

const STATUS_ORDER = ['running', 'paused', 'suspended', 'failed', 'completed'];

function groupItems(
  items: InstanceCardType[],
  groupBy: GroupBy,
): Array<{ label: string; cards: InstanceCardType[] }> {
  const map = new Map<string, InstanceCardType[]>();

  for (const card of items) {
    let key: string;
    if (groupBy === 'status') key = card.status;
    else if (groupBy === 'trigger') key = card.triggerEvent;
    else key = card.client ?? 'Unknown';

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
    label: `${k.toUpperCase()} · ${map.get(k)!.length}`,
    cards: map.get(k)!,
  }));
}

// ── Component ──────────────────────────────────────────────────────

export function InstanceCardsSection({ paused = false }: { paused?: boolean }) {
  const [scope, setScope] = React.useState<'live' | 'recent'>('live');
  const [groupBy, setGroupBy] = React.useState<GroupBy>('status');

  const apiUrl = `/api/monitor/instances?scope=${scope}&limit=60`;
  const { data, error, refresh } = usePoll<MonitorInstancesResponse>(
    apiUrl,
    6_000,
    paused,
  );

  const items: InstanceCardType[] = data?.items ?? [];
  const groups = React.useMemo(() => groupItems(items, groupBy), [items, groupBy]);
  const total = data?.total ?? 0;

  return (
    <div className="mb-6">
      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-medium text-claude-ink-2">Live instances</h2>
          {total > 0 && (
            <ClaudeBadge tone={scope === 'live' ? 'accent' : 'neutral'} size="xs">
              {total} {scope === 'live' ? 'active' : 'recent'}
            </ClaudeBadge>
          )}
        </div>
        <button
          type="button"
          onClick={refresh}
          title="Refresh now"
          className="text-claude-ink-4 hover:text-claude-ink-2 transition-colors text-[14px] leading-none"
        >
          ↺
        </button>
      </div>

      {/* Tabs + group-by */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          <ClaudeChip active={scope === 'live'} onClick={() => setScope('live')}>
            Live {data?.scope === 'live' ? `(${total})` : ''}
          </ClaudeChip>
          <ClaudeChip active={scope === 'recent'} onClick={() => setScope('recent')}>
            Recent {data?.scope === 'recent' ? `(${total})` : ''}
          </ClaudeChip>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11.5px] text-claude-ink-4">Group by:</span>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            className="text-[12px] border border-claude-line rounded-[6px] px-2 py-0.5 bg-claude-surface text-claude-ink-2 focus:outline-none"
          >
            <option value="status">Status</option>
            <option value="trigger">Trigger</option>
            <option value="client">Client</option>
          </select>
        </div>
      </div>

      {error && (
        <p className="text-claude-err text-[12px] mb-3">
          Polling error: {error}
        </p>
      )}

      {/* Empty state */}
      {items.length === 0 && !error && (
        <div className="text-claude-ink-4 text-[13px] py-8 text-center border border-dashed border-claude-line rounded-[10px]">
          {scope === 'live'
            ? 'No live instances. Click Send Test Event to trigger one.'
            : 'No recently completed runs in the last hour.'}
        </div>
      )}

      {/* Groups */}
      {groups.map((group) => (
        <div key={group.label} className="mb-5">
          <div className="text-[11px] uppercase tracking-[0.12em] text-claude-ink-4 font-medium mb-2">
            {group.label}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {group.cards.map((card) => (
              <InstanceCard key={card.runId} card={card} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
