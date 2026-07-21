// Ontology Generator — reasoning-trace builder.
//
// Turns the REAL inferred candidates (from /api/ontology-generator/infer) into a
// streamable, LLM-style chain-of-thought: a flat list of reasoning steps the
// InferReasoning stage reveals one by one over a fixed 10s window so it reads as
// the architect agent genuinely thinking. Pure + deterministic (no Math.random) so it's stable
// across re-renders and unit-testable.
//
// Body copy is mock-data-only domain prose (like profiles.ts) and lives here with
// zh/en variants; only the surrounding UI chrome goes through lib/i18n.tsx.

import type { InferredAgentCandidate, OntologyCounts } from "./types";

export type StepKind =
  | "READ" // connect ontology store / read elements
  | "DEDUCE" // gap analysis — a dangling event
  | "WEIGH" // weigh candidate responsibilities
  | "THINK" // the judgment call (emphasised, italic)
  | "LINK" // bind action / events
  | "SCORE" // confidence breakdown (emphasised)
  | "INFER" // an agent emerges (carries agentKey → pops a card)
  | "DONE"; // convergence

export type ReasoningStep = {
  /** Stable id (used as React key). */
  id: string;
  kind: StepKind;
  text: string;
  /** Set on INFER steps — the candidate.key whose card should pop in. */
  agentKey?: string;
  /** 0..1 fraction of the timeline at which this step reveals (assigned here). */
  at: number;
};

type Lang = "zh" | "en";

const f2 = (n: number) => (n / 100).toFixed(2);

/** camelCase action name from an agent short ("MatchResumeAgent" → "matchResume"). */
function deriveFn(short: string): string | null {
  const base = short.replace(/Agent$/, "");
  if (!/^[A-Za-z]/.test(base)) return null;
  return base.charAt(0).toLowerCase() + base.slice(1);
}

/** First clause of a description, capped — used as responsibility option ①. */
function firstClause(desc: string): string {
  const seg = desc.split(/[，,、。.；;]/)[0]?.trim() ?? desc;
  return seg.length > 22 ? `${seg.slice(0, 22)}…` : seg;
}

/** Confidence (0..100) → a deterministic evidence / single-responsibility pair. */
function scoreParts(confidence: number) {
  const evidence = Math.max(60, confidence - 2);
  const singular = Math.min(99, confidence + 1);
  return { evidence, singular, composite: confidence };
}

function candidateSteps(c: InferredAgentCandidate, lang: Lang): Omit<ReasoningStep, "at">[] {
  const nameZh = c.nameZh;
  const nameEn = c.nameEn;
  const fn = deriveFn(c.short);
  const { evidence, singular, composite } = scoreParts(c.confidence);
  const opt1 = firstClause(lang === "zh" ? c.descZh : c.descEn);

  if (lang === "zh") {
    const link = fn
      ? `绑定 ${fn}() · 触发 ${c.triggerEvent} · 写出 ${c.emitEvent}`
      : `绑定动作 · 触发 ${c.triggerEvent} · 写出 ${c.emitEvent}`;
    return [
      { id: `${c.key}-deduce`, kind: "DEDUCE", text: `事件 ${c.triggerEvent} 已注册，下游无订阅者 → 职责缺口` },
      { id: `${c.key}-weigh`, kind: "WEIGH", text: `候选职责：① ${opt1} ② 沿用既有流程、跳过该步骤 — 结合事件语义判断归属` },
      { id: `${c.key}-think`, kind: "THINK", text: `综合事件语义与缺口信号，应由专职智能体承接 ${c.triggerEvent} → 采纳方案 ①` },
      { id: `${c.key}-link`, kind: "LINK", text: link },
      { id: `${c.key}-score`, kind: "SCORE", text: `证据充分度 ${f2(evidence)} · 职责单一性 ${f2(singular)} · 与现役智能体无重叠 → 综合 ${f2(composite)}` },
      { id: `${c.key}-infer`, kind: "INFER", text: `推断智能体「${nameZh} ${c.agentId}」`, agentKey: c.key },
    ];
  }
  const link = fn
    ? `Bind ${fn}() · on ${c.triggerEvent} · emit ${c.emitEvent}`
    : `Bind action · on ${c.triggerEvent} · emit ${c.emitEvent}`;
  return [
    { id: `${c.key}-deduce`, kind: "DEDUCE", text: `Event ${c.triggerEvent} is registered but has no subscriber → responsibility gap` },
    { id: `${c.key}-weigh`, kind: "WEIGH", text: `Candidate duties: ① ${opt1} ② reuse existing flow, skip the step — resolve by event semantics` },
    { id: `${c.key}-think`, kind: "THINK", text: `Semantics + gap signal call for a dedicated consumer of ${c.triggerEvent} → adopt option ①` },
    { id: `${c.key}-link`, kind: "LINK", text: link },
    { id: `${c.key}-score`, kind: "SCORE", text: `Evidence ${f2(evidence)} · single-responsibility ${f2(singular)} · no overlap with active agents → ${f2(composite)}` },
    { id: `${c.key}-infer`, kind: "INFER", text: `Infer agent «${nameEn} · ${c.agentId}»`, agentKey: c.key },
  ];
}

