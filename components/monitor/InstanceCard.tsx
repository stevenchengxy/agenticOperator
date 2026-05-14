"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeBadge } from "./atoms";
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

function agentDots(agentsTouched: number, max = 5): React.ReactNode {
  const filled = Math.min(agentsTouched, max);
  return (
    <span className="inline-flex gap-0.5 items-center">
      {Array.from({ length: max }).map((_, i) => (
        <span
          key={i}
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            i < filled ? 'bg-claude-accent' : 'bg-claude-line'
          }`}
        />
      ))}
      <span className="ml-1 text-claude-ink-3">{agentsTouched} agent{agentsTouched !== 1 ? 's' : ''}</span>
    </span>
  );
}

// ── Status pill ────────────────────────────────────────────────────
const STATUS_TONE: Record<string, 'accent' | 'warn' | 'err' | 'ok' | 'neutral'> = {
  running:   'accent',
  paused:    'warn',
  suspended: 'warn',
  failed:    'err',
  completed: 'ok',
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

// ── Component ──────────────────────────────────────────────────────
export function InstanceCard({ card }: { card: InstanceCardType }) {
  const { title, subtitle } = deriveTitle(card);
  const tone = STATUS_TONE[card.status] ?? 'neutral';
  const elapsed = elapsedLabel(card.startedAt);
  const stageLabel = card.currentStage ? card.currentStage.toUpperCase() : null;

  return (
    <Link
      href={`/monitor/runs/${encodeURIComponent(card.runId)}`}
      className="block no-underline"
    >
      <ClaudeCard className="p-4 hover:bg-claude-panel transition-colors cursor-pointer">
        {/* Header row */}
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] uppercase tracking-[0.10em] text-claude-ink-4 font-medium truncate mr-2">
            {card.triggerEvent} · {elapsed}
          </span>
          <ClaudeBadge tone={tone} size="xs">
            {card.status}
          </ClaudeBadge>
        </div>

        {/* Title */}
        <div className="text-[13.5px] font-medium text-claude-ink-1 leading-snug truncate mb-0.5">
          {title}
        </div>

        {/* Subtitle (entity refs) */}
        <div className="text-[11.5px] text-claude-ink-3 truncate mb-3">
          {subtitle}
        </div>

        {/* Divider */}
        <div className="border-t border-claude-line mb-3" />

        {/* Progress row */}
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-[12px] text-claude-ink-2">
            {card.currentAgent
              ? <><span className="text-claude-ink-4">Current: </span>{card.currentAgent}</>
              : <span className="text-claude-ink-4">No activity yet</span>
            }
          </span>
          <span>{agentDots(card.agentsTouched)}</span>
        </div>

        {stageLabel && (
          <div className="text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 mb-3">
            Stage: {stageLabel}
          </div>
        )}

        {/* Divider (only if flags exist) */}
        {(card.pendingHitl || card.hasFailure) && (
          <>
            <div className="border-t border-claude-line mb-2" />
            <div className="flex items-center gap-2">
              {card.pendingHitl && (
                <ClaudeBadge tone="warn" size="xs">HITL waiting</ClaudeBadge>
              )}
              {card.hasFailure && (
                <ClaudeBadge tone="err" size="xs">failure</ClaudeBadge>
              )}
              <span className="ml-auto text-claude-ink-4 text-[13px] font-medium">→</span>
            </div>
          </>
        )}

        {/* Arrow when no flags */}
        {!card.pendingHitl && !card.hasFailure && (
          <div className="flex justify-end">
            <span className="text-claude-ink-4 text-[13px] font-medium">→</span>
          </div>
        )}
      </ClaudeCard>
    </Link>
  );
}
