"use client";
import React from "react";
import clsx from "clsx";
import { useApp } from "@/lib/i18n";
import { Ic, type IcName } from "@/components/shared/Ic";
import type { InferredAgentCandidate, OntologyCounts } from "@/lib/ontology-generator/types";
import {
  buildReasoningTrace,
  traceTokenTarget,
  INFER_DURATION_MS,
  CHIP_KINDS,
  type ReasoningStep,
  type StepKind,
} from "@/lib/ontology-generator/reasoning-trace";

// The immersive "the architect agent is thinking" stage, shown while phase ===
// "inferring". Streams an LLM-style reasoning trace (built from the REAL inferred
// candidates) on the left while emergent agent cards pop in on the right, paced
// over a fixed 10s window so it reads as genuine, deliberate reasoning. When the
// timeline completes it calls onDone() and the parent hands off to the selection
// screen. Total duration is pinned by INFER_DURATION_MS in reasoning-trace.ts;
// per-step pacing still scales with the trace's weight within that window.

// ── Per-step visual vocabulary ───────────────────────────────────────────────
const KIND_META: Record<StepKind, { label: string; icon: IcName; color: string }> = {
  READ: { label: "READ", icon: "db", color: "oklch(0.6 0.13 235)" },
  DEDUCE: { label: "DEDUCE", icon: "branch", color: "oklch(0.6 0.12 275)" },
  WEIGH: { label: "WEIGH", icon: "gauge", color: "oklch(0.64 0.13 75)" },
  THINK: { label: "THINK", icon: "sparkle", color: "oklch(0.62 0.16 300)" },
  LINK: { label: "LINK", icon: "link", color: "oklch(0.6 0.13 235)" },
  SCORE: { label: "SCORE", icon: "pulse", color: "var(--c-ok)" },
  INFER: { label: "INFER", icon: "cpu", color: "var(--c-ok)" },
  DONE: { label: "DONE", icon: "check", color: "var(--c-ok)" },
};

const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

/** Drives a 0..1 timeline over totalMs; finish() jumps to the end. Calls onDone
 *  once when it reaches 1 (or immediately, after a beat, under reduced motion). */
