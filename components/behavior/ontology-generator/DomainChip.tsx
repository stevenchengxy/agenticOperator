"use client";
import React from "react";
import clsx from "clsx";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";

// Business-domain selector for the Ontology Generator. Driven by the app-wide
// domain system (useDomain) — the SAME list + active domain as the AppBar
// switcher — so the two stay in sync: switching here switches globally, and
// vice-versa.
export function DomainChip() {
  const { t } = useApp();
  const { domain, setDomain, all, current } = useDomain();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const initial = (name: string) => name.trim().charAt(0) || "·";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-3 pl-2.5 pr-3 py-2 rounded-xl bg-surface border border-line hover:border-line-strong transition-colors"
      >
        <span
          className="w-9 h-9 rounded-lg grid place-items-center text-[15px] font-semibold text-white"
          style={{ background: current.color }}
        >
          {initial(current.name)}
        </span>
        <span className="text-left">
          <span className="block text-[10.5px] text-ink-4 leading-tight">{t("og_domain_label")}</span>
          <span className="block text-[14px] font-semibold text-ink-1 leading-tight">{current.name}</span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={clsx("text-ink-4 transition-transform", open && "rotate-180")}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[260px] rounded-xl bg-surface border border-line shadow-sh-2 overflow-hidden z-20 ao-pop-in">
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.06em] text-ink-4">
            {t("domain_switch_label")}
          </div>
          {all.map((d) => {
            const active = d.id === domain;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => {
                  setDomain(d.id);
                  setOpen(false);
                }}
                className={clsx(
                  "w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors",
                  active ? "bg-accent-bg" : "hover:bg-panel",
                )}
              >
                <span
                  className="flex-none w-8 h-8 rounded-lg grid place-items-center text-[13px] font-semibold text-white"
                  style={{ background: d.color }}
                >
                  {initial(d.name)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium text-ink-1 truncate">{d.name}</span>
                  <span className="block mono text-[10.5px] text-ink-4 truncate">{d.id}</span>
                </span>
                {active && (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--c-accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
