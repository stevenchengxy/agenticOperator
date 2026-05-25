"use client";

// AutoIterateDialog — UI for Bundle M.
// Operator triggers "🤖 Auto-iterate ≤3 rounds" → modal shows round-by-round
// progress: pipeline ms, verdict change, refinement rationale + expected delta.
// On finish, operator can "Adopt round X" to copy that round's businessLogic
// + code back into the main Codegen page state.

import React from "react";
import { useApp } from "@/lib/i18n";
import type { ReplacementVerdict } from "@/lib/agent-codegen/eval/evaluation-report";
import type {
  AutoIterateRunResult,
  IterationRecord,
} from "@/lib/agent-codegen/eval/auto-iterate";

export type OnAdoptArgs = {
  businessLogic: string;
  code: string;
  codePath: string;
};

export function AutoIterateDialog({
  running,
  result,
  error,
  onClose,
  onAdopt,
}: {
  running: boolean;
  result: AutoIterateRunResult | null;
  error: string | null;
  onClose: () => void;
  onAdopt: (args: OnAdoptArgs) => void;
}) {
  const { t } = useApp();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="rounded-lg border border-line bg-surface flex flex-col"
        style={{
          width: "min(960px, 94vw)",
          height: "min(720px, 88vh)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center gap-3 px-5 py-4 border-b border-line">
          <span className="text-[18px]">🤖</span>
          <div className="flex-1 min-w-0">
            <div
              className="text-ink-1"
              style={{
                fontFamily:
                  'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif',
                fontWeight: 500,
                fontSize: 20,
                letterSpacing: "-0.01em",
              }}
            >
              {t("autoiter_title")}
            </div>
            {result && (
              <div className="text-[11px] text-ink-4 mt-1">
                {result.rounds.length} rounds · {result.totalDurationMs} ms ·{" "}
                <StopReasonBadge reason={result.stopReason} />
              </div>
            )}
            {running && !result && (
              <div className="text-[11px] text-ink-4 mt-1">
                {t("autoiter_running_blurb")}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md grid place-items-center cursor-pointer border-0 bg-transparent text-ink-3 hover:text-ink-1 hover:bg-panel"
            title="close"
          >
            ×
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-auto p-5">
          {error ? (
            <ErrorState message={error} />
          ) : running && !result ? (
            <LoadingState />
          ) : !result ? null : (
            <RoundsView result={result} onAdopt={onAdopt} />
          )}
        </div>

        {/* Footer */}
        <footer className="px-5 py-3 border-t border-line flex items-center justify-end gap-2">
          <span className="text-[10.5px] text-ink-4 mr-auto">
            {t("autoiter_footer_note")}
          </span>
          <button
            onClick={onClose}
            className="h-8 px-4 rounded-md text-[12px] font-medium border-0 cursor-pointer bg-panel text-ink-2 hover:bg-surface"
          >
            {t("autoiter_close")}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────

function RoundsView({
  result,
  onAdopt,
}: {
  result: AutoIterateRunResult;
  onAdopt: (args: OnAdoptArgs) => void;
}) {
  const { t } = useApp();
  // Sort rounds DESC by score so the best is on top — operator usually
  // wants to adopt the strongest result regardless of which round it came in.
  const sorted = [...result.rounds].sort(
    (a, b) => b.evaluation.aggregateScore - a.evaluation.aggregateScore,
  );
  const bestId = sorted[0]?.round;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-ink-3 m-0 leading-relaxed">
        {t("autoiter_intro")}
      </p>
      {sorted.map((r) => (
        <RoundCard
          key={r.round}
          record={r}
          isBest={r.round === bestId}
          onAdopt={() =>
            onAdopt({
              businessLogic: r.businessLogic,
              code: r.code.content,
              codePath: r.code.path,
            })
          }
        />
      ))}
    </div>
  );
}

function RoundCard({
  record,
  isBest,
  onAdopt,
}: {
  record: IterationRecord;
  isBest: boolean;
  onAdopt: () => void;
}) {
  const { t } = useApp();
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const e = record.evaluation;
  const ref = record.refinement;
  const [showProse, setShowProse] = React.useState(false);

  return (
    <div
      className="rounded-md border bg-panel"
      style={{
        borderColor: isBest
          ? "color-mix(in oklab, var(--c-accent) 50%, var(--c-line))"
          : "var(--c-line)",
        boxShadow: isBest
          ? "0 0 0 2px color-mix(in oklab, var(--c-accent) 15%, transparent)"
          : "none",
      }}
    >
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-line">
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-ink-4 mono">
          {t("autoiter_round")} {record.round}
        </span>
        <VerdictPill verdict={e.finalVerdict} />
        <span className="text-[12px] mono font-semibold text-ink-1">
          {pct(e.aggregateScore)}
        </span>
        <span className="text-[10.5px] text-ink-4 mono">
          {record.pipelineTotalMs} ms
        </span>
        {isBest && (
          <span
            className="text-[10px] uppercase tracking-[0.08em] mono px-2 py-0.5 rounded ml-auto"
            style={{
              background: "color-mix(in oklab, var(--c-accent) 14%, transparent)",
              color: "var(--c-accent)",
              border: "1px solid color-mix(in oklab, var(--c-accent) 32%, transparent)",
            }}
          >
            ★ {t("autoiter_best")}
          </span>
        )}
        <button
          onClick={onAdopt}
          className={isBest ? "h-7 px-3 rounded-md text-[11px] font-medium border-0 cursor-pointer" : "h-7 px-3 rounded-md text-[11px] font-medium border-0 cursor-pointer ml-auto"}
          style={{ background: "var(--c-accent)", color: "white" }}
        >
          {t("autoiter_adopt")}
        </button>
      </header>

      <div className="px-4 py-3 flex flex-col gap-3 text-[11.5px]">
        {ref ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4">
              {t("autoiter_rationale")} ({ref.confidence})
            </div>
            <p className="m-0 text-ink-2 leading-relaxed">{ref.rationale}</p>
            {ref.expectedDelta.length > 0 && (
              <ul className="m-0 mt-1 pl-4 leading-relaxed text-ink-3">
                {ref.expectedDelta.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="text-[10.5px] text-ink-4 italic">
            {t("autoiter_baseline")}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Mini label="structural" value={pct(e.structural.composite)} />
          {e.behavioral && (
            <Mini label="behavioral" value={pct(e.behavioral.score)} />
          )}
          <Mini
            label="review"
            value={`${e.review.errorCount}e / ${e.review.warningCount}w`}
          />
          <Mini
            label="compile"
            value={e.compileOk ? "OK" : `${e.compileDiagnosticsCount} err`}
          />
        </div>

        {e.behavioral && e.behavioral.diff.missingSteps.length > 0 && (
          <div className="text-[10.5px] text-ink-4">
            {t("autoiter_missing_steps")}:{" "}
            <span className="mono">
              {e.behavioral.diff.missingSteps.map((s) => s.id).join(", ")}
            </span>
          </div>
        )}

        <button
          onClick={() => setShowProse((o) => !o)}
          className="text-[10.5px] text-ink-3 cursor-pointer border-0 bg-transparent inline-flex items-center gap-1.5 self-start hover:text-ink-1"
        >
          <span className="mono text-[10px]">{showProse ? "▼" : "▶"}</span>
          {showProse
            ? t("autoiter_hide_prose")
            : t("autoiter_show_prose")}
        </button>
        {showProse && (
          <pre
            className="m-0 p-2 bg-surface border border-line rounded text-[10.5px] leading-[1.5] mono overflow-auto whitespace-pre-wrap"
            style={{ maxHeight: 240 }}
          >
            {record.businessLogic}
          </pre>
        )}
      </div>
    </div>
  );
}

function VerdictPill({ verdict }: { verdict: ReplacementVerdict }) {
  const color =
    verdict === "FULL"
      ? "var(--c-ok)"
      : verdict === "PARTIAL"
      ? "var(--c-warn, oklch(0.65 0.14 75))"
      : "var(--c-err, oklch(0.5 0.2 25))";
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] mono font-semibold tracking-[0.06em]"
      style={{
        background: `color-mix(in oklab, ${color} 14%, transparent)`,
        color,
        border: `1px solid color-mix(in oklab, ${color} 32%, transparent)`,
      }}
    >
      {verdict}
    </span>
  );
}

function StopReasonBadge({ reason }: { reason: AutoIterateRunResult["stopReason"] }) {
  const { t } = useApp();
  const label =
    reason === "verdict-full"
      ? t("autoiter_stop_full")
      : reason === "no-improvement"
      ? t("autoiter_stop_noimprove")
      : reason === "max-iterations"
      ? t("autoiter_stop_maxiter")
      : t("autoiter_stop_error");
  return <span className="mono">{label}</span>;
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4">
        {label}
      </span>
      <span className="text-ink-1 mono">{value}</span>
    </div>
  );
}

function LoadingState() {
  const { t } = useApp();
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-ink-3">
      <div
        className="w-10 h-10 rounded-full anim-pulse"
        style={{ background: "var(--c-accent)" }}
      />
      <div className="text-[12.5px]">{t("autoiter_running")}</div>
      <div className="text-[11px] text-ink-4 max-w-[420px] text-center leading-relaxed">
        {t("autoiter_running_detail")}
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  const { t } = useApp();
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 gap-3 text-center max-w-[520px] mx-auto">
      <div
        className="w-12 h-12 rounded-full grid place-items-center text-[20px]"
        style={{
          background:
            "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 12%, transparent)",
          color: "var(--c-err, oklch(0.5 0.2 25))",
        }}
      >
        ✗
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[14px] font-medium text-ink-1">{t("autoiter_failed")}</div>
        <div className="text-[12px] text-ink-3 leading-relaxed">{message}</div>
      </div>
    </div>
  );
}
