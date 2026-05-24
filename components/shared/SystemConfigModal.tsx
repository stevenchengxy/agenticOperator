"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Badge, Btn } from "@/components/shared/atoms";
import type { SystemConfigResponse } from "@/app/api/system/config/route";

// Detail modal opened from <InngestPill/>. Shows three sections:
//   1. Inngest engine — URL, source env var, alternates, fn count, runs
//   2. Event catalog (Allmeta) — last sync, freshness, manual refresh
//   3. RaaS partner — API + Inngest URLs (notes whether RaaS shares AO's)
//
// Per spec 2026-05-24 §4.3.

export function SystemConfigModal({
  cfg,
  onClose,
}: {
  cfg: SystemConfigResponse;
  onClose: () => void;
}) {
  const { t } = useApp();
  const [refreshing, setRefreshing] = React.useState(false);

  const refreshAllmeta = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/em/sync/event-definitions/run-now", { method: "POST" });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div
        className="fixed top-1/2 left-1/2 z-50 bg-surface border border-line rounded-lg p-6 overflow-auto"
        style={{ transform: "translate(-50%, -50%)", width: 560, maxHeight: "80vh" }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold">{t("config_modal_title")}</h2>
          <button
            onClick={onClose}
            className="text-ink-3 hover:text-ink-1 text-[18px] leading-none"
          >
            ×
          </button>
        </div>

        {/* Inngest */}
        <Section title={t("config_inngest_label")}>
          <Field label={t("config_url")} value={cfg.inngest.url} mono />
          <Field label={t("config_source_env")} value={cfg.inngest.sourceEnv} mono />
          <Field
            label={t("config_alt_envs")}
            value={
              Object.entries(cfg.inngest.altEnvs)
                .filter(([k, v]) => v != null && k !== cfg.inngest.sourceEnv)
                .map(([k, v]) => `${k}=${v}`)
                .join("  ") || "—"
            }
            mono
          />
          <Field
            label={t("config_status")}
            valueNode={
              <Badge variant={cfg.inngest.healthy ? "ok" : "err"}>
                {cfg.inngest.healthy ? "healthy" : "unreachable"}
              </Badge>
            }
          />
          <Field label={t("config_fn_count")} value={String(cfg.inngest.registeredFunctionCount)} />
          <Field
            label={t("config_runs_24h")}
            value={cfg.inngest.runsLast24h?.toLocaleString() ?? "—"}
          />
          <Field
            label={t("config_last_probe")}
            value={new Date(cfg.inngest.lastProbeAt).toLocaleString()}
          />
        </Section>

        {/* Event Engine */}
        <Section title={t("config_event_engine_label")}>
          <Field
            label={t("config_last_sync")}
            value={
              cfg.eventEngine.lastSyncAt
                ? new Date(cfg.eventEngine.lastSyncAt).toLocaleString()
                : "—"
            }
          />
          <Field
            label={t("config_sync_freshness")}
            valueNode={
              <Badge
                variant={
                  cfg.eventEngine.staleness === "fresh"
                    ? "ok"
                    : cfg.eventEngine.staleness === "stale"
                      ? "warn"
                      : "err"
                }
              >
                {cfg.eventEngine.staleness === "fresh"
                  ? t("allmeta_strip_fresh")
                  : cfg.eventEngine.staleness === "stale"
                    ? t("allmeta_strip_stale")
                    : t("allmeta_strip_never")}
              </Badge>
            }
          />
          <Field label={t("config_synced_events")} value={String(cfg.eventEngine.syncedEventCount)} />
          {cfg.eventEngine.lastError && (
            <Field label={t("config_last_error")} value={cfg.eventEngine.lastError} mono />
          )}
          <div className="mt-2">
            <Btn size="sm" onClick={refreshAllmeta} disabled={refreshing}>
              {refreshing ? "…" : t("config_manual_refresh")}
            </Btn>
          </div>
        </Section>

        {/* RaaS */}
        <Section title={t("config_raas_label")}>
          <Field label="API URL" value={cfg.raas.apiUrl ?? "—"} mono />
          <Field
            label="Inngest URL"
            value={
              cfg.raas.inngestSharedWithLocal
                ? t("config_shared_with_local")
                : cfg.raas.inngestUrl
            }
            mono={!cfg.raas.inngestSharedWithLocal}
          />
        </Section>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-[11px] text-ink-3 uppercase tracking-wide mb-2">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  valueNode,
  mono,
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 text-[12px]">
      <span className="text-ink-3 w-[120px] shrink-0">{label}</span>
      {valueNode ?? (
        <span className={`text-ink-1 ${mono ? "mono break-all" : ""}`}>{value}</span>
      )}
    </div>
  );
}
