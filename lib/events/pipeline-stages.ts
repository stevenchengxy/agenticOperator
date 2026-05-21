// Pipeline stage derivation for candidate tracking.
// Each event name maps to one stage; unknown events fall through to "other".

export type PipelineStage =
  | "intake"        // RESUME_* arrivals
  | "parse"         // RESUME_PARSED / PROCESSED
  | "rule_check"    // MATCH_RULE_CHECK_*
  | "match"         // MATCH_PASSED / FAILED
  | "interview"     // INTERVIEW_*
  | "evaluate"      // EVALUATION_*
  | "submit"        // APPLICATION_SUBMITTED / PACKAGE_*
  | "other";

export const STAGE_META: Record<PipelineStage, { order: number; zh: string; en: string; color: string }> = {
  intake:     { order: 1, zh: "简历到位",  en: "Resume in",   color: "var(--c-ink-3)" },
  parse:      { order: 2, zh: "解析完成",  en: "Parsed",      color: "var(--c-info)" },
  rule_check: { order: 3, zh: "规则检查",  en: "Rule check",  color: "oklch(0.55 0.14 280)" },
  match:      { order: 4, zh: "匹配",      en: "Match",       color: "var(--c-accent)" },
  interview:  { order: 5, zh: "面试",      en: "Interview",   color: "var(--c-warn)" },
  evaluate:   { order: 6, zh: "评估",      en: "Evaluate",    color: "var(--c-ok)" },
  submit:     { order: 7, zh: "提交",      en: "Submit",      color: "oklch(0.55 0.14 140)" },
  other:      { order: 99, zh: "其他",     en: "Other",       color: "var(--c-ink-4)" },
};

const PATTERNS: Array<{ test: (n: string) => boolean; stage: PipelineStage }> = [
  { test: (n) => n.startsWith("APPLICATION_SUBMITTED") || n.startsWith("PACKAGE_"),  stage: "submit" },
  { test: (n) => n.startsWith("EVALUATION_") || n.startsWith("EVALUATE_"),           stage: "evaluate" },
  { test: (n) => n.startsWith("INTERVIEW_") || n.startsWith("AI_INTERVIEW"),         stage: "interview" },
  { test: (n) => n.startsWith("MATCH_PASSED") || n === "MATCH_FAILED",               stage: "match" },
  { test: (n) => n.startsWith("MATCH_RULE_CHECK_"),                                  stage: "rule_check" },
  { test: (n) => n === "RESUME_PROCESSED" || n === "RESUME_PARSED",                  stage: "parse" },
  { test: (n) => n.startsWith("RESUME_UPLOADED") || n.startsWith("RESUME_RECEIVED"), stage: "intake" },
];

export function eventToStage(eventName: string): PipelineStage {
  for (const p of PATTERNS) {
    if (p.test(eventName)) return p.stage;
  }
  return "other";
}

/** Order pipeline stages so callers can pick "latest". Returns the stage with the highest `order` from the input list. */
export function latestStage(events: string[]): PipelineStage {
  let best: PipelineStage = "other";
  let bestOrder = -1;
  for (const ev of events) {
    const s = eventToStage(ev);
    if (STAGE_META[s].order > bestOrder) {
      best = s;
      bestOrder = STAGE_META[s].order;
    }
  }
  return best;
}
