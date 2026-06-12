"use client";

import React from "react";
import clsx from "clsx";
import { Badge, Btn } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { useDomain, type Domain } from "@/lib/domains";
import { useApp } from "@/lib/i18n";

type SyncResult =
  | { ok: true; functionsRegistered: number | null }
  | { ok: false; error: string };

type MainAppProps = {
  defaultUrl: string;
  compact?: boolean;
  className?: string;
  onSynced?: () => void | Promise<void>;
};

export function MainInngestAppRegistration({
  defaultUrl,
  compact = false,
  className,
  onSynced,
}: MainAppProps) {
  const { t } = useApp();
  const browserUrl = React.useMemo(
    () => (typeof window !== "undefined" ? `${window.location.origin}/api/inngest` : ""),
    [],
  );
  const resolvedDefaultUrl = defaultUrl || browserUrl;
  const [url, setUrl] = React.useState<string>(resolvedDefaultUrl);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<SyncResult | null>(null);

  React.useEffect(() => {
    if (!url || url === browserUrl) setUrl(resolvedDefaultUrl);
  }, [browserUrl, resolvedDefaultUrl, url]);

  const onSync = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch("/api/inngest-admin/sync-app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? "sync failed");
      setResult({ ok: true, functionsRegistered: j.functionsRegistered ?? null });
      await onSynced?.();
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={clsx(compact ? "border-t border-line mt-3 pt-3" : "min-w-0 rounded-md border border-line bg-surface p-4", className)}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-ink-1">{t("settings_env_main_app_title")}</div>
          <div className="mt-1 max-w-[720px] text-[11.5px] leading-5 text-ink-3">
            {t("settings_env_main_app_hint")}
          </div>
        </div>
        {!compact && <Badge variant="info">agentic-operator-main</Badge>}
      </div>

      <div className="mt-3 flex min-w-0 flex-wrap items-stretch gap-1.5">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://host:port/api/inngest"
          className="h-8 min-w-[260px] flex-1 rounded-md border border-line bg-panel px-2.5 mono text-[12px] text-ink-1 outline-none focus:border-[color:var(--c-accent)]"
        />
        <button
          type="button"
          onClick={() => setUrl(resolvedDefaultUrl)}
          className="h-8 shrink-0 rounded-md border border-line bg-surface px-2.5 text-[11.5px] text-ink-3 hover:text-ink-1 hover:border-line-strong"
          title={resolvedDefaultUrl}
        >
          {t("sync_app_use_local")}
        </button>
        <Btn onClick={onSync} disabled={busy || !url.trim()} size="md">
          <Ic.bolt />{busy ? t("sync_app_syncing") : t("sync_app_button")}
        </Btn>
      </div>

      {result && (
        <div className={clsx("mt-2 text-[11.5px] leading-5", result.ok ? "text-[color:var(--c-ok)]" : "text-[color:var(--c-err)]")}>
          {result.ok ? (
            <>
              {t("sync_app_success")} ·{" "}
              {result.functionsRegistered != null
                ? t("sync_app_fn_count").replace("{n}", String(result.functionsRegistered))
                : t("sync_app_fn_count_unknown")}
            </>
          ) : (
            <span className="break-all">{t("sync_app_error")}: {result.error}</span>
          )}
        </div>
      )}
    </div>
  );
}

type DomainAppSyncState = {
  healthy: boolean;
  error: string | null;
  connected: boolean | null;
  functionCount: number | null;
  url: string | null;
  lastProbeAt: string;
};

type DomainAppState = {
  domain: string;
  appId: string;
  status: "online" | "offline";
  boundToMain: boolean;
  callbackUrl: string | null;
  registeredAt: string | null;
  deployedCount: number;
  sync: DomainAppSyncState | null;
};

type DomainActionResponse =
  | { ok: true; state: DomainAppState }
  | { ok: false; error?: string; state?: DomainAppState };

