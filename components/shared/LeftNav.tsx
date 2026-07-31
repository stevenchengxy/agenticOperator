"use client";
import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Ic, IcName } from "./Ic";
import { useApp } from "@/lib/i18n";

type NavItem =
  | { type: "group"; title: string }
  | { type: "item"; id: string; icon: IcName; label: string; href: string };

// Build-time twin of FACTORY_ENABLED (lib/factory-flag.ts). NEXT_PUBLIC_* is
// baked into the browser bundle, so flipping it needs a rebuild — that is fine
// here: the server-side gate is what actually protects the routes, this only
// decides whether the menu item is rendered. Unset → same default as the
// server: on in dev, off in a production build.
const FACTORY_ENABLED =
  (process.env.NEXT_PUBLIC_FACTORY_ENABLED ?? "") !== ""
    ? process.env.NEXT_PUBLIC_FACTORY_ENABLED === "1"
    : process.env.NODE_ENV !== "production";

export function LeftNav() {
  const { t } = useApp();
  const pathname = usePathname();

  // IA reorg (UX review feedback):
  //   - "Operate" = the surfaces you ACT on daily (overview, fleet, monitor,
  //     inbox, alerts, chat). High-frequency, decision-oriented.
  //   - "Observability" = read-only inspection of the runtime (events,
  //     triggers, correlations, rule-check). Split out so the 11-item Operate
  //     bucket stays scannable and the daily-driver items float to the top.
  //   - "Build" = the only real authoring surfaces today (workflow + codegen).
  //   - "Govern" = Data Sources + Audit + Permissions + Compliance.
  //     Audit is real (`/audit` → AuditLog table); the others stay `#` as
  //     roadmap signals until their backends land.
  // Nav items carry no live counts — the rail is a pure navigation surface.
  // (Counts used to show fleet/monitor/inbox/workflow badges; removed per
  // product call so the sidebar stays calm and never shows a stale number.)
  const items: NavItem[] = [
    { type: "group", title: t("nav_group_operate") },
    { type: "item", id: "overview",   icon: "grid",     label: t("nav_overview"), href: "/overview" },
    { type: "item", id: "fleet",      icon: "cpu",      label: t("nav_fleet"), href: "/fleet" },
    { type: "item", id: "monitor",    icon: "gauge",    label: t("nav_monitor"), href: "/monitor" },
    { type: "item", id: "alerts",     icon: "bell",     label: t("nav_alerts"), href: "/notifications" },
    { type: "item", id: "chat",       icon: "chat",     label: t("nav_trace_chat"), href: "/chat" },
    { type: "group", title: t("nav_group_observe") },
    { type: "item", id: "events",     icon: "bolt",     label: t("nav_events"), href: "/events" },
    { type: "item", id: "triggers",   icon: "clock",    label: t("nav_triggers"), href: "/triggers" },
    { type: "item", id: "correlations", icon: "branch", label: t("nav_correlations"), href: "/correlations" },
    { type: "item", id: "funnel",     icon: "pulse",    label: t("nav_funnel"), href: "/funnel" },
    { type: "item", id: "rule-check", icon: "check",    label: t("nav_rule_check"), href: "/rule-check" },
    { type: "item", id: "analytics",  icon: "spark",    label: t("nav_analytics"), href: "/analytics" },
    { type: "group", title: t("nav_group_build") },
    { type: "item", id: "workflows",  icon: "workflow", label: t("nav_workflows"), href: "/workflow" },
    { type: "item", id: "ontology-gen", icon: "branch", label: t("nav_ontology_gen"), href: "/behavior/ontology-generator" },
    // The agent factory has moved to its own monorepo and is not served on a
    // production deployment — the page itself 404s there (lib/factory-flag.ts).
    // This build-time twin just keeps a dead link out of the rail.
    ...(FACTORY_ENABLED
      ? ([{ type: "item", id: "factory", icon: "bolt", label: t("nav_factory_v2"), href: "/behavior/factory-v3" }] as NavItem[])
      : []),
    { type: "item", id: "tools",      icon: "db",       label: t("nav_tools_library"), href: "/tools" },
    { type: "group", title: t("nav_group_govern") },
    { type: "item", id: "system-config", icon: "gear", label: t("settings_env_title"), href: "/settings/system" },
    { type: "item", id: "integrations", icon: "plug",   label: t("nav_integrations"), href: "/datasources" },
    { type: "item", id: "audit",      icon: "book",     label: t("nav_audit"), href: "/audit" },
    { type: "item", id: "permissions",icon: "key",      label: t("nav_permissions"), href: "#" },
    { type: "item", id: "compliance", icon: "shield",   label: t("nav_compliance"), href: "#" },
  ];

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  };

  // Below 1440px the rail collapses to icons (UX review): labels hide and
  // group headers become hairline dividers.
  return (
    <nav
      className="w-[56px] min-[1440px]:w-[184px] flex-none border-r border-line bg-surface flex flex-col gap-[2px] text-[12.5px]"
      style={{ padding: "10px 8px" }}
    >
      {items.map((it, i) => {
        if (it.type === "group") {
          return (
            <React.Fragment key={i}>
              {i !== 0 && (
                <div className="min-[1440px]:hidden h-px bg-line mx-1.5 my-1.5" aria-hidden />
              )}
              <div
                className="hidden min-[1440px]:block text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold"
                style={{ padding: "10px 8px 4px" }}
              >
                {it.title}
              </div>
            </React.Fragment>
          );
        }
        const Icon = Ic[it.icon];
        const active = isActive(it.href);
        return (
          <Link
            key={it.id}
            href={it.href}
            title={it.label}
            className={clsx(
              "flex items-center gap-[9px] px-2 py-[6px] rounded-md cursor-pointer no-underline justify-center min-[1440px]:justify-start",
              active ? "bg-accent-bg text-[color:var(--c-accent)] font-medium" : "text-ink-2 hover:bg-panel hover:text-ink-1"
            )}
          >
            <span className="w-[14px] inline-flex relative">
              <Icon />
            </span>
            <span className="hidden min-[1440px]:inline">{it.label}</span>
          </Link>
        );
      })}
      <div className="flex-1" />
    </nav>
  );
}
