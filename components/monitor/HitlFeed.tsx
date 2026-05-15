"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeSectionTitle, ClaudeBadge } from "./atoms";
import { useApp } from "@/lib/i18n";
import type { MonitorHitlRow } from "@/lib/monitor/types";

export function HitlFeed({ rows }: { rows: MonitorHitlRow[] }) {
  const { t, lang } = useApp();
  return (
    <ClaudeCard className="h-full">
      <ClaudeSectionTitle>{t("monitor_hitl_title")}</ClaudeSectionTitle>
      {rows.length === 0 ? (
        <div className="text-claude-ink-4 text-[12.5px]">{t("monitor_hitl_empty")}</div>
      ) : (
        <ul className="flex flex-col divide-y divide-claude-line">
          {rows.map((r) => (
            <li key={r.taskId} className="py-2 first:pt-0 last:pb-0">
              <Link
                href={`/inbox/${encodeURIComponent(r.taskId)}`}
                className="flex items-start gap-2 text-[12.5px] no-underline hover:bg-claude-panel rounded px-1 py-1 -mx-1"
              >
                <ClaudeBadge tone="warn" size="xs">{r.nodeId}</ClaudeBadge>
                <span className="text-claude-ink-1 truncate">{r.title}</span>
                {r.deadline && (
                  <span className="ml-auto text-claude-ink-4 tabular-nums">
                    {t("monitor_due")} {new Date(r.deadline).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour12: false })}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ClaudeCard>
  );
}