function useReasoningDirector(totalMs: number, onDone: () => void) {
  const [progress, setProgress] = React.useState(0);
  const reduced = usePrefersReducedMotion();
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;
  const skipRef = React.useRef(false);
  const firedRef = React.useRef(false);

  React.useEffect(() => {
    if (reduced) {
      setProgress(1);
      const id = window.setTimeout(() => {
        if (!firedRef.current) {
          firedRef.current = true;
          onDoneRef.current();
        }
      }, 600);
      return () => window.clearTimeout(id);
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = skipRef.current ? 1 : Math.min(1, (now - start) / totalMs);
      setProgress(p);
      if (p >= 1) {
        if (!firedRef.current) {
          firedRef.current = true;
          onDoneRef.current();
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [totalMs, reduced]);

  const finish = React.useCallback(() => {
    skipRef.current = true;
  }, []);

  return { progress, finish };
}

export function InferReasoning({
  candidates,
  counts,
  onDone,
}: {
  candidates: InferredAgentCandidate[];
  counts: OntologyCounts;
  onDone: () => void;
}) {
  const { t, lang } = useApp();
  const steps = React.useMemo(
    () => buildReasoningTrace(candidates, counts, lang),
    [candidates, counts, lang],
  );
  const tokenTarget = React.useMemo(() => traceTokenTarget(candidates), [candidates]);
  const totalMs = INFER_DURATION_MS;

  const { progress, finish } = useReasoningDirector(totalMs, onDone);

  const shown = steps.filter((s) => s.at <= progress);
  const seenKinds = new Set(shown.map((s) => s.kind));
  // Cards emerge on the right driven by the candidate list — not the trace's INFER
  // lines — so every inferred agent still pops in even when the trace folds most
  // of them into a single summary line. Spread evenly across the timeline.
  const n = candidates.length;
  const emergentKeys = candidates
    .filter((_, i) => (n <= 1 ? 0.5 : 0.12 + (0.8 * i) / (n - 1)) <= progress)
    .map((c) => c.key);
  const tokens = Math.round(tokenTarget * easeOut(progress));
  const percent = Math.round(progress * 100);
  const reasoning = progress < 1;

  const candByKey = React.useMemo(() => {
    const m = new Map<string, InferredAgentCandidate>();
    for (const c of candidates) m.set(c.key, c);
    return m;
  }, [candidates]);

  // Auto-scroll the trace so the newest line stays in view.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <div className="rounded-2xl border border-line bg-bg overflow-hidden" style={{ minHeight: 560 }}>
      {/* Header */}
      <div className="flex items-center gap-3.5 px-5 py-4 border-b border-line">
        <div
          className="og-reason-core relative flex-none w-11 h-11 rounded-[14px] grid place-items-center text-white"
          style={{
            background: "linear-gradient(150deg, oklch(0.7 0.13 280), var(--c-accent))",
            boxShadow: "0 6px 20px color-mix(in oklab, var(--c-accent) 45%, transparent)",
          }}
        >
          <Ic.cpu width={22} height={22} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-ink-1">{t("og_reason_architect")}</span>
            <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: "var(--c-accent)" }}>
              <span className="og-reason-dot w-1.5 h-1.5 rounded-full" style={{ background: "var(--c-accent)" }} />
              {reasoning ? t("og_reason_status") : t("og_reason_done")}
            </span>
          </div>
          <div className="mono text-[11.5px] text-ink-4 truncate">agent-architect · ontology-reasoner v3</div>
        </div>

        <div className="ml-auto flex items-center gap-3">
          {/* Step-type chips that light up as kinds appear */}
          <div className="hidden sm:flex items-center gap-1.5">
            {CHIP_KINDS.map((k) => {
              const meta = KIND_META[k];
              const lit = seenKinds.has(k);
              const Glyph = Ic[meta.icon];
              return (
                <span
                  key={k}
                  title={meta.label}
                  className={clsx("w-7 h-7 rounded-lg grid place-items-center border transition-all duration-300")}
                  style={{
                    color: lit ? meta.color : "var(--c-ink-4)",
                    borderColor: lit ? `color-mix(in oklab, ${meta.color} 50%, transparent)` : "var(--c-line)",
                    background: lit ? `color-mix(in oklab, ${meta.color} 14%, transparent)` : "transparent",
                    opacity: lit ? 1 : 0.45,
                  }}
                >
                  <Glyph width={14} height={14} />
                </span>
              );
            })}
          </div>
          <span className="mono text-[12.5px] text-ink-3 tabular-nums">
            {tokens.toLocaleString()} <span className="text-ink-4">tokens</span>
          </span>
        </div>
      </div>

      {/* Body: trace + emergent agents */}
      <div className="grid" style={{ gridTemplateColumns: "1fr 320px" }}>
        {/* Left — streaming reasoning trace */}
        <div
          ref={scrollRef}
          className="relative px-5 py-4 border-r border-line overflow-y-auto"
          style={{ height: 460 }}
        >
          <div className="absolute inset-0 og-grid pointer-events-none opacity-40" aria-hidden />
          <div className="relative flex flex-col gap-2.5">
            {shown.map((step) => (
              <TraceLine key={step.id} step={step} />
            ))}
            {reasoning && shown.length < steps.length && <ThinkingRow label={t("og_reason_thinking")} />}
          </div>
        </div>

        {/* Right — emergent agents */}
        <div className="px-4 py-4" style={{ height: 460, overflow: "hidden" }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[12px] font-medium text-ink-3">{t("og_reason_emergent")}</span>
            <span
              className="og-reason-count text-[11px] font-semibold px-1.5 min-w-5 h-5 grid place-items-center rounded-full"
              style={{ background: "var(--c-accent-bg)", color: "var(--c-accent)" }}
            >
              {emergentKeys.length}
            </span>
          </div>
          <div className="flex flex-col gap-2.5">
            {emergentKeys.map((key) => {
              const c = candByKey.get(key);
              if (!c) return null;
              return <EmergentCard key={key} candidate={c} lang={lang} />;
            })}
            {emergentKeys.length === 0 && (
              <div className="rounded-xl border border-dashed border-line text-center text-[11.5px] text-ink-4 px-3 py-8">
                {t("og_reason_pending")}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer — progress + skip */}
      <div className="flex items-center gap-4 px-5 py-3.5 border-t border-line">
        <div className="relative flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "color-mix(in oklab, var(--c-accent) 18%, transparent)" }}>
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${percent}%`,
              background: "linear-gradient(90deg, color-mix(in oklab, var(--c-accent) 70%, white), var(--c-accent))",
              transition: "width 120ms linear",
            }}
          />
          {reasoning && (
            <div className="absolute inset-y-0 w-1/3 og-flow" style={{ background: "linear-gradient(90deg, transparent, color-mix(in oklab, white 55%, transparent), transparent)" }} aria-hidden />
          )}
        </div>
        <span className="mono text-[12px] text-ink-3 tabular-nums w-10 text-right">{percent}%</span>
        {reasoning && (
          <button
            type="button"
            onClick={finish}
            className="text-[12px] text-ink-4 hover:text-ink-2 transition-colors"
          >
            {t("og_reason_skip")}
          </button>
        )}
      </div>
    </div>
  );
}

// ── One reasoning line ───────────────────────────────────────────────────────
function TraceLine({ step }: { step: ReasoningStep }) {
  const meta = KIND_META[step.kind];
  const Glyph = Ic[meta.icon];
  const emphasised = step.kind === "THINK" || step.kind === "SCORE";

  return (
    <div className="og-line-in flex items-start gap-2.5">
      <span className="flex-none mt-0.5" style={{ color: meta.color }}>
        <Glyph width={14} height={14} />
      </span>
      <span
        className="flex-none mono text-[10.5px] font-semibold tracking-wider pt-[3px]"
        style={{ color: meta.color, width: 52 }}
      >
        {meta.label}
      </span>
      {emphasised ? (
        <span
          className={clsx(
            "flex-1 text-[12.5px] leading-relaxed rounded-lg px-2.5 py-1.5 border",
            step.kind === "THINK" ? "italic text-ink-1" : "text-ink-1",
          )}
          style={{
            background: `color-mix(in oklab, ${meta.color} 9%, transparent)`,
            borderColor: `color-mix(in oklab, ${meta.color} 28%, transparent)`,
          }}
        >
          {step.text}
        </span>
      ) : (
        <span className="flex-1 text-[12.5px] leading-relaxed text-ink-2 pt-[2px]">{step.text}</span>
      )}
    </div>
  );
}

// The "AI is thinking" affordance shown in the gap before the next line lands —
// three pulsing dots so the pauses read as deliberate thought, not lag.
function ThinkingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 pt-0.5" aria-live="polite">
      <span className="flex-none w-[14px] grid place-items-center" style={{ color: "var(--c-accent)" }}>
        <Ic.sparkle width={13} height={13} />
      </span>
      <span className="flex items-center gap-1" style={{ width: 52 }} aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="og-tick w-[5px] h-[5px] rounded-full"
            style={{ background: "var(--c-accent)", animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </span>
      <span className="text-[12px] italic text-ink-4">{label}</span>
    </div>
  );
}

// ── One emergent agent card ──────────────────────────────────────────────────
function EmergentCard({ candidate, lang }: { candidate: InferredAgentCandidate; lang: "zh" | "en" }) {
  const name = lang === "zh" ? candidate.nameZh : candidate.nameEn;
  const [fill, setFill] = React.useState(0);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setFill(candidate.confidence));
    return () => cancelAnimationFrame(id);
  }, [candidate.confidence]);

  return (
    <div className="og-emerge rounded-xl border border-line bg-panel/50 p-3">
      <div className="flex items-center gap-2.5">
        <div
          className="flex-none w-9 h-9 rounded-lg grid place-items-center text-[14px] font-semibold text-white shadow-sh-1"
          style={{ background: candidate.iconColor }}
        >
          {candidate.iconChar}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink-1 truncate">{name}</div>
          <div className="mono text-[10.5px] text-ink-4 truncate">{candidate.agentId}</div>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--c-line)" }}>
          <div
            className="h-full rounded-full"
            style={{
              width: `${fill}%`,
              background: candidate.confidence >= 90 ? "var(--c-ok)" : "oklch(0.7 0.15 75)",
              transition: "width 900ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
        </div>
        <span
          className="mono text-[11px] font-semibold tabular-nums"
          style={{ color: candidate.confidence >= 90 ? "var(--c-ok)" : "oklch(0.6 0.14 75)" }}
        >
          {candidate.confidence}%
        </span>
      </div>
    </div>
  );
}
