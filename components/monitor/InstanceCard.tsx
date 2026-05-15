"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeBadge } from "./atoms";
import { useApp } from "@/lib/i18n";
import { stageLabel, statusLabel } from "./i18n-utils";
import type { InstanceCard as InstanceCardType } from "@/lib/monitor/types";

// ── Helpers ────────────────────────────────────────────────────────

function elapsedLabel(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m${s > 0 ? `${s}s` : ''}`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `${h}h${rem > 0 ? `${rem}m` : ''}`;
}

// ── Status dot color ───────────────────────────────────────────────
const STATUS_DOT_COLOR: Record<string, string> = {
  running:   'bg-claude-accent',
  paused:    'bg-claude-warn',
  suspended: 'bg-claude-warn',
  failed:    'bg-claude-err',
  completed: 'bg-claude-ok',
};

// ── Status pill tone ───────────────────────────────────────────────
const STATUS_TONE: Record<string, 'accent' | 'warn' | 'err' | 'ok' | 'neutral'> = {
  running:   'accent',
  paused:    'warn',
  suspended: 'warn',
  failed:    'err',
  completed: 'ok',
};

// ── Stage chip labels ──────────────────────────────────────────────
const STAGE_LABELS: Record<string, string> = {
  req:       'Stage 1',
  jd:        'Stage 2',
  source:    'Stage 3',
  screen:    'Stage 4',
  interview: 'Stage 5',
  eval:      'Stage 6',
  package:   'Stage 7',
  submit:    'Stage 8',
};

// ── Title derivation ───────────────────────────────────────────────
function deriveTitle(card: InstanceCardType): { title: string; subtitle: string } {
  if (card.client && card.jdTitle) {
    const subParts: string[] = [];
    if (card.jdId) subParts.push(`jd-${card.jdId.slice(0, 8)}`);
    if (card.candidateName) subParts.push(card.candidateName);
    return {
      title: `${card.client} · ${card.jdTitle}`,
      subtitle: subParts.join(' · ') || card.triggerEvent,
    };
  }
  if (card.client) {
    return { title: card.client, subtitle: card.triggerEvent };
  }
  if (card.candidateName) {
    const subParts: string[] = [];
    if (card.candidateId) subParts.push(card.candidateId.slice(0, 8));
    if (card.resumeId) subParts.push(`resume-${card.resumeId.slice(0, 8)}`);
    return { title: card.candidateName, subtitle: subParts.join(' · ') || card.triggerEvent };
  }
  return { title: `Run ${card.runId.slice(0, 8)}`, subtitle: card.triggerEvent };
}

// ── Progress bar ───────────────────────────────────────────────────
// Use 18 as the approximate total agent count in the full pipeline.
const TOTAL_PIPELINE_AGENTS = 18;

function ProgressBar({ agentsTouched }: { agentsTouched: number }) {
  const pct = Math.min((agentsTouched / TOTAL_PIPELINE_AGENTS) * 100, 100);
  return (
    <div className="h-1 rounded-full bg-claude-line overflow-hidden">
      <div
        className="h-1 rounded-full bg-claude-accent transition-all duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────
export function InstanceCard({
  card,
  selected,
  onToggleSelect,
}: {
  card: InstanceCardType;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const { t } = useApp();
  const { title, subtitle } = deriveTitle(card);
  const tone = STATUS_TONE[card.status] ?? 'neutral';
  const dotColor = STATUS_DOT_COLOR[card.status] ?? 'bg-claude-ink-4';
  const elapsed = elapsedLabel(card.startedAt);
  const stageChip = stageLabel(card.currentStage, t) ?? (card.currentStage ? (STAGE_LABELS[card.currentStage] ?? card.currentStage.toUpperCase()) : null);

  return (
    <Link
      href={`/monitor/runs/${encodeURIComponent(card.runId)}`}
      className="block no-underline"
    >
      <ClaudeCard className="relative p-4 hover:bg-claude-panel/40 hover:shadow-sm transition-all cursor-pointer">
        {/* Checkbox — only rendered when in select mode (onToggleSelect provided) */}
        {onToggleSelect && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggleSelect(); }}
            className="absolute top-2 left-2 w-4 h-4 rounded border border-claude-line bg-claude-surface flex items-center justify-center text-claude-accent"
            aria-label={t("monitor_batch_selected").replace("{n}", "1")}
          >
            {selected && (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M1 5l2.5 2.5L9 2" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            )}
          </button>
        )}
        {/* ── Title row: status dot + title + pill ── */}
        <div className="flex items-center gap-2 mb-1.5">
          {/* Status dot */}
          <span className={`shrink-0 inline-block w-2.5 h-2.5 rounded-full ${dotColor}`} />
          {/* Title */}
          <span className="text-[14.5px] font-medium text-claude-ink-1 leading-snug truncate flex-1 min-w-0">
            {title}
          </span>
          {/* Status pill */}
          <ClaudeBadge tone={tone} size="xs">
            {statusLabel(card.status, t)}
          </ClaudeBadge>
        </div>

        {/* ── Horizontal rule ── */}
        <div className="border-t border-claude-line mb-2" />

        {/* ── Meta line: trigger + duration ── */}
        <div className="text-[11px] uppercase tracking-[0.10em] text-claude-ink-4 font-medium mb-1 truncate">
          {card.triggerEvent} · {elapsed}
        </div>

        {/* ── Entity sub-refs ── */}
        {subtitle !== card.triggerEvent && (
          <div className="text-[11.5px] text-claude-ink-3 truncate mb-3">
            {subtitle}
          </div>
        )}
        {subtitle === card.triggerEvent && <div className="mb-3" />}

        {/* ── Progress bar ── */}
        <ProgressBar agentsTouched={card.agentsTouched} />
        <div className="flex items-center justify-between mt-1 mb-2">
          <span className="text-[11px] text-claude-ink-4">
            {card.agentsTouched} / {TOTAL_PIPELINE_AGENTS} {t("monitor_card_agents_touched")}
          </span>
        </div>

        {/* ── Current agent line ── */}
        {card.currentAgent ? (
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11.5px] text-claude-ink-4">►</span>
            <span className="text-[12.5px] text-claude-ink-2 font-medium truncate flex-1">
              {card.currentAgent}
            </span>
            {stageChip && (
              <span className="shrink-0 text-[10.5px] px-1.5 py-0.5 rounded bg-claude-panel text-claude-ink-3 font-medium">
                {stageChip}
              </span>
            )}
          </div>
        ) : (
          <div className="text-[11.5px] text-claude-ink-4 mb-2">
            {t("monitor_card_current")} —
          </div>
        )}

        {/* ── Flag badges + open arrow ── */}
        {(card.pendingHitl || card.hasFailure) ? (
          <div className="flex items-center gap-2 border-t border-claude-line pt-2 mt-1">
            {card.pendingHitl && (
              <span className="text-[11px] text-claude-warn font-medium">⚠ {t("monitor_card_hitl")}</span>
            )}
            {card.hasFailure && (
              <span className="text-[11px] text-claude-err font-medium">⛔ {t("monitor_card_failure")}</span>
            )}
            <span className="ml-auto text-claude-ink-4 text-[13px] font-medium">{t("monitor_open")}</span>
          </div>
        ) : (
          <div className="flex justify-end">
            <span className="text-claude-ink-4 text-[13px] font-medium">→</span>
          </div>
        )}
      </ClaudeCard>
    </Link>
  );
}
