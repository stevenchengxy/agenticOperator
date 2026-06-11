// Decide whether two values of a candidate field are "the same person's value".
//
// Two layers, in order:
//   1. EXACT fast path — normalized equality. Deterministic, free, auditable. This is
//      all rule 1 (phone) and exact fields ever need.
//   2. AI fuzzy path — only for fields the rule marks fuzzy (name/school/major/degree)
//      AND only when the exact path failed AND both sides have data. The AI judge is
//      INJECTED so the rule engine stays unit-testable without a network call.
//
// Conservative by construction: a missing value is never a match, and an AI "yes"
// below the confidence threshold is treated as "no" — important because these feed an
// ownership decision (who owns the candidate / commission), which must not over-merge.

import type { MatchField } from './rules-data';
import { normalizeField } from './field-normalize';

export interface AiJudgeResult {
  equivalent: boolean;
  confidence: number; // 0..1
  reason: string;
}

/** Injected AI judge: "are these two <field> values the same person's <field>?" */
export type AiFieldJudge = (
  field: MatchField,
  rawA: string,
  rawB: string,
) => Promise<AiJudgeResult>;

export type EquivMethod = 'exact' | 'ai' | 'empty' | 'mismatch';

export interface FieldEquivResult {
  field: MatchField;
  equivalent: boolean;
  method: EquivMethod;
  /** 1 for exact; the AI's confidence for ai; 0 for empty/mismatch. */
  confidence: number;
  reason: string;
  /** Normalized values actually compared (for the audit evidence trail). */
  valueA: string;
  valueB: string;
}

export interface FieldEquivOpts {
  /** Whether this field may use the AI judge when exact fails. */
  fuzzy: boolean;
  judge?: AiFieldJudge;
  /** Minimum AI confidence to accept an "equivalent" verdict (default 0.8). */
  aiThreshold?: number;
}

export async function fieldEquivalent(
  field: MatchField,
  rawA: string | null | undefined,
  rawB: string | null | undefined,
  opts: FieldEquivOpts,
): Promise<FieldEquivResult> {
  const valueA = normalizeField(field, rawA);
  const valueB = normalizeField(field, rawB);
  const base = { field, valueA, valueB };

  // Missing data → cannot confirm equality.
  if (!valueA || !valueB) {
    return { ...base, equivalent: false, method: 'empty', confidence: 0, reason: '字段缺失,无法判定' };
  }

  // Exact fast path.
  if (valueA === valueB) {
    return { ...base, equivalent: true, method: 'exact', confidence: 1, reason: '规范化后完全一致' };
  }

  // AI fuzzy path (only when allowed + a judge is available).
  if (opts.fuzzy && opts.judge) {
    const threshold = opts.aiThreshold ?? 0.8;
    const v = await opts.judge(field, String(rawA ?? ''), String(rawB ?? ''));
    const equivalent = v.equivalent && v.confidence >= threshold;
    return {
      ...base,
      equivalent,
      method: 'ai',
      confidence: v.confidence,
      reason: equivalent
        ? `AI 判定等价(置信度 ${v.confidence.toFixed(2)}): ${v.reason}`
        : `AI 未达等价阈值(置信度 ${v.confidence.toFixed(2)}): ${v.reason}`,
    };
  }

  return { ...base, equivalent: false, method: 'mismatch', confidence: 0, reason: '规范化后不一致' };
}
