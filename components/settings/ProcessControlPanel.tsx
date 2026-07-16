"use client";

import React from "react";

import type {
  SystemProcessesActionResponse,
  SystemProcessesResponse,
} from "@/app/api/system/processes/route";
import { Badge, Btn } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { fetchJson } from "@/lib/api/client";
import { useApp } from "@/lib/i18n";
import type { ManagedProcessId, ManagedProcessStatus } from "@/server/ops/process-control";

type Props = {
  onChanged?: () => void;
};

type ActionKey = `${ManagedProcessId | "all"}:${"start" | "restart"}`;

export function ProcessControlPanel({ onChanged }: Props) {
  const { t } = useApp();
  const [data, setData] = React.useState<SystemProcessesResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<ActionKey | null>(null);
  const [message, setMessage] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await fetchJson<SystemProcessesResponse>("/api/system/processes", {
        cache: "no-store",
        timeoutMs: 12_000,
      });
      setData(next);
    } catch (e) {
      if (!silent) setMessage({ kind: "err", text: (e as Error).message });
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(true), 10_000);
    return () => window.clearInterval(id);
  }, [load]);

  const run = async (processId: ManagedProcessId | "all", action: "start" | "restart") => {
    const key: ActionKey = `${processId}:${action}`;
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch("/api/system/processes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ process: processId, action }),
      });
      const body = (await res.json().catch(() => ({}))) as SystemProcessesActionResponse;
      if (!res.ok || !body.ok) throw new Error(("error" in body && body.error) || "process action failed");
      setData({
        ok: true,
        enabled: body.enabled,
        processes: body.processes,
        generatedAt: body.generatedAt,
      });
      const failed = body.results.filter((r) => !r.ok);
      setMessage({
        kind: failed.length > 0 ? "err" : "ok",
        text: failed.length > 0
          ? failed.map((r) => `${r.status.label}: ${r.message}`).join("; ")
          : t("settings_process_action_done"),
      });
      onChanged?.();
    } catch (e) {
      setMessage({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const processes = data?.processes ?? [];
  const enabled = data?.enabled ?? false;

  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-medium text-ink-2">{t("settings_process_title")}</div>
          <div className="mt-1 max-w-[760px] text-[11.5px] leading-5 text-ink-4">
            {enabled ? t("settings_process_hint") : t("settings_process_disabled_hint")}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Btn size="sm" onClick={() => load()} disabled={loading || busy !== null}>
            <Ic.clock />{loading ? "…" : t("settings_process_refresh")}
          </Btn>
          <Btn
            size="sm"
            variant="accent"
            onClick={() => run("all", "restart")}
            disabled={!enabled || loading || busy !== null || processes.length === 0}
            title={t("settings_process_restart_all")}
          >
            <Ic.play />{busy === "all:restart" ? "…" : t("settings_process_restart_all")}
          </Btn>
        </div>
      </div>

      {message && (
        <div className={`mb-3 text-[12px] ${message.kind === "err" ? "text-[color:var(--c-err)]" : "text-[color:var(--c-ok)]"}`}>
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
        {processes.map((process) => (
          <ProcessCard
            key={process.id}
            process={process}
            enabled={enabled}
            busy={busy}
            onRun={run}
          />
        ))}
        {loading && processes.length === 0 && (
          <div className="rounded-md border border-line bg-surface p-4 text-[12px] text-ink-3">
            {t("settings_env_loading")}
          </div>
        )}
      </div>
    </section>
  );
}

function ProcessCard({
  process,
  enabled,
  busy,
  onRun,
}: {
  process: ManagedProcessStatus;
  enabled: boolean;
  busy: ActionKey | null;
  onRun: (id: ManagedProcessId, action: "start" | "restart") => void;
}) {
  const { t } = useApp();
  const action = process.state === "running" ? "restart" : "start";
  const actionKey: ActionKey = `${process.id}:${action}`;
  const disabled = !enabled || !process.available || busy !== null;

  return (
    <div className="min-w-0 rounded-md border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-ink-1">{process.label}</div>
          <div className="mt-1 text-[11.5px] leading-5 text-ink-4">{process.description}</div>
        </div>
        <Badge variant={stateVariant(process.state)} dot pulse={process.state === "running"}>
          {stateText(process.state, t)}
        </Badge>
      </div>

      <div className="mt-3 space-y-1">
        <InfoRow label="PID" value={process.pids.length > 0 ? process.pids.join(", ") : "—"} />
        <InfoRow label={t("settings_process_health")} value={healthSummary(process, t)} />
        <InfoRow label={t("settings_process_log")} value={process.logFile || "—"} />
        {process.details.map((detail) => (
          <InfoRow key={`${process.id}:${detail.label}`} label={detail.label} value={detail.value || "—"} />
        ))}
        {process.health.endpoint && (
          <InfoRow label={t("settings_process_probe")} value={process.health.endpoint} />
        )}
        {process.unavailableReason && (
          <div className="pt-1 text-[11px] leading-5 text-[color:var(--c-warn)] break-words">
            {process.unavailableReason}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn
          size="sm"
          onClick={() => onRun(process.id, action)}
          disabled={disabled}
          title={action === "restart" ? t("settings_process_restart") : t("settings_process_start")}
        >
          <Ic.play />{busy === actionKey ? "…" : action === "restart" ? t("settings_process_restart") : t("settings_process_start")}
        </Btn>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-2 text-[11px] leading-5">
      <span className="text-ink-4 whitespace-nowrap">{label}</span>
      <span className="min-w-0 truncate mono text-ink-3" title={value}>{value}</span>
    </div>
  );
}

function healthSummary(process: ManagedProcessStatus, t: (key: string) => string): string {
  const { state, message, latencyMs } = process.health;
  const parts = [t(`settings_process_health_${state}`), message].filter(Boolean);
  if (latencyMs !== null) parts.push(`${latencyMs}ms`);
  return parts.join(" · ") || "—";
}

function stateVariant(state: ManagedProcessStatus["state"]): "default" | "ok" | "warn" | "err" | "info" {
  if (state === "running") return "ok";
  if (state === "stopped") return "warn";
  return "default";
}

function stateText(state: ManagedProcessStatus["state"], t: (key: string) => string): string {
  if (state === "running") return t("settings_process_running");
  if (state === "stopped") return t("settings_process_stopped");
  return t("settings_process_unavailable");
}
