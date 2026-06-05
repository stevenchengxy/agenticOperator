// Judge primitives for the AI fact-monitor: verdict normalization, jury tally,
// and cross-family judge selection (so a judge never shares the producer's model
// family — kills the documented self-preference bias). Pure; reuses the rule-
// check verifier's family-hop picker.

import { pickVerifierModel } from '../rule-check/verify-prompt';

export type Verdict = 'grounded' | 'not_grounded' | 'unsure';

export interface JuryVote {
  model: string;
  family: string;
  verdict: Verdict;
}

export function normalizeVerdict(raw: string | null | undefined): Verdict {
  const s = (raw || '').toLowerCase().trim();
  if (['grounded', 'pass', 'true', 'yes', 'supported'].includes(s)) return 'grounded';
  if (['not_grounded', 'ungrounded', 'fail', 'false', 'no', 'unsupported'].includes(s))
    return 'not_grounded';
  return 'unsure';
}

/** Majority of grounded vs not_grounded (unsure never wins; tie → unsure). */
export function tallyJury(votes: Verdict[]): {
  verdict: Verdict;
  agreement: number;
  counts: Record<Verdict, number>;
} {
  const counts: Record<Verdict, number> = { grounded: 0, not_grounded: 0, unsure: 0 };
  for (const v of votes) counts[v]++;
  let verdict: Verdict = 'unsure';
  if (counts.grounded > counts.not_grounded) verdict = 'grounded';
  else if (counts.not_grounded > counts.grounded) verdict = 'not_grounded';
  const total = votes.length || 1;
  return { verdict, agreement: counts[verdict] / total, counts };
}

export function familyOf(model: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('claude') || m.includes('anthropic')) return 'anthropic';
  if (m.includes('gpt') || m.includes('openai')) return 'openai';
  if (m.includes('gemini') || m.includes('google')) return 'google';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('kimi') || m.includes('moonshot')) return 'moonshot';
  return 'other';
}

/**
 * Pick up to N jury models — none in the producer's family, all distinct
 * families. First pick reuses the rule-check verifier's cross-family hop; the
 * rest come from a fixed pool, skipping families already chosen.
 */
export function pickJuryModels(primaryModel: string, n: number): string[] {
  const exclude = familyOf(primaryModel);
  const pool = [
    'anthropic/claude-opus-4.6',
    'openai/gpt-5.4',
    'google/gemini-2.5-pro',
    'deepseek/deepseek-v3',
  ];
  const picked: string[] = [];
  const usedFamilies = new Set<string>([exclude]);

  const first = pickVerifierModel(primaryModel);
  if (!usedFamilies.has(familyOf(first))) {
    picked.push(first);
    usedFamilies.add(familyOf(first));
  }
  for (const m of pool) {
    if (picked.length >= n) break;
    const fam = familyOf(m);
    if (usedFamilies.has(fam)) continue;
    picked.push(m);
    usedFamilies.add(fam);
  }
  return picked.slice(0, n);
}
