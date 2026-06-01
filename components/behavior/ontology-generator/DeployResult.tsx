"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import type { GeneratedDraft } from "@/lib/ontology-generator/types";

// Step 3 success screen: green-check pop, summary, the generated drafts with
// 草稿 status badges, and the "再建一批" / "前往舰队部署 →" actions.
export function DeployResult({
  drafts,
  domainName,
  onAgain,
  onToFleet,
  onRun,
  runnable = false,
}: {
  drafts: GeneratedDraft[];
  domainName: string;
  onAgain: () => void;
  onToFleet: () => void;
  /** Fire the deployed agent chain once (seed event). Only for runnable domains. */
  onRun?: () => Promise<{ ok: boolean; caseId?: string; error?: string }>;
  runnable?: boolean;
}) {
  const { t, lang } = useApp();
  const n = drafts.length;

  const [runState, setRunState] = React.useState<"idle" | "running" | "done" | "error">("idle");
  const [runMsg, setRunMsg] = React.useState<string>("");

  async function handleRun() {
    if (!onRun) return;
    setRunState("running");
    setRunMsg("");
    try {
      const res = await onRun();
      if (res.ok) {
        setRunState("done");
        setRunMsg(res.caseId ?? "");
      } else {
        setRunState("error");
        setRunMsg(res.error ?? "");
      }
    } catch (e) {
      setRunState("error");
      setRunMsg((e as Error).message);
    }
  }

  return (
    <div className="grid place-items-center text-center px-6 py-12">
      <div className="w-full max-w-[760px]">
        {/* Green check */}
        <div
          className="og-check-pop mx-auto w-[84px] h-[84px] rounded-[22px] grid place-items-center"
          style={{
            background: "color-mix(in oklab, var(--c-ok) 16%, transparent)",
            boxShadow: "0 8px 30px color-mix(in oklab, var(--c-ok) 28%, transparent)",
          }}
        >
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--c-ok)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>

        <h2 className="mt-6 text-[24px] font-bold text-ink-1">
          {t("og_deploy_title").replace("{n}", String(n))}
        </h2>
        <p className="mt-3 text-[13.5px] text-ink-3 leading-relaxed max-w-[560px] mx-auto">
          {t("og_deploy_blurb").replace("{domain}", domainName)}
        </p>

        {/* Generated list */}
        <div className="mt-8 rounded-xl border border-line bg-surface overflow-hidden text-left">
          {drafts.map((d) => {
            const name = lang === "zh" ? d.nameZh : d.nameEn;
            return (
              <div key={d.key} className="flex items-center gap-3.5 px-4 py-3.5 border-b border-line last:border-b-0">
                <div
                  className="flex-none w-9 h-9 rounded-lg grid place-items-center text-[15px] font-semibold text-white"
                  style={{ background: d.iconColor }}
                >
                  {d.iconChar}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-ink-1">{name}</div>
                  <div className="mono text-[11px] text-ink-4 truncate">
                    {d.agentId} · {d.triggerEvent} → {d.emitEvent}
                  </div>
                </div>
                <span className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: "var(--c-ok)" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  {t("og_confidence_short").replace("{n}", String(d.confidence))}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border border-line text-ink-3">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--c-ink-4)" }} />
                  {t("og_status_draft")}
                </span>
              </div>
            );
          })}
        </div>

        {/* Run-once demo (runnable domains only) */}
        {runnable && onRun && (
          <div className="mt-6 rounded-xl border border-line bg-bg/40 px-4 py-4 text-left">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ink-1">
                  {lang === "zh" ? "运行一次演示" : "Run once"}
                </div>
                <div className="text-[11.5px] text-ink-4 mt-0.5">
                  {lang === "zh"
                    ? "发出起始事件，部署的智能体链路会真实跑起来并落日志"
                    : "Fires the seed event; the deployed agent chain runs and logs for real"}
                </div>
              </div>
              <button
                type="button"
                onClick={handleRun}
                disabled={runState === "running"}
                className="flex-none inline-flex items-center gap-2 h-9 px-4 rounded-lg text-[13px] font-semibold text-white transition-opacity disabled:opacity-50 hover:opacity-90"
                style={{ background: "var(--c-ok)" }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 3l14 9-14 9V3z" />
                </svg>
                {runState === "running"
                  ? lang === "zh" ? "运行中…" : "Running…"
                  : lang === "zh" ? "运行一次" : "Run once"}
              </button>
            </div>
            {runState === "done" && (
              <div className="mt-3 text-[12px] flex items-center gap-2" style={{ color: "var(--c-ok)" }}>
                <span>
                  {lang === "zh" ? "已发起运行" : "Run started"}
                  {runMsg ? ` · ${runMsg}` : ""}
                </span>
                <a href="/audit?tab=logs" className="underline text-ink-2 hover:text-ink-1">
                  {lang === "zh" ? "去 /audit 看运行日志 →" : "View run log in /audit →"}
                </a>
              </div>
            )}
            {runState === "error" && (
              <div className="mt-3 text-[12px]" style={{ color: "var(--c-bad, oklch(0.6 0.2 25))" }}>
                {lang === "zh" ? "运行失败:" : "Run failed: "} {runMsg}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="mt-8 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={onAgain}
            className="inline-flex items-center gap-2 h-10 px-5 rounded-lg text-[13px] font-medium bg-surface border border-line text-ink-1 hover:bg-panel transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {t("og_again")}
          </button>
          <button
            type="button"
            onClick={onToFleet}
            className="inline-flex items-center gap-2 h-10 px-5 rounded-lg text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
            style={{ background: "var(--c-accent)", boxShadow: "0 6px 22px color-mix(in oklab, var(--c-accent) 40%, transparent)" }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
            {t("og_to_fleet")}
          </button>
        </div>
      </div>
    </div>
  );
}
