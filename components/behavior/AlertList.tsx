"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import type { BehaviorAlertRow } from "@/lib/behavior/types";

// ── Helpers ───────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function SeverityChip({ severity }: { severity: string }) {
  const isError = severity === 'error';
  return (
    <span
      className="inline-flex items-center gap-[4px] px-[6px] py-[2px] rounded text-[10.5px] font-semibold tracking-[0.04em] uppercase"
      style={{
        background: isError ? 'var(--c-fail-bg, oklch(0.97 0.03 20))' : 'var(--c-warn-bg, oklch(0.97 0.05 75))',
        color: isError ? 'var(--c-fail, oklch(0.5 0.2 25))' : 'oklch(0.5 0.14 75)',
      }}
    >
      <span
        className="w-[5px] h-[5px] rounded-full inline-block"
        style={{ background: isError ? 'var(--c-fail, oklch(0.5 0.2 25))' : 'oklch(0.7 0.14 75)' }}
      />
      {severity}
    </span>
  );
}

// ── AlertRow ──────────────────────────────────────────────────────────────

function AlertRow({ alert }: { alert: BehaviorAlertRow }) {
  const isResolved = !!alert.resolvedAt;
  return (
    <div
      className="py-[10px] border-b border-line last:border-0"
      style={{ opacity: isResolved ? 0.6 : 1 }}
    >
      <div className="flex items-center gap-[8px] mb-[4px]">
        <SeverityChip severity={alert.severity} />
        <span className="text-[11px] mono text-ink-4 ml-auto">{relativeTime(alert.firstSeenAt)}</span>
      </div>
      <div className="text-[13px] font-medium text-ink-1 mb-[2px] truncate">{alert.alertKey}</div>
      <div className="text-[11.5px] text-ink-3 mono">{alert.ruleId}</div>
      {alert.managerActionTaken && (
        <div className="mt-[4px] text-[11px] text-ink-4">
          action: <span className="text-ink-2">{alert.managerActionTaken}</span>
        </div>
      )}
      {isResolved && (
        <div className="mt-[4px] text-[10.5px] text-ink-4">resolved {relativeTime(alert.resolvedAt!)}</div>
      )}
    </div>
  );
}

// ── AlertList ─────────────────────────────────────────────────────────────

export function AlertList({ alerts }: { alerts: BehaviorAlertRow[] }) {
  const { t } = useApp();
  if (alerts.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-[12px] text-ink-4">
        {t('behavior_no_open_alerts')}
      </div>
    );
  }
  return (
    <div>
      {alerts.map((a) => (
        <AlertRow key={a.id} alert={a} />
      ))}
    </div>
  );
}
