"use client";

import React from "react";
import clsx from "clsx";
import { useDomain } from "@/lib/domains";
import { useApp } from "@/lib/i18n";
import { Ic } from "./Ic";

// Top-bar domain switcher. Sits in AppBar next to the EM pill / lang toggle.
// Click → dropdown → pick domain → re-scopes Fleet / Codegen / per-domain
// registries. State persists to localStorage via DomainProvider.
export function DomainSwitcher() {
  const { domain, setDomain, all } = useDomain();
  const { lang, t } = useApp();
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const current = all.find((d) => d.id === domain) ?? all[0];

  return (
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
        <span className="font-medium text-ink-1">{current.label[lang]}</span>
        <span className="text-ink-4"><Ic.chev /></span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 min-w-[180px] bg-surface border border-line rounded-md shadow-sh-2 z-50 py-1"
        >
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
                <span>{d.label[lang]}</span>
                {active && <span className="ml-auto text-[10px] mono">●</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