export function DomainInngestAppManager({ className }: { className?: string }) {
  const { t } = useApp();
  const { all, domain: activeDomain, setDomain } = useDomain();
  const [states, setStates] = React.useState<Record<string, DomainAppState>>({});
  const [loading, setLoading] = React.useState(true);
  const [busyDomain, setBusyDomain] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const pairs = await Promise.all(
        all.map(async (d) => {
          const r = await fetch(`/api/domains/${encodeURIComponent(d.id)}/inngest-app`, { cache: "no-store" });
          if (!r.ok) throw new Error(`${d.id}: ${r.status}`);
          return [d.id, (await r.json()) as DomainAppState] as const;
        }),
      );
      setStates(Object.fromEntries(pairs));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [all]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (id: string, action: "register" | "offline") => {
    setBusyDomain(id);
    setMessage(null);
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(id)}/inngest-app`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await r.json()) as DomainActionResponse;
      if (body.state) {
        setStates((prev) => ({ ...prev, [id]: body.state! }));
      }
      if (!r.ok || !body.ok) {
        const error = "error" in body ? body.error : undefined;
        throw new Error(error ?? "domain app action failed");
      }
      setMessage(action === "register" ? t("settings_env_domain_app_registered") : t("settings_env_domain_app_offlined"));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusyDomain(null);
    }
  };

  return (
    <div className={clsx("min-w-0 rounded-md border border-line bg-surface p-4", className)}>
      <div className="mb-3 flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-ink-1">{t("settings_env_domain_apps_title")}</div>
          <div className="mt-1 max-w-[780px] text-[11.5px] leading-5 text-ink-3">{t("settings_env_domain_apps_hint")}</div>
        </div>
        <Btn size="sm" onClick={load} disabled={loading || busyDomain !== null}>
          <Ic.clock />{loading ? "…" : t("settings_env_domain_apps_reload")}
        </Btn>
      </div>

      <div className="min-w-0 divide-y divide-line overflow-hidden rounded-md border border-line">
        {all.map((d) => (
          <DomainAppRow
            key={d.id}
            domain={d}
            state={states[d.id] ?? null}
            active={d.id === activeDomain}
            busy={busyDomain === d.id}
            onSelect={() => setDomain(d.id)}
            onRegister={() => runAction(d.id, "register")}
            onOffline={() => runAction(d.id, "offline")}
          />
        ))}
      </div>
      {message && (
        <div className="mt-2 text-[11.5px] leading-5 text-ink-3 break-all">{message}</div>
      )}
    </div>
  );
}

function DomainAppRow({
  domain,
  state,
  active,
  busy,
  onSelect,
  onRegister,
  onOffline,
}: {
  domain: Domain;
  state: DomainAppState | null;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onRegister: () => void;
  onOffline: () => void;
}) {
  const { t } = useApp();
  const status = state ? domainAppStatus(state) : "loading";
  const statusVariant =
    status === "online" ? "ok" :
      status === "error" ? "err" :
        status === "offline" ? "default" : "info";
  const callback = state?.callbackUrl ?? state?.sync?.url ?? "—";
  const canOffline = Boolean(state && !state.boundToMain && state.status === "online");
  const canRegister = Boolean(state && !state.boundToMain);

  return (
    <div className={clsx("grid min-w-0 grid-cols-1 gap-3 px-3 py-3 min-[1280px]:grid-cols-[minmax(180px,0.9fr)_minmax(220px,1.2fr)_auto]", active && "bg-panel/60")}>
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 border-0 bg-transparent p-0 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: domain.color }}
          />
          <span className="min-w-0 truncate text-[12.5px] font-medium text-ink-1">{domain.name}</span>
          {active && <Badge variant="info">{t("settings_env_domain_active")}</Badge>}
        </div>
        <div className="mt-1 mono text-[10.5px] text-ink-4 truncate">{domain.id}</div>
      </button>

      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant={statusVariant}>{statusLabel(status, t)}</Badge>
          {state?.boundToMain && <Badge variant="ok">{t("settings_env_domain_app_bound")}</Badge>}
          <span className="mono min-w-0 truncate text-[10.5px] text-ink-4">{state?.appId ?? `agentic-operator-${domain.id}`}</span>
        </div>
        <div className="mt-1 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-2 text-[10.5px] leading-5">
          <span className="text-ink-4">{t("settings_env_domain_app_callback")}</span>
          <span className="mono min-w-0 truncate text-ink-3" title={callback}>{compactValue(callback)}</span>
          <span className="text-ink-4">{t("settings_env_domain_app_functions")}</span>
          <span className="mono min-w-0 truncate text-ink-3">{state?.sync?.functionCount ?? state?.deployedCount ?? "—"}</span>
        </div>
        {state?.sync?.error && (
          <div className="mt-1 mono text-[10.5px] leading-4 text-[color:var(--c-err)] break-all">
            {t("dsw_sync_error").replace("{error}", state.sync.error)}
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-start gap-1.5 min-[1280px]:justify-end">
        {canRegister && (
          <Btn size="sm" onClick={onRegister} disabled={busy}>
            <Ic.bolt />{busy ? "…" : state?.status === "online" ? t("settings_env_domain_app_resync") : t("dsw_register")}
          </Btn>
        )}
        {canOffline && (
          <Btn size="sm" onClick={onOffline} disabled={busy}>
            <Ic.pause />{busy ? "…" : t("dsw_offline")}
          </Btn>
        )}
      </div>
    </div>
  );
}

function domainAppStatus(state: DomainAppState): "online" | "offline" | "error" {
  if (state.status === "online" && state.sync?.healthy === false) return "error";
  return state.status;
}

function statusLabel(status: "online" | "offline" | "error" | "loading", t: (key: string) => string): string {
  if (status === "online") return t("dsw_status_online");
  if (status === "offline") return t("dsw_status_offline");
  if (status === "error") return t("dsw_status_error");
  return "…";
}

function compactValue(value: string): string {
  if (!value || value === "—") return value;
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}
