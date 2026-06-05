// Groundedness (faithfulness) judging — Ragas-style: does the agent's output
// claim get supported by the provided context (ontology rule + candidate/job
// facts)? Pure prompt-build + parse + decide; the LLM call is injected (llm-
// judge.ts). score = supported claims / total claims, in [0,1].

import { normalizeVerdict, type Verdict } from './judge';

export interface GroundednessSample {
  sampledFrom: string; // run/audit id — idempotency key
  domain: string;
  agent: string | null;
  runId: string | null;
  auditId: string | null;
  anchors: Record<string, string | null | undefined>;
  output: string; // the agent's claim/justification text
  context: string; // ontology rule + candidate/job facts to verify against
}

export interface GroundednessResult {
  score: number | null;
  verdict: Verdict;
  rationale: string | null;
}

export function buildGroundednessPrompt(s: GroundednessSample): { system: string; user: string } {
  const system =
    '你是事实核查员。判断「产出」中的每条断言是否被「依据」支持。' +
    '只输出 JSON:{"score": 0-1 之间的小数(被支持的断言数 / 断言总数), ' +
    '"verdict": "grounded"|"not_grounded"(score≥0.8 记 grounded), ' +
    '"rationale": "一句中文理由(≤60字)"}。不要输出多余文字。';
  const user = `产出:\n${s.output.slice(0, 2000)}\n\n依据:\n${s.context.slice(0, 2000)}`;
  return { system, user };
}

function stripFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return m ? m[1].trim() : t;
}

export function parseGroundedness(text: string): GroundednessResult | null {
  let obj: unknown;
  try {
    obj = JSON.parse(stripFence(text));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const score = typeof o.score === 'number' && o.score >= 0 && o.score <= 1 ? o.score : null;
  const verdict = normalizeVerdict(typeof o.verdict === 'string' ? o.verdict : null);
  const rationale = typeof o.rationale === 'string' ? o.rationale : null;
  if (score === null && verdict === 'unsure') return null; // nothing usable
  return { score, verdict, rationale };
}

export function decideVerdict(score: number | null, threshold = 0.8): Verdict {
  if (score === null) return 'unsure';
  return score >= threshold ? 'grounded' : 'not_grounded';
}
