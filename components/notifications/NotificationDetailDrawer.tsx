"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { fetchJson } from "@/lib/api/client";

// Notification detail drawer (spec §4) — the curated row + the raw LogEvent
// rows behind it, so a human can read the underlying error and locate the
// problem. Right-side overlay, mirrors RuleCheckAuditDetailDrawer's shell.

type LogRow = {
  id: string;
  ts: string;
  level: string;
  category: string;
  source: string;
  agent: string | null;
  message: string;
  payloadJson: string | null;
};

type DetailResponse = {
  ok: boolean;
  notification?: {
    id: string;
    ts: string;
    kind: string;
    severity: string;
    category: string;
    source: string;
    title: string;
    body: string;
    aiSummary: string | null;
    aiSource: string | null;
    count: number;
    firstSeenAt: string;
    lastSeenAt: string;
    status: string | null;
    disposition: string;
    runId: string | null;
    traceId: string | null;
    agent: string | null;
  };
  href?: string | null;
  logs?: LogRow[];
  error?: string;
};

const SEV_INK: Record<string, string> = {
  critical: "var(--c-err)",
  warning: "oklch(0.62 0.15 70)",
  info: "var(--c-accent)",
};

// Raw-log level → ink. error/critical stand out; the rest are muted.
const LEVEL_INK: Record<string, string> = {
  critical: "var(--c-err)",
  error: "var(--c-err)",
  warn: "oklch(0.62 0.15 70)",
  notice: "var(--c-ink-2)",
  info: "var(--c-ink-3)",
  debug: "var(--c-ink-3)",
};

function fmtTime(iso: string, lang: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function NotificationDetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, lang } = useApp();
  const [data, setData] = React.useState<DetailResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchJson<DetailResponse>(`/api/notifications/${id}`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData({ ok: false, error: "fetch_failed" }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id]);

  const n = data?.notification;
  const logs = data?.logs ?? [];
  const sevInk = n ? SEV_INK[n.severity] ?? "var(--c-ink-2)" : "var(--c-ink-2)";

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      style={{ background: "color-mix(in oklab, var(--c-bg) 60%, transparent)" }}
      onClick={onClose}
    >
      <div
        className="bg-surface border-l border-line flex flex-col"
        style={{ width: "min(760px, 94vw)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="border-b border-line flex items-start gap-3" style={{ padding: "18px 22px" }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[15px] font-medium text-ink-1">{n?.title ?? (loading ? t("ntf_detail_loading") : "—")}</span>
              {n && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{ background: `color-mix(in oklch, ${sevInk} 14%, transparent)`, color: sevInk }}
                >
                  {t(SEV_KEY[n.severity] ?? "ntf_sev_info")}
                </span>
              )}
              {n && n.count > 1 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-raised text-ink-3">
                  {t("ntf_detail_count")} {n.count} {t("ntf_detail_times")}
                </span>
              )}
            </div>
            {n && (
              <div className="text-[11px] text-ink-3 mt-1.5 flex items-center gap-3 flex-wrap font-mono">
                <span>{n.source}</span>
                <span>{t("ntf_detail_first_seen")} {fmtTime(n.firstSeenAt, lang)}</span>
                <span>{t("ntf_detail_last_seen")} {fmtTime(n.lastSeenAt, lang)}</span>
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-ink-3 hover:text-ink-1 border border-line rounded-md px-2 py-1 text-xs"
          >
            {t("ntf_detail_close")}
          </button>
        </div>

        <div className="flex-1 overflow-auto" style={{ padding: "18px 22px" }}>
          {/* AI analysis */}
          <Section title={t("ntf_detail_ai")}>
            {n?.aiSummary ? (
              <div className="flex items-start gap-2">
                <span className="mt-0.5 text-accent shrink-0"><Ic.sparkle /></span>
                <div className="min-w-0">
                  <p className="text-[13px] text-ink-1 leading-relaxed">{n.aiSummary}</p>
                  <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 rounded border border-line text-ink-3">
                    {n.aiSource === "fallback" ? t("ntf_ai_fallback") : t("ntf_detail_ai_llm")}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-[12px] text-ink-3">{t("ntf_detail_ai_pending")}</p>
            )}
            {n?.body && n.body !== n.aiSummary && (
              <p className="text-[12px] text-ink-2 mt-3 whitespace-pre-wrap leading-relaxed border-t border-line pt-3">
                {n.body}
              </p>
            )}
          </Section>

          {/* detailed logs — the locate-the-problem core */}
          <Section title={t("ntf_detail_logs")} hint={t("ntf_detail_logs_hint")}>
            {loading ? (
              <p className="text-[12px] text-ink-3">{t("ntf_detail_loading")}</p>
            ) : logs.length === 0 ? (
              <p className="text-[12px] text-ink-3">{t("ntf_detail_no_logs")}</p>
            ) : (
              <div className="flex flex-col">
                {logs.map((l, i) => (
                  <LogLine key={l.id} l={l} lang={lang} t={t} last={i === logs.length - 1} />
                ))}
              </div>
            )}
          </Section>

          {/* deep links */}
          {data?.href && (
            <a
              href={data.href}
              className="inline-flex items-center gap-1.5 text-[12px] text-accent hover:underline mt-1"
            >
              <Ic.arrowR />
              {t("ntf_detail_open")}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

const SEV_KEY: Record<string, string> = {
  critical: "ntf_sev_critical",
  warning: "ntf_sev_warning",
  info: "ntf_sev_info",
};

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <div className="flex items-baseline gap-2.5 mb-2">
        <h3 className="m-0 text-[13px] font-medium text-ink-1">{title}</h3>
        {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
      </div>
      <div className="border border-line rounded-lg bg-panel" style={{ padding: "12px 14px" }}>
        {children}
      </div>
    </section>
  );
}

function LogLine({
  l,
  lang,
  t,
  last,
}: {
  l: LogRow;
  lang: string;
  t: (k: string) => string;
  last: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const ink = LEVEL_INK[l.level] ?? "var(--c-ink-3)";
  const hasPayload = !!l.payloadJson && l.payloadJson !== "{}" && l.payloadJson !== "null";
  return (
    <div className={last ? "" : "border-b border-line"} style={{ padding: "7px 0" }}>
      <div className="flex items-start gap-2.5">
        <span className="font-mono text-[10.5px] text-ink-3 shrink-0 mt-0.5" style={{ width: 96 }}>
          {fmtTime(l.ts, lang)}
        </span>
        <span
          className="font-mono text-[10px] uppercase shrink-0 mt-0.5"
          style={{ color: ink, width: 56 }}
        >
          {l.level}
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-[12px] text-ink-1 break-words">{l.message}</span>
          <span className="text-[10.5px] text-ink-3 font-mono ml-2">
            {l.agent ?? l.source}
          </span>
          {hasPayload && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="ml-2 text-[10.5px] text-accent hover:underline"
            >
              {t("ntf_detail_payload")}
            </button>
          )}
          {open && hasPayload && (
            <pre
              className="font-mono text-[10.5px] text-ink-2 whitespace-pre-wrap mt-1.5 bg-bg border border-line rounded"
              style={{ padding: "8px 10px", maxHeight: 240, overflow: "auto" }}
            >
              {prettyJson(l.payloadJson!)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
