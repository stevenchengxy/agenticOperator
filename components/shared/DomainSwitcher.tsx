"use client";

import React from "react";
import clsx from "clsx";
import { useDomain } from "@/lib/domains";
import { useApp } from "@/lib/i18n";
import { Ic } from "./Ic";
import { NewDomainModal } from "./NewDomainModal";
import { ManageDomainsModal } from "./ManageDomainsModal";

// Top-bar domain switcher. Sits in AppBar next to the EM pill / lang toggle.
// Phase 0: dropdown also exposes "+ 新建领域" + "⚙ 管理领域" entries.
// State persists to localStorage via DomainProvider; list comes from /api/domains.
type AppState = { status: "online" | "offline"; deployedCount: number; appId: string; boundToMain: boolean };

export function DomainSwitcher() {
  const { domain, setDomain, all, current } = useDomain();
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);
  const [manageOpen, setManageOpen] = React.useState(false);
  const [appState, setAppState] = React.useState<AppState | null>(null);
  const [appBusy, setAppBusy] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Inngest-app status for the active domain (loaded when the dropdown opens).
  const loadApp = React.useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(id)}/inngest-app`, { cache: "no-store" });
      setAppState((await r.json()) as AppState);
    } catch {
      setAppState(null);
    }
  }, []);
  React.useEffect(() => {
    if (open) loadApp(domain);
  }, [open, domain, loadApp]);

  async function appAction(action: "register" | "offline") {
    setAppBusy(true);
    try {
      await fetch(`/api/domains/${encodeURIComponent(domain)}/inngest-app`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await loadApp(domain);
    } finally {
      setAppBusy(false);
    }
  }

  return (
    <>
      <div className="relative" ref={wrapRef}>
        <button
          onClick={() => setOpen((o) => !o)}
          title={t("domain_switch_tooltip")}
          className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[11px] bg-panel border border-line text-ink-2 whitespace-nowrap cursor-pointer hover:border-line-strong"
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: current.color,
              boxShadow: `0 0 0 3px color-mix(in oklab, ${current.color} 18%, transparent)`,
            }}
          />
          <span className="font-medium text-ink-1">{current.name}</span>
          <span className="text-ink-4"><Ic.chev /></span>
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-1 min-w-[220px] bg-surface border border-line rounded-md shadow-sh-2 z-50 py-1">
            <div className="px-3 py-1 text-[10px] uppercase tracking-[0.06em] text-ink-4">
              {t("domain_switch_label")}
            </div>
            {all.map((d) => {
              const active = d.id === domain;
              return (
                <button
                  key={d.id}
                  onClick={() => {
                    setDomain(d.id);
                    setOpen(false);
                  }}
                  className={clsx(
                    "flex items-center gap-2 w-full px-3 py-1.5 text-[12px] cursor-pointer border-0",
                    active
                      ? "bg-accent-bg text-[color:var(--c-accent)] font-medium"
                      : "bg-transparent text-ink-2 hover:bg-panel hover:text-ink-1"
                  )}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: d.color,
                    }}
                  />
                  <span className="truncate">{d.name}</span>
                  {active && <span className="ml-auto text-[10px] mono">●</span>}
                </button>
              );
            })}
            {/* Per-domain Inngest app — register / take offline. Agents
                generated + deployed in this domain run as functions on it. */}
            <div className="my-1 border-t border-line" />
            <div className="px-3 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-[0.06em] text-ink-4">{t("dsw_app_label")}</span>
                <span
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border"
                  style={
                    appState?.status === "online"
                      ? { color: "var(--c-ok)", background: "var(--c-ok-bg)", borderColor: "color-mix(in oklab, var(--c-ok) 25%, transparent)" }
                      : { color: "var(--c-ink-3)", borderColor: "var(--c-line)" }
                  }
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: appState?.status === "online" ? "var(--c-ok)" : "var(--c-ink-4)" }} />
                  {appState?.status === "online" ? t("dsw_status_online") : t("dsw_status_offline")}
                </span>
              </div>
              <div className="mono text-[10px] text-ink-4 mt-0.5 truncate">{appState?.appId ?? `agentic-operator-${current.id}`}</div>
              {appState?.boundToMain ? (
                // raas / 业务领域 is served by the main app — no separate app.
                <div className="text-[10.5px] text-ink-4 mt-1.5">{t("dsw_bound_main")}</div>
              ) : (
                <div className="flex items-center gap-2 mt-1.5">
                  {appState?.status === "online" ? (
                    <button
                      onClick={() => appAction("offline")}
                      disabled={appBusy}
                      className="h-6 px-2.5 rounded-md text-[11.5px] bg-surface border border-line text-ink-2 hover:bg-panel disabled:opacity-50"
                    >
                      {appBusy ? "…" : t("dsw_offline")}
                    </button>
                  ) : (
                    <button
                      onClick={() => appAction("register")}
                      disabled={appBusy}
                      className="h-6 px-2.5 rounded-md text-[11.5px] font-medium text-white disabled:opacity-50"
                      style={{ background: "var(--c-accent)" }}
                    >
                      {appBusy ? "…" : t("dsw_register")}
                    </button>
                  )}
                  <span className="text-[10px] text-ink-4">
                    {t("dsw_app_agents").replace("{n}", String(appState?.deployedCount ?? 0))}
                  </span>
                </div>
              )}
            </div>

            <div className="my-1 border-t border-line" />
            <button
              onClick={() => {
                setOpen(false);
                setNewOpen(true);
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] cursor-pointer border-0 bg-transparent text-ink-2 hover:bg-panel hover:text-ink-1"
            >
              {t("domain_action_new")}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setManageOpen(true);
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] cursor-pointer border-0 bg-transparent text-ink-2 hover:bg-panel hover:text-ink-1"
            >
              {t("domain_action_manage")}
            </button>
          </div>
        )}
      </div>

      {newOpen && <NewDomainModal onClose={() => setNewOpen(false)} />}
      {manageOpen && <ManageDomainsModal onClose={() => setManageOpen(false)} />}
    </>
  );
}
