import type { Lang } from "@/lib/i18n";

type T = (key: string) => string;

export function formatRelativeTime(iso: string | null | undefined, lang: Lang, withAgo = true): string {
  if (!iso) return "—";
  const ms = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.floor(ms / 1000);
  const unit = s < 60
    ? { value: s, zh: "秒", en: "s" }
    : s < 3600
      ? { value: Math.floor(s / 60), zh: "分钟", en: "m" }
      : s < 86400
        ? { value: Math.floor(s / 3600), zh: "小时", en: "h" }
        : { value: Math.floor(s / 86400), zh: "天", en: "d" };

  if (!withAgo) return lang === "zh" ? `${unit.value}${unit.zh}` : `${unit.value}${unit.en}`;
  return lang === "zh" ? `${unit.value}${unit.zh}前` : `${unit.value}${unit.en} ago`;
}

export function formatDateTime(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { hour12: false });
}

export function formatTime(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function statusLabel(status: string | null | undefined, t: T): string {
  const key = status?.toLowerCase().replace(/[^a-z0-9]+/g, "_") ?? "unknown";
  const map: Record<string, string> = {
    running: "status_running",
    completed: "status_completed",
    failed: "status_failed",
    suspended: "status_suspended",
    paused: "status_paused",
    interrupted: "status_interrupted",
    cancelled: "status_cancelled",
    canceled: "status_cancelled",
    timed_out: "status_timed_out",
    accepted: "monitor_queue_bucket_accepted",
    pending: "monitor_queue_bucket_pending",
    rejected: "monitor_queue_bucket_rejected",
    rejected_schema: "monitor_queue_bucket_rejected",
    rejected_filter: "monitor_queue_bucket_rejected",
    duplicate: "monitor_queue_status_duplicate",
    meta_rejection: "monitor_queue_bucket_rejected",
    em_degraded: "monitor_ss_state_degraded",
    unknown: "status_unknown",
  };
  return t(map[key] ?? "status_unknown");
}

export function subsystemLabel(id: string, fallback: string, t: T): string {
  const map: Record<string, string> = {
    em: "monitor_ss_em",
    raas: "monitor_ss_raas",
    neo4j: "monitor_ss_neo4j",
    inngest: "monitor_ss_inngest",
    deployment: "monitor_ss_deployment",
  };
  return map[id] ? t(map[id]) : fallback;
}

export function subsystemStateLabel(state: string, t: T): string {
  return t(`monitor_ss_state_${state}`);
}

export function subsystemMetricLabel(label: string, t: T): string {
  const map: Record<string, string> = {
    "24h publish": "monitor_ss_metric_publish_24h",
    "24h reject": "monitor_ss_metric_reject_24h",
    "24h fallback": "monitor_ss_metric_fallback_24h",
    "24h received": "monitor_ss_metric_received_24h",
    "recent classification": "monitor_ss_metric_recent_classification",
    "last sync": "monitor_ss_metric_last_sync",
    "upserted last": "monitor_ss_metric_upserted_last",
    endpoint: "monitor_ss_metric_endpoint",
    "http status": "monitor_ss_metric_http_status",
    server: "monitor_ss_metric_server",
    callback: "monitor_ss_metric_callback",
    apps: "monitor_ss_metric_apps",
    functions: "monitor_ss_metric_functions",
    configured: "monitor_ss_metric_configured",
    database: "monitor_ss_metric_database",
    upserted: "monitor_ss_metric_upserted_last",
    registered: "monitor_ss_metric_registered",
    env: "monitor_ss_metric_env",
  };
  return map[label] ? t(map[label]) : label;
}

export function subsystemDetail(detail: string | null, t: T): string | null {
  if (!detail) return null;
  if (detail.startsWith("RAAS API Server unreachable")) {
    return t("monitor_ss_detail_raas_probe_down");
  }
  const map: Record<string, string> = {
    "External Kafka inbound · classified via gateway filter rules.": "monitor_ss_detail_raas",
    "RAAS API Server reachability probe.": "monitor_ss_detail_raas_probe_ok",
    "RAAS API Server unreachable (network error or timeout).": "monitor_ss_detail_raas_probe_down",
    "RAAS_API_BASE_URL not configured.": "monitor_ss_detail_raas_probe_unset",
    "Graph engine sync via Allmeta Ontology.": "monitor_ss_detail_neo4j",
    "Local Inngest dev server. Used by the workflow event bus.": "monitor_ss_detail_inngest",
  };
  return map[detail] ? t(map[detail]) : detail;
}

export function queueBucketLabel(bucket: string, t: T): string {
  const map: Record<string, string> = {
    accepted: "monitor_queue_bucket_accepted",
    pending: "monitor_queue_bucket_pending",
    rejected: "monitor_queue_bucket_rejected",
    dlq: "monitor_queue_bucket_dlq",
  };
  return map[bucket] ? t(map[bucket]) : bucket;
}

export function stageLabel(stage: string | null | undefined, t: T): string | null {
  if (!stage) return null;
  const map: Record<string, string> = {
    req: "monitor_stage_req",
    jd: "monitor_stage_jd",
    source: "monitor_stage_source",
    screen: "monitor_stage_screen",
    interview: "monitor_stage_interview",
    eval: "monitor_stage_eval",
    package: "monitor_stage_package",
    submit: "monitor_stage_submit",
  };
  return map[stage] ? t(map[stage]) : stage.toUpperCase();
}

export function trailResultLabel(result: string, current: boolean, t: T): string {
  const label = t(`monitor_trail_${result}`);
  return current ? `${label} (${t("monitor_trail_running")})` : label;
}