// How many candidates get a full multi-line reasoning chain before the rest are
// folded into one summary line. A content-heavy domain can derive dozens of
// agents (energy = 28); streaming a 6-line block for each would either run for
// minutes or — pinned to INFER_DURATION_MS — flash past unreadably. Detailing a
// representative couple and summarising the tail keeps the line cadence calm
// (~1 line / 0.5s) regardless of how many agents the ontology yields. Every
// candidate still emerges as a card on the right and still appears on the
// selection screen — only the per-agent reasoning lines are capped here.
export const DETAIL_LIMIT = 2;

/**
 * Build the full reasoning trace for a set of inferred candidates.
 * The returned steps carry an evenly-distributed `at` fraction (0..1) so the
 * director can reveal them across whatever total duration it chooses.
 */
export function buildReasoningTrace(
  candidates: InferredAgentCandidate[],
  counts: OntologyCounts,
  lang: Lang,
): ReasoningStep[] {
  const flat: Omit<ReasoningStep, "at">[] = [];

  if (lang === "zh") {
    flat.push({
      id: "read",
      kind: "READ",
      text: `连接本体存储 · 读取 ${counts.dataObjects} 个数据对象 · ${counts.events} 个事件 · ${counts.actions} 个动作`,
    });
  } else {
    flat.push({
      id: "read",
      kind: "READ",
      text: `Connect ontology store · read ${counts.dataObjects} data objects · ${counts.events} events · ${counts.actions} actions`,
    });
  }

  if (candidates.length === 0) {
    flat.push(
      lang === "zh"
        ? { id: "scan", kind: "DEDUCE", text: "扫描事件拓扑 · 未发现「发布无订阅」的悬空事件，无下游缺口" }
        : { id: "scan", kind: "DEDUCE", text: "Scan event topology · no dangling (published, no subscriber) events, no gaps" },
    );
    flat.push(
      lang === "zh"
        ? { id: "done", kind: "DONE", text: "推理收敛 · 当前本体的智能体已完备" }
        : { id: "done", kind: "DONE", text: "Reasoning converged · ontology agents already complete" },
    );
  } else {
    flat.push(
      lang === "zh"
        ? { id: "scan", kind: "DEDUCE", text: `扫描事件拓扑 · 定位「发布无订阅」的悬空事件 ${candidates.length} 处 → 潜在职责缺口` }
        : { id: "scan", kind: "DEDUCE", text: `Scan event topology · ${candidates.length} dangling (published, no subscriber) events → potential gaps` },
    );
    // Detail the first DETAIL_LIMIT candidates fully; fold the remainder into one
    // summary line so the trace stays readable within the fixed timeline.
    const detailed = candidates.slice(0, DETAIL_LIMIT);
    const rest = candidates.slice(DETAIL_LIMIT);
    for (const c of detailed) flat.push(...candidateSteps(c, lang));
    if (rest.length > 0) {
      flat.push(
        lang === "zh"
          ? { id: "rest", kind: "INFER", text: `依据相同的事件拓扑，推断其余 ${rest.length} 个智能体` }
          : { id: "rest", kind: "INFER", text: `Infer the remaining ${rest.length} agents from the same event topology` },
      );
    }
    flat.push(
      lang === "zh"
        ? { id: "done", kind: "DONE", text: `推理收敛 · 涌现 ${candidates.length} 个智能体 · 移交人工确认` }
        : { id: "done", kind: "DONE", text: `Reasoning converged · ${candidates.length} emergent agents · handing to review` },
    );
  }

  // Weighted pacing: each kind "costs" a different amount of thinking time, so
  // the model lingers before the judgment (THINK) and the conclusion (INFER)
  // instead of streaming at a uniform clip. `at` is the cumulative weight up to
  // and including this step / total — so the gap BEFORE a line is proportional
  // to its own weight (a long pause, then the heavy thought lands).
  const total = totalUnits(flat);
  let acc = 0;
  return flat.map((s) => {
    acc += STEP_WEIGHT[s.kind];
    return { ...s, at: acc / total };
  });
}

// Relative "thinking cost" per step kind. THINK / INFER weigh most → the longest
// pauses precede them. Tune these to reshape the rhythm.
const STEP_WEIGHT: Record<StepKind, number> = {
  READ: 1.4,
  DEDUCE: 1.3,
  WEIGH: 1.5,
  THINK: 2.1,
  LINK: 1.2,
  SCORE: 1.5,
  INFER: 1.9,
  DONE: 1.6,
};

// A closing beat after the last line before the timeline completes.
const TAIL_UNITS = 1.0;

function totalUnits(steps: { kind: StepKind }[]): number {
  return steps.reduce((s, st) => s + STEP_WEIGHT[st.kind], 0) + TAIL_UNITS;
}

// Fixed wall-clock duration for the whole inference animation. The per-step `at`
// fractions (from STEP_WEIGHT) still distribute the lines proportionally across
// this window, so THINK / INFER keep their longer lead-in pauses — only the total
// run time is pinned, so every domain reasons for exactly this long regardless of
// how many agents emerge.
export const INFER_DURATION_MS = 10_000;

/** Deterministic synthetic token budget for the header counter. */
export function traceTokenTarget(candidates: InferredAgentCandidate[]): number {
  return candidates.reduce((sum, c) => sum + 180 + c.confidence * 2, 480 + candidates.length * 60);
}

/** Canonical order for the header step-type chips (DONE excluded). */
export const CHIP_KINDS: StepKind[] = ["READ", "DEDUCE", "WEIGH", "THINK", "LINK", "SCORE", "INFER"];
