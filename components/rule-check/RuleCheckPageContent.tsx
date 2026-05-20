"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RuleCheckDashboardContent } from "./RuleCheckDashboardContent";
import { RuleCheckAuditsContent } from "./RuleCheckAuditsContent";
import { RuleCheckContent } from "./RuleCheckContent";

// Rule Check page — 3-layer view per 2026-05-19 user request:
//   总览 (陈洋 macro Dashboard)   ← first thing leaders / operators see
//   审计 (我 mid Audits list)     ← drill into past audits
//   运行器 (叶洋 detail Runner)   ← live scenario runner with LLM trace
//
// URL: ?view=dashboard | audits | runner. Default = dashboard.

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

type View = "dashboard" | "audits" | "runner";

const VIEW_META: Record<View, { label: string; sub: string }> = {
  dashboard: { label: "总览",   sub: "覆盖率 · 失败率最高的 rules · 客户分布" },
  audits:    { label: "审计",   sub: "历史审计列表 · 按客户 / 决策 / JR 筛选" },
  runner:    { label: "运行器", sub: "场景集驱动的 rule check · LLM trace · 推理链" },
};

export function RuleCheckPageContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const view = (sp.get("view") ?? "dashboard") as View;

  const setView = (v: View) => {
    const next = new URLSearchParams(sp.toString());
    if (v === "dashboard") next.delete("view");
    else next.set("view", v);
    router.replace(`/rule-check${next.toString() ? `?${next.toString()}` : ""}`);
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-auto bg-bg">
      {/* page header — only on dashboard layer; the inner views render their own headers */}
      <div className="border-b border-line" style={{ padding: "24px 32px 12px" }}>
        <div className="flex items-start gap-6">
          <div className="flex-1 min-w-0">
            <h1 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontWeight: 500, fontSize: 26, letterSpacing: "-0.015em", lineHeight: 1.15 }}>
              规则检查
            </h1>
            <div className="text-ink-2 mt-1.5" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
              {VIEW_META[view].sub}
            </div>
          </div>
        </div>

        {/* layer tabs */}
        <div className="flex items-center gap-1 mt-4">
          {(Object.keys(VIEW_META) as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className="transition-colors"
              style={{
                padding: "8px 14px",
                borderBottom: view === v ? "1.5px solid var(--c-ink-1)" : "1.5px solid transparent",
                color: view === v ? "var(--c-ink-1)" : "var(--c-ink-3)",
                fontWeight: view === v ? 500 : 400,
                fontSize: 13,
                marginBottom: -1,
              }}
            >
              {VIEW_META[v].label}
            </button>
          ))}
        </div>
      </div>

      {/* body */}
      <div className="flex-1 min-h-0 overflow-auto">
        {view === "dashboard" && <RuleCheckDashboardContent />}
        {view === "audits"    && <RuleCheckAuditsContent />}
        {view === "runner"    && <RuleCheckContent />}
      </div>
    </div>
  );
}
