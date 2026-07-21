"use client";

import React from "react";
import { useApp } from "@/lib/i18n";
import type {
  BusinessOutcome,
  OutcomeSummary,
  RecoveryAction,
  TechnicalCause,
  TechnicalOutcome,
} from "@/lib/monitor/run-outcome";

const TECH_COLOR: Record<TechnicalOutcome, string> = {
  healthy: "var(--c-ok)",
  degraded: "var(--c-warn)",
  failed: "var(--c-err)",
  running: "var(--c-accent)",
  cancelled: "var(--c-ink-4)",
};
const BUSINESS_COLOR: Record<BusinessOutcome, string> = {
  passed: "var(--c-ok)",
  rejected: "oklch(0.62 0.15 70)",
  mixed: "var(--c-warn)",
  blocked: "var(--c-err)",
  pending: "var(--c-accent)",
  not_applicable: "var(--c-ink-4)",
  unknown: "var(--c-ink-4)",
};

export function technicalOutcomeLabel(value: TechnicalOutcome, lang: "zh" | "en"): string {
  const labels: Record<TechnicalOutcome, [string, string]> = {
    healthy: ["执行正常", "Execution healthy"],
    degraded: ["技术异常", "Technical anomaly"],
    failed: ["技术失败", "Technical failure"],
    running: ["运行中", "Running"],
    cancelled: ["已取消", "Cancelled"],
  };
  return labels[value][lang === "zh" ? 0 : 1];
}

export function technicalCauseLabel(value: TechnicalCause, lang: "zh" | "en"): string {
  const labels: Record<TechnicalCause, [string, string]> = {
    quota_exhausted: ["额度不足", "Quota exhausted"],
    rate_limited: ["调用限流", "Rate limited"],
    authentication: ["鉴权失败", "Authentication failed"],
    timeout: ["请求超时", "Request timeout"],
    network: ["网络故障", "Network failure"],
    upstream_server: ["上游服务故障", "Upstream server failure"],
    empty_response: ["上游空返回", "Empty upstream response"],
    data_not_found: ["依赖数据不存在", "Dependency data not found"],
    missing_input: ["输入缺失", "Missing input"],
    invalid_response: ["响应格式异常", "Invalid response"],
    persistence: ["持久化失败", "Persistence failure"],
    configuration: ["配置错误", "Configuration error"],
    dependency_unavailable: ["依赖不可用", "Dependency unavailable"],
    unknown: ["原因待确认", "Cause unknown"],
  };
  return labels[value][lang === "zh" ? 0 : 1];
}

export function recoveryActionLabel(value: RecoveryAction, lang: "zh" | "en"): string {
  const labels: Record<RecoveryAction, [string, string]> = {
    top_up_then_retry: ["充值后自动续跑", "Top up, then auto-resume"],
    auto_retry: ["系统自动重试", "Automatic retry"],
    fix_credentials: ["修复凭证后重跑", "Fix credentials, then rerun"],
    fix_input: ["补齐输入后重跑", "Fix input, then rerun"],
    inspect_response: ["检查上游响应", "Inspect upstream response"],
    repair_persistence: ["修复存储后补偿", "Repair storage and reconcile"],
    fix_configuration: ["修复配置后重跑", "Fix configuration, then rerun"],
    manual_review: ["需要人工确认", "Manual review required"],
  };
  return labels[value][lang === "zh" ? 0 : 1];
}

export function businessOutcomeLabel(value: BusinessOutcome, lang: "zh" | "en"): string {
  const labels: Record<BusinessOutcome, [string, string]> = {
    passed: ["业务通过", "Business passed"],
    rejected: ["业务未通过", "Business rejected"],
    mixed: ["部分通过", "Mixed outcome"],
    blocked: ["业务未产出", "Business blocked"],
    pending: ["业务处理中", "Business pending"],
    not_applicable: ["无业务判定", "No business verdict"],
    unknown: ["结果未知", "Outcome unknown"],
  };
  return labels[value][lang === "zh" ? 0 : 1];
}

export function OutcomeBadges({
  outcome,
  axes = "both",
  compact = false,
}: {
  outcome: OutcomeSummary | null | undefined;
  axes?: "both" | "technical" | "business";
  compact?: boolean;
}) {
  const { lang } = useApp();
  if (!outcome) return <span className="text-ink-4 text-[11px]">—</span>;
  const title = [
    outcome.code,
    outcome.reason,
    outcome.recoveryAction ? recoveryActionLabel(outcome.recoveryAction, lang) : null,
  ].filter(Boolean).join(" · ") || undefined;
  return (
    <span className="inline-flex items-center gap-1 flex-wrap" title={title}>
      {(axes === "both" || axes === "technical") && (
        <>
          <OutcomePill
            color={TECH_COLOR[outcome.technical]}
            label={technicalOutcomeLabel(outcome.technical, lang)}
            pulse={outcome.technical === "running"}
            compact={compact}
          />
          {outcome.technicalCause && (
            <OutcomePill
              color={causeColor(outcome.technicalCause)}
              label={`${outcome.provider ? `${outcome.provider} · ` : ""}${technicalCauseLabel(outcome.technicalCause, lang)}`}
              compact={compact}
            />
          )}
        </>
      )}
      {(axes === "both" || axes === "business") && outcome.business !== "not_applicable" && (
        <OutcomePill
          color={BUSINESS_COLOR[outcome.business]}
          label={`${businessOutcomeLabel(outcome.business, lang)}${outcome.score != null ? ` · ${outcome.score}` : ""}`}
          pulse={outcome.business === "pending"}
          compact={compact}
        />
      )}
    </span>
  );
}

function causeColor(cause: TechnicalCause): string {
  if (["quota_exhausted", "authentication", "configuration"].includes(cause)) return "var(--c-err)";
  if (cause === "unknown") return "var(--c-ink-4)";
  return "var(--c-warn)";
}

function OutcomePill({ color, label, pulse, compact }: { color: string; label: string; pulse?: boolean; compact?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap ${pulse ? "anim-pulse" : ""}`}
      style={{
        padding: compact ? "1px 6px" : "2px 8px",
        fontSize: compact ? 9.5 : 10.5,
        color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 28%, var(--c-line))`,
      }}
    >
      <span className="rounded-full" style={{ width: 5, height: 5, background: color }} />
      {label}
    </span>
  );
}
