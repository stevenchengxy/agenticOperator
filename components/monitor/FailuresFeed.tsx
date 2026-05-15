"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeSectionTitle, ClaudeBadge } from "./atoms";
import { useApp } from "@/lib/i18n";
import { formatRelativeTime } from "./i18n-utils";
import type { MonitorFailureRow } from "@/lib/monitor/types";

export function FailuresFeed({ rows }: { rows: MonitorFailureRow[] }) {
  const { t, lang } = useApp();
  return (
    <ClaudeCard className="h-full">
      <ClaudeSectionTitle>{t("monitor_failures_title")}</ClaudeSectionTitle>
      {rows.length === 0 ? (
        <div className="text-claude-ink-4 text-[12.5px]">{t("monitor_failures_empty")}</div>
      ) : (
        <ul className="flex flex-col divide-y divide-claude-line">
          {rows.map((r) => (
            <li key={`${r.runId}-${r.at}`} className="py-2 first:pt-0 last:pb-0">
              <Link
                href={r.runId ? `/monitor/runs/${encodeURIComponent(r.runId)}?focus=${encodeURIComponent(r.at)}` : '#'}
                className="flex items-start gap-2 text-[12.5px] no-underline hover:bg-claude-panel rounded px-1 py-1 -mx-1"
              >
                <ClaudeBadge tone={r.severity === 'error' ? 'err' : 'warn'} size="xs">
                  {r.severity === 'error' ? t('behavior_severity_error') : t('m_anomalies')}
                </ClaudeBadge>
                <span className="text-claude-ink-1 font-medium">{r.agent}</span>
                <span className="text-claude-ink-3 truncate">— {r.narrative}</span>
                <span className="ml-auto text-claude-ink-4 tabular-nums">{formatRelativeTime(r.at, lang, false)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ClaudeCard>
  );
}
