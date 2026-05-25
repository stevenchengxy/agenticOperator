"use client";

// EvaluationPanel — Codegen-page rendering of EvaluationReport.
//
// Renders the 4 evaluation sections (structural / review / behavioral /
// test cases) + the final verdict. Triggered automatically after a
// successful generate (when spec + code + compile.ok are all present),
// or manually via the "Re-evaluate" button.
//
// Sections render only when their data is meaningful — e.g., behavioral
// section only appears when a ground truth record exists for the slug.

import React from "react";
import { useApp } from "@/lib/i18n";
import type {
  EvaluationReport,
  ReplacementVerdict,
} from "@/lib/agent-codegen/eval/evaluation-report";
import type { ReviewIssue } from "@/lib/agent-codegen/eval/code-reviewer";

export function EvaluationPanel({
  report,
  running,
  error,
  onRun,
  canRun,
}: {
  report: EvaluationReport | null;
  running: boolean;
  error: string | null;
  onRun: () => void;
  canRun: boolean;
}) {
  const { t } = useApp();

  if (error) {
    return (
      <div className="p-6">
        <div
          className="px-4 py-3 rounded-md border text-[12.5px]"
          style={{
            borderColor: "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 30%, var(--c-line))",
            background: "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 6%, var(--c-panel))",
            color: "var(--c-err, oklch(0.5 0.2 25))",
          }}
        >
          <div className="font-medium text-[11px] uppercase tracking-[0.06em] mb-1">
            {t("eval_failure")}
          </div>
          <div className="leading-snug">{error}</div>
        </div>
        <RunButton onRun={onRun} canRun={canRun} running={running} />
      </div>
    );
  }

  if (running && !report) {
    return (
      <div className="p-8 flex flex-col items-center justify-center gap-3 text-ink-3">
        <div
          className="w-8 h-8 rounded-full anim-pulse"
          style={{ background: "var(--c-accent)" }}
        />
        <div className="text-[12.5px]">{t("eval_running")}</div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="p-8 flex flex-col items-center justify-center gap-4 text-center max-w-[480px] mx-auto">
        <div
          className="w-12 h-12 rounded-full grid place-items-center text-[20px]"
          style={{ background: "var(--c-panel)", color: "var(--c-ink-4)" }}
        >
          ⧖
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-[14px] font-medium text-ink-1">{t("eval_empty_title")}</div>
          <div className="text-[12px] text-ink-4 leading-relaxed">{t("eval_empty_blurb")}</div>
        </div>
        <RunButton onRun={onRun} canRun={canRun} running={running} />
      </div>
    );
  }

  return (
    <div className="overflow-auto p-6 max-w-[920px] mx-auto flex flex-col gap-6">
      <VerdictHeader report={report} />
      <StructuralSection report={report} />
      <ReviewSection issues={report.review.issues} />
      {report.behavioral ? (
        <BehavioralSection report={report} />
      ) : (
        <NoGroundTruthSection fixtureName={report.fixtureName} />
      )}
      <TestCasesSection report={report} />
      <div className="flex justify-end">
        <RunButton onRun={onRun} canRun={canRun} running={running} label={t("eval_rerun")} />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sections
// ────────────────────────────────────────────────────────────────────────

function VerdictHeader({ report }: { report: EvaluationReport }) {
  const { t } = useApp();
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    <div
      className="flex items-stretch gap-4 p-5 rounded-xl border border-line"
      style={{ background: "var(--c-surface)" }}
    >
      <VerdictBadge verdict={report.finalVerdict} />
      <div className="flex-1 flex flex-col gap-2 min-w-0">
        <div className="flex items-baseline gap-3">
          <span className="text-[26px] font-semibold text-ink-1 mono leading-none">
            {pct(report.aggregateScore)}
          </span>
          <span className="text-[10.5px] uppercase tracking-[0.08em] text-ink-4">
            {t("eval_aggregate")}
          </span>
        </div>
        <div className="flex gap-4 text-[11px] text-ink-3">
          <MiniStat label={t("eval_structural")} value={pct(report.structural.composite)} />
          {report.behavioral && (
            <MiniStat label={t("eval_behavioral")} value={pct(report.behavioral.score)} />
          )}
          <MiniStat
            label={t("eval_review")}
            value={`${report.review.errorCount}e / ${report.review.warningCount}w`}
          />
          <MiniStat
            label={t("eval_compile")}
            value={report.compileOk ? "OK" : `${report.compileDiagnosticsCount} err`}
          />
        </div>
        <p className="text-[11.5px] text-ink-2 leading-relaxed m-0 mt-1 whitespace-pre-wrap">
          {report.summary}
        </p>
      </div>
    </div>
  );
}

function StructuralSection({ report }: { report: EvaluationReport }) {
  const { t } = useApp();
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const dims = [
    { key: "imports", value: report.structural.imports },
    { key: "steps", value: report.structural.steps },
    { key: "tools", value: report.structural.tools },
    { key: "patterns", value: report.structural.patterns },
    { key: "loc", value: report.structural.loc },
  ];
  return (
    <Section title={t("eval_section_structural")} number={1}>
      <div className="grid grid-cols-5 gap-2">
        {dims.map((d) => (
          <DimCell key={d.key} label={t(`eval_dim_${d.key}`)} value={pct(d.value)} score={d.value} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 mt-3">
        <ListChip
          label={t("eval_missing_imports")}
          items={report.structural.details.missingImports}
          tone="warn"
        />
        <ListChip
          label={t("eval_missing_steps")}
          items={report.structural.details.missingSteps}
          tone="warn"
        />
        <ListChip
          label={t("eval_extra_imports")}
          items={report.structural.details.extraImports}
          tone="info"
        />
        <ListChip
          label={t("eval_extra_steps")}
          items={report.structural.details.extraSteps}
          tone="info"
        />
      </div>
    </Section>
  );
}

function ReviewSection({ issues }: { issues: ReviewIssue[] }) {
  const { t } = useApp();
  if (issues.length === 0) {
    return (
      <Section title={t("eval_section_review")} number={2}>
        <div className="text-[12px] text-ink-3">{t("eval_review_clean")}</div>
      </Section>
    );
  }
  // Group by severity for readability.
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const infos = issues.filter((i) => i.severity === "info");

  return (
    <Section title={t("eval_section_review")} number={2}>
      <div className="flex flex-col gap-2.5">
        {[...errors, ...warnings, ...infos].map((issue, i) => (
          <IssueRow key={i} issue={issue} />
        ))}
      </div>
    </Section>
  );
}

function BehavioralSection({ report }: { report: EvaluationReport }) {
  const { t } = useApp();
  const b = report.behavioral!;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    <Section title={t("eval_section_behavioral")} number={3}>
      <div className="flex items-center gap-3 mb-3">
        <span className="text-[18px] font-semibold mono text-ink-1">{pct(b.score)}</span>
        <VerdictBadge verdict={b.verdict} small />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ListChip
          label={t("eval_matched_steps")}
          items={b.diff.matchedSteps.map((s) => s.id)}
          tone="ok"
        />
        <ListChip
          label={t("eval_missing_steps_behavioral")}
          items={b.diff.missingSteps.map((s) => s.id)}
          tone="warn"
        />
        <ListChip
          label={t("eval_matched_emits")}
          items={b.diff.matchedEmits.map((e) => e.name)}
          tone="ok"
        />
        <ListChip
          label={t("eval_unexpected_steps")}
          items={b.diff.unexpectedSteps.map((s) => s.id)}
          tone="info"
        />
      </div>
      <div className="mt-3 px-3 py-2 rounded-md border border-line bg-panel text-[11px] text-ink-2 flex gap-4 flex-wrap">
        <ConvFlag label="NonRetriableError" met={b.diff.conventionsMet.nonRetriable} />
        <ConvFlag label="try / catch" met={b.diff.conventionsMet.tryCatch} />
        <ConvFlag
          label={`${b.diff.conventionsMet.loggerCalls} logger calls`}
          met={b.diff.conventionsMet.loggerCallsMet}
        />
      </div>
    </Section>
  );
}

function NoGroundTruthSection({ fixtureName }: { fixtureName: string }) {
  const { t } = useApp();
  return (
    <Section title={t("eval_section_behavioral")} number={3}>
      <div className="text-[12px] text-ink-3 leading-relaxed">
        {t("eval_no_ground_truth").replace("{slug}", fixtureName)}
      </div>
    </Section>
  );
}

function TestCasesSection({ report }: { report: EvaluationReport }) {
  const { t } = useApp();
  const [open, setOpen] = React.useState<number | null>(null);
  return (
    <Section
      title={t("eval_section_test_cases")}
      number={4}
      subtitle={t("eval_test_cases_blurb")}
    >
      <ol className="m-0 p-0 list-none flex flex-col gap-2">
        {report.generatedTestCases.map((tc, i) => {
          const isOpen = open === i;
          return (
            <li
              key={i}
              className="rounded-md border border-line bg-panel overflow-hidden"
            >
              <button
                onClick={() => setOpen(isOpen ? null : i)}
                className="w-full px-3 py-2 flex items-center gap-3 cursor-pointer border-0 bg-transparent text-left"
              >
                <CategoryChip category={tc.category} />
                <span className="text-[12px] text-ink-1 font-medium flex-1 min-w-0 truncate">
                  {tc.name}
                </span>
                <span className="text-[10px] mono text-ink-4">
                  {isOpen ? "▼" : "▶"}
                </span>
              </button>
              {isOpen && (
                <div
                  className="px-3 py-2.5 border-t border-line bg-surface text-[11px] flex flex-col gap-2"
                >
                  <KV label={t("eval_tc_desc")} value={tc.description} multiline />
                  <KV
                    label={t("eval_tc_event")}
                    value={`${tc.inputEvent.name}\n${JSON.stringify(tc.inputEvent.data, null, 2)}`}
                    code
                  />
                  <KV
                    label={t("eval_tc_mocks")}
                    value={tc.mockSetup
                      .map(
                        (m) =>
                          `  ${m.toolId} → ${
                            m.returns === "__throw4xx__"
                              ? "throw 4xx"
                              : m.returns === "__throw5xx__"
                              ? "throw 5xx"
                              : JSON.stringify(m.returns).slice(0, 80)
                          }`,
                      )
                      .join("\n")}
                    code
                  />
                  <KV
                    label={t("eval_tc_expected")}
                    value={`handler: ${tc.expectedOutcome.handlerResolves}\nemits: [${tc.expectedOutcome.expectedEmits.join(", ") || "—"}]`}
                    code
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Building blocks
// ────────────────────────────────────────────────────────────────────────

function Section({
  title,
  number,
  subtitle,
  children,
}: {
  title: string;
  number: number;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline gap-2">
        <span
          className="text-[10px] mono w-[18px] text-center text-ink-4"
          style={{ borderRight: "1px solid var(--c-line)", paddingRight: 4 }}
        >
          {number}
        </span>
        <h3
          className="m-0 text-ink-1"
          style={{
            fontFamily:
              'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif',
            fontWeight: 500,
            fontSize: 17,
          }}
        >
          {title}
        </h3>
        {subtitle && <span className="text-[10.5px] text-ink-4">{subtitle}</span>}
      </header>
      <div>{children}</div>
    </section>
  );
}

function VerdictBadge({
  verdict,
  small = false,
}: {
  verdict: ReplacementVerdict;
  small?: boolean;
}) {
  const map: Record<ReplacementVerdict, { color: string; label: string }> = {
    FULL: { color: "var(--c-ok)", label: "FULL" },
    PARTIAL: { color: "var(--c-warn, oklch(0.65 0.14 75))", label: "PARTIAL" },
    DRAFT: { color: "var(--c-err, oklch(0.5 0.2 25))", label: "DRAFT" },
  };
  const cfg = map[verdict];
  const size = small ? { padding: "3px 8px", fontSize: 10 } : { padding: "8px 12px", fontSize: 13 };
  return (
    <span
      className="inline-flex items-center font-semibold mono rounded-md tracking-[0.06em]"
      style={{
        background: cfg.color,
        color: "white",
        boxShadow: `0 0 0 4px color-mix(in oklab, ${cfg.color} 18%, transparent)`,
        ...size,
      }}
    >
      {cfg.label}
    </span>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-ink-4 uppercase tracking-[0.06em] text-[9.5px]">{label}</span>
      <span className="text-ink-1 mono">{value}</span>
    </div>
  );
}

function DimCell({ label, value, score }: { label: string; value: string; score: number }) {
  const color =
    score >= 0.85
      ? "var(--c-ok)"
      : score >= 0.5
      ? "var(--c-warn, oklch(0.65 0.14 75))"
      : "var(--c-err, oklch(0.5 0.2 25))";
  return (
    <div
      className="rounded-md border border-line p-2.5 flex flex-col gap-1.5"
      style={{ background: "var(--c-panel)" }}
    >
      <div className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4">{label}</div>
      <div className="text-[16px] font-semibold mono" style={{ color }}>
        {value}
      </div>
      <div
        className="h-[3px] rounded-full overflow-hidden"
        style={{ background: "color-mix(in oklab, var(--c-line) 60%, transparent)" }}
      >
        <div
          style={{
            width: `${Math.max(2, score * 100)}%`,
            height: "100%",
            background: color,
            transition: "width 200ms ease",
          }}
        />
      </div>
    </div>
  );
}

function ListChip({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone: "ok" | "warn" | "info";
}) {
  if (items.length === 0) return null;
  const color =
    tone === "ok"
      ? "var(--c-ok)"
      : tone === "warn"
      ? "var(--c-warn, oklch(0.65 0.14 75))"
      : "var(--c-ink-3)";
  return (
    <div
      className="rounded-md border border-line p-2.5 flex flex-col gap-1.5"
      style={{ background: "var(--c-panel)" }}
    >
      <div className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4 flex items-center gap-1.5">
        <span style={{ color }}>●</span>
        {label}
        <span className="ml-auto mono text-ink-4 text-[9.5px]">{items.length}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {items.map((it) => (
          <span
            key={it}
            className="mono text-[10px] px-1.5 py-0.5 rounded"
            style={{
              background: "var(--c-surface)",
              border: "1px solid var(--c-line)",
              color: "var(--c-ink-2)",
            }}
          >
            {it}
          </span>
        ))}
      </div>
    </div>
  );
}

function IssueRow({ issue }: { issue: ReviewIssue }) {
  const sevColor =
    issue.severity === "error"
      ? "var(--c-err, oklch(0.5 0.2 25))"
      : issue.severity === "warning"
      ? "var(--c-warn, oklch(0.65 0.14 75))"
      : "var(--c-ink-3)";
  return (
    <div
      className="px-3 py-2.5 rounded-md border flex flex-col gap-1"
      style={{
        background: "var(--c-panel)",
        borderColor:
          issue.severity === "error"
            ? "color-mix(in oklab, var(--c-err, oklch(0.5 0.2 25)) 30%, var(--c-line))"
            : "var(--c-line)",
      }}
    >
      <div className="flex items-center gap-2 text-[10.5px] mono">
        <span
          style={{
            color: sevColor,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {issue.severity}
        </span>
        <span className="text-ink-3">{issue.ruleId}</span>
        {issue.line !== undefined && (
          <span className="text-ink-4 ml-auto">L{issue.line}</span>
        )}
      </div>
      <div className="text-[12px] text-ink-1 leading-snug">{issue.message}</div>
      {issue.hint && (
        <div className="text-[11px] text-ink-3 leading-snug pl-3" style={{ borderLeft: "2px solid var(--c-line)" }}>
          → {issue.hint}
        </div>
      )}
    </div>
  );
}

function ConvFlag({ label, met }: { label: string; met: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{ color: met ? "var(--c-ok)" : "var(--c-err, oklch(0.5 0.2 25))" }}
    >
      <span>{met ? "✓" : "✗"}</span>
      <span style={{ color: "var(--c-ink-2)" }}>{label}</span>
    </span>
  );
}

function CategoryChip({ category }: { category: string }) {
  const colors: Record<string, string> = {
    "happy-path": "var(--c-ok)",
    "missing-trigger-field": "var(--c-warn, oklch(0.65 0.14 75))",
    "downstream-4xx": "var(--c-err, oklch(0.5 0.2 25))",
    idempotency: "var(--c-accent)",
  };
  const color = colors[category] ?? "var(--c-ink-3)";
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] uppercase tracking-[0.06em] mono"
      style={{
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        color,
        border: `1px solid color-mix(in oklab, ${color} 30%, transparent)`,
      }}
    >
      {category}
    </span>
  );
}

function KV({
  label,
  value,
  code = false,
  multiline = false,
}: {
  label: string;
  value: string;
  code?: boolean;
  multiline?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9.5px] uppercase tracking-[0.08em] text-ink-4">{label}</span>
      {code ? (
        <pre
          className="m-0 p-2 bg-panel border border-line rounded text-[10.5px] leading-[1.45] mono overflow-auto whitespace-pre"
          style={{ maxHeight: 200 }}
        >
          {value}
        </pre>
      ) : (
        <div
          className="text-[11.5px] text-ink-2 leading-snug"
          style={{ whiteSpace: multiline ? "pre-wrap" : "normal" }}
        >
          {value}
        </div>
      )}
    </div>
  );
}

function RunButton({
  onRun,
  canRun,
  running,
  label,
}: {
  onRun: () => void;
  canRun: boolean;
  running: boolean;
  label?: string;
}) {
  const { t } = useApp();
  return (
    <button
      onClick={onRun}
      disabled={!canRun || running}
      className="h-8 px-4 rounded-md text-[12px] font-medium border-0 cursor-pointer mt-4 self-start"
      style={{
        background: !canRun || running ? "var(--c-panel)" : "var(--c-accent)",
        color: !canRun || running ? "var(--c-ink-4)" : "white",
      }}
    >
      {running ? t("eval_running") : label || t("eval_run")}
    </button>
  );
}
