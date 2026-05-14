"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import type { BehaviorAlertRow } from "@/lib/behavior/types";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function ActionChip({ action }: { action: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    escalate:     { bg: 'var(--c-fail-bg, oklch(0.97 0.03 20))', text: 'var(--c-fail, oklch(0.5 0.2 25))' },
    throttle:     { bg: 'oklch(0.96 0.03 240)', text: 'oklch(0.4 0.12 240)' },
    auto_restart: { bg: 'oklch(0.96 0.04 180)', text: 'oklch(0.4 0.12 180)' },
    monitor:      { bg: 'var(--c-surface)', text: 'var(--c-ink-3)' },
  };
  const c = colors[action] ?? colors['monitor'];
  return (
    <span
      className="inline-flex px-[6px] py-[2px] rounded text-[10.5px] font-semibold tracking-[0.04em] uppercase"
      style={{ background: c.bg, color: c.text }}
    >
      {action.replace('_', ' ')}
    </span>
  );
}

function ActionRow({ alert }: { alert: BehaviorAlertRow }) {
  const when = alert.managerActionAt ?? alert.firstSeenAt;
  return (
    <div className="py-[10px] border-b border-line last:border-0">
      <div className="flex items-center gap-[8px] mb-[4px]">
        {alert.managerActionTaken && <ActionChip action={alert.managerActionTaken} />}
        <span className="text-[11px] mono text-ink-4 ml-auto">{relativeTime(when)}</span>
      </div>
      <div className="text-[13px] font-medium text-ink-1 mb-[2px] truncate">{alert.alertKey}</div>
      <div className="text-[11.5px] text-ink-3">triggered by rule: <span className="mono">{alert.ruleId}</span></div>
    </div>
  );
}

export function ManagerActionList({ actions }: { actions: BehaviorAlertRow[] }) {
  const { t } = useApp();
  if (actions.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-[12px] text-ink-4">
        {t('behavior_no_actions')}
      </div>
    );
  }
  return (
    <div>
      {actions.map((a) => (
        <ActionRow key={a.id} alert={a} />
      ))}
    </div>
  );
}
