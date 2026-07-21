// Real LLM groundedness judge — wraps chatComplete behind the JudgeFn contract.
// Gateway not configured / any error → returns null (the orchestrator skips,
// deterministic rule-check stays authoritative). Relative imports so the tsx
// sweeper can load this graph.

import { chatComplete, isGatewayConfigured } from '../../server/llm/gateway';
import {
  buildGroundednessPrompt,
  parseGroundedness,
  decideVerdict,
  type GroundednessSample,
} from './groundedness';
import { familyOf, pickJuryModels, type Verdict } from './judge';
import type { JudgeFn, JudgeOutcome } from './run-eval';

export function makeLlmJudge(model?: string): JudgeFn {
  return async (sample: GroundednessSample): Promise<JudgeOutcome | null> => {
    if (!isGatewayConfigured()) return null;
    const { system, user } = buildGroundednessPrompt(sample);
    try {
      const res = await chatComplete({
        system,
        user,
        model,
        temperature: 0.1,
        maxTokens: 400,
        toolName: 'groundedness-judge',
      });
      const parsed = parseGroundedness(res.text);
      if (!parsed) return null;
      const verdict: Verdict =
        parsed.verdict !== 'unsure' ? parsed.verdict : decideVerdict(parsed.score);
      return {
        verdict,
        score: parsed.score,
        rationale: parsed.rationale,
        model: res.modelUsed,
        family: familyOf(res.modelUsed),
        durationMs: res.durationMs,
        promptTokens: res.usage?.promptTokens,
        completionTokens: res.usage?.completionTokens,
      };
    } catch {
      return null; // gateway down / parse failure → skip, never throw
    }
  };
}

/** Build a cross-family jury (distinct families, none == producer). */
export function makeJury(primaryModel: string, n: number): JudgeFn[] {
  return pickJuryModels(primaryModel, n).map((m) => makeLlmJudge(m));
}
