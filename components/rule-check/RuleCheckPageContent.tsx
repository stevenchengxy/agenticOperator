"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { RuleCheckDashboardContent } from "./RuleCheckDashboardContent";
import { RuleCheckAuditsContent } from "./RuleCheckAuditsContent";

// Rule Check page — 2-layer view (2026-05-20 simplification):
//   总览 (macro Dashboard)   ← coverage, top failure rules, client distribution
//   审计 (audits list)       ← drill into past audits + Neo4j-stored prompt + response
//
// URL: ?view=dashboard | audits. Default = dashboard.

type View = "dashboard" | "audits";

export function RuleCheckPageContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const { t } = useApp();
  const rawView = sp.get("view");
  const view: View = rawView === "audits" ? "audits" : "dashboard";

  const VIEW_META: Record<View, { label: string; sub: string }> = {
    dashboard: { label: t("rc_view_dashboard"), sub: t("rc_view_dashboard_sub") },
    audits:    { label: t("rc_view_audits"),    sub: t("rc_view_audits_sub") },
  };

  const setView = (v: View) => {
    const next = new URLSearchParams(sp.toString());
    if (v === "dashboard") next.delete("view");
    else next.set("view", v);
    router.replace(`/rule-check${next.toString() ? `?${next.toString()}` : ""}`);
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-auto bg-bg rc-page-in">
      <div className="border-b border-line bg-bg/95" style={{ padding: "22px 32px 14px" }}>
        <div className="flex items-end justify-between gap-6">
          <div className="flex-1 min-w-0">
            <h1 className="m-0 text-ink-1" style={{ fontWeight: 560, fontSize: 25, lineHeight: 1.1 }}>
              {t("rc_page_title")}
            </h1>
            <div className="text-ink-3 mt-1" style={{ fontSize: 12.5 }}>
              {VIEW_META[view].sub}
            </div>
          </div>
          <div
            className="inline-flex items-center border border-line"
            style={{ padding: 3, borderRadius: 8, background: "var(--c-surface)" }}
          >
          {(Object.keys(VIEW_META) as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className="transition-all"
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: 0,
                background: view === v ? "var(--c-panel)" : "transparent",
                color: view === v ? "var(--c-ink-1)" : "var(--c-ink-3)",
                fontWeight: view === v ? 560 : 450,
                fontSize: 12.5,
                boxShadow: view === v ? "0 1px 2px rgba(15,23,42,0.06)" : "none",
              }}
            >
              {VIEW_META[v].label}
            </button>
          ))}
          </div>
        </div>
      </div>

      {/* body */}
      <div className="flex-1 min-h-0 overflow-auto">
        {view === "dashboard" && <RuleCheckDashboardContent />}
        {view === "audits"    && <RuleCheckAuditsContent />}
      </div>
    </div>
  );
}
