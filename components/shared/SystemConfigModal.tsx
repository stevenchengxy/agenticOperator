"use client";
import React from "react";
import Link from "next/link";
import { useApp } from "@/lib/i18n";
import { Badge, Btn } from "@/components/shared/atoms";
import { MainInngestAppRegistration } from "@/components/shared/InngestAppRegistrationControls";
import type { SystemConfigResponse } from "@/app/api/system/config/route";

// Detail modal opened from <InngestPill/>. Shows three sections:
//   1. Inngest engine — URL, source env var, alternates, fn count, runs
//   2. Event catalog (Allmeta) — last sync, freshness, manual refresh
//   3. RaaS partner — API + Inngest URLs (notes whether RaaS shares AO's)
//
// Per spec 2026-05-24 §4.3.

export function SystemConfigModal({
  cfg: initialCfg,
  onClose,
  onConfigChange,
}: {
  cfg: SystemConfigResponse;
  onClose: () => void;
  onConfigChange?: (cfg: SystemConfigResponse) => void;
}) {
  const { t } = useApp();
  const [cfg, setCfg] = React.useState(initialCfg);
  const [refreshing, setRefreshing] = React.useState(false);
  const [checkingInfra, setCheckingInfra] = React.useState(false);
  const [infraResult, setInfraResult] = React.useState<string | null>(null);

  React.useEffect(() => {
    setCfg(initialCfg);
  }, [initialCfg]);

  const updateCfg = React.useCallback((next: SystemConfigResponse) => {
    setCfg(next);
    onConfigChange?.(next);
  }, [onConfigChange]);

  const reloadConfig = React.useCallback(async () => {
    const r = await fetch("/api/system/config", { cache: "no-store" });
    const next = (await r.json()) as SystemConfigResponse;
    if (r.ok) updateCfg(next);
    return next;
  }, [updateCfg]);

  const serveHost =
    cfg.inngest.altEnvs.INNGEST_SERVE_ORIGIN ??
    cfg.inngest.altEnvs.INNGEST_SERVE_HOST ??
    inferServeHost(cfg.inngest.serveEndpointUrl, cfg.inngest.altEnvs.INNGEST_SERVE_PATH ?? "/api/inngest");

  const refreshAllmeta = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/em/sync/event-definitions/run-now", { method: "POST" });
      await reloadConfig().catch(() => undefined);
    } finally {
      setRefreshing(false);
    }
  };

  const runInfraCheck = async () => {
    setCheckingInfra(true);
    setInfraResult(null);
    try {
      const r = await fetch("/api/infra/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? "check failed");
      setInfraResult(
        t("config_infra_check_result")
          .replace("{recorded}", String(j.recorded ?? 0))
          .replace("{resolved}", String(j.resolved ?? 0)),
      );
      await reloadConfig().catch(() => undefined);
    } catch (e) {
      setInfraResult((e as Error).message);
    } finally {
      setCheckingInfra(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div
        className="fixed top-1/2 left-1/2 z-50 bg-surface border border-line rounded-lg p-6 overflow-auto"
        style={{ transform: "translate(-50%, -50%)", width: "min(760px, calc(100vw - 32px))", maxHeight: "84vh" }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold">{t("config_modal_title")}</h2>
          <div className="flex items-center gap-2">
            <Link
              href="/settings/system"
              onClick={onClose}
              className="h-6 inline-flex items-center rounded-md border border-line bg-panel px-2 text-[11px] text-ink-2 no-underline hover:text-ink-1 hover:border-line-strong"
            >
              {t("config_open_full_settings")}
            </Link>
            <button
              onClick={onClose}
              className="text-ink-3 hover:text-ink-1 text-[18px] leading-none"
            >
              ×
            </button>
          </div>
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
          {cfg.inngest.appErrors.length > 0 && (
            <Field
              label={t("config_app_errors")}
              value={cfg.inngest.appErrors
                .map((e) => `${e.name}: ${e.error}`)
                .join("  ")}
              mono
            />
          )}
          <Field label={t("config_fn_count")} value={String(cfg.inngest.registeredFunctionCount)} />
          <Field
            label={t("config_runs_24h")}
            value={cfg.inngest.runsLast24h?.toLocaleString() ?? "—"}
          />
          <Field
            label={t("config_last_probe")}
            value={new Date(cfg.inngest.lastProbeAt).toLocaleString()}
          />
          <MainInngestAppRegistration
            defaultUrl={cfg.inngest.serveEndpointUrl}
            compact
            onSynced={async () => {
              await reloadConfig().catch(() => undefined);
            }}
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

        {/* Infrastructure / deployment */}
        <Section title={t("config_infra_label")}>
          <Field label={t("config_serve_endpoint")} value={cfg.inngest.serveEndpointUrl} mono />
          <Field label="INNGEST_BASE_URL" value={cfg.inngest.altEnvs.INNGEST_BASE_URL ?? "—"} mono />
          <Field label="INNGEST_SERVE_ORIGIN" value={serveHost || "—"} mono />
          <Field label="INNGEST_SERVE_PATH" value={cfg.inngest.altEnvs.INNGEST_SERVE_PATH ?? "/api/inngest"} mono />
          <div className="mt-2 flex items-center gap-2">
            <Btn size="sm" onClick={runInfraCheck} disabled={checkingInfra}>
              {checkingInfra ? "…" : t("config_run_infra_check")}
            </Btn>
            {infraResult && <span className="text-[11px] text-ink-3">{infraResult}</span>}
          </div>
          <ConfigPageCta fields={cfg.runtimeConfig.fields.length} />
        </Section>
      </div>
    </>
  );
}

function inferServeHost(endpoint: string, path: string): string {
  if (!endpoint) return "";
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return endpoint.endsWith(cleanPath) ? endpoint.slice(0, -cleanPath.length) : endpoint.replace(/\/api\/inngest$/, "");
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

function ConfigPageCta({ fields }: { fields: number }) {
  const { t } = useApp();
  return (
    <div className="mt-4 rounded-md border border-line bg-panel px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11.5px] font-medium text-ink-2">{t("config_runtime_edit")}</div>
          <div className="mt-1 text-[11px] leading-5 text-ink-4">
            {t("config_full_settings_hint").replace("{n}", String(fields))}
          </div>
        </div>
        <Link
          href="/settings/system"
          className="h-6 inline-flex shrink-0 items-center rounded-md border border-line bg-surface px-2 text-[11px] text-ink-1 no-underline hover:border-line-strong"
        >
          {t("config_open_full_settings")}
        </Link>
      </div>
    </div>
  );
}
