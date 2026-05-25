// LLM Call AI-N — the "auto-iterate" refiner (Bundle M).
//
// Input: current (form, businessLogic, code) + full EvaluationReport
// Output: refined businessLogic prose + rationale + expected delta
//
// Run BEFORE the next codegen iteration. The orchestrator (auto-iterate.ts)
// calls this when verdict is not FULL, regenerates with the refined
// businessLogic, re-evaluates, and stops on:
//   (a) verdict = FULL
//   (b) aggregate score did not improve from previous round
//   (c) max iterations reached
//
// SCOPE LIMITS (hard rules in the prompt):
//   - We refine PROSE ONLY. Form fields (slug, trigger event, owner, etc.)
//     are operator-locked and the iterator NEVER touches them.
//   - No external knowledge — refinement is purely "read the eval gaps,
//     rewrite the description to be more specific where the LLM missed".
//   - Output is text; downstream pipeline re-runs as if operator typed it.

import { z } from 'zod';
import { pickCodegenGateway, makeClient } from './gateway';
import type { AgentFormFields } from '../spec-types';
import type { EvaluationReport } from '../eval/evaluation-report';

export type AutoIterateInput = {
  form: AgentFormFields;
  currentBusinessLogic: string;
  currentCode: string;
  evaluation: EvaluationReport;
};

export type AutoIterateResult = {
  refinedBusinessLogic: string;
  /** One paragraph explaining what gap the refinement targets. */
  rationale: string;
  /** Bullet list of expected improvements ("add the missing write-jp-neo4j step"). */
  expectedDelta: string[];
  /** Self-assessed confidence the refinement actually closes the gap. */
  confidence: 'high' | 'medium' | 'low';
  modelUsed: string;
  durationMs: number;
};

const ResponseSchema = z.object({
  refinedBusinessLogic: z.string().min(20).max(8_000),
  rationale: z.string().min(8).max(2_000),
  expectedDelta: z.array(z.string().min(2).max(280)).max(20),
  confidence: z.enum(['high', 'medium', 'low']),
});

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['refinedBusinessLogic', 'rationale', 'expectedDelta', 'confidence'],
  properties: {
    refinedBusinessLogic: { type: 'string' },
    rationale: { type: 'string' },
    expectedDelta: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
} as const;

export async function refineBusinessLogic(
  input: AutoIterateInput,
): Promise<AutoIterateResult> {
  const t0 = Date.now();
  const gateway = pickCodegenGateway();
  const client = makeClient(gateway);

  const completion = await client.chat.completions.create({
    model: gateway.model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(input) },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'submit_refinement',
          description: 'Submit a refined businessLogic prose + rationale + expected delta + confidence.',
          parameters: JSON_SCHEMA,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'submit_refinement' } },
  });

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    throw new Error('LLM did not return a tool call');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error('LLM refinement arguments were not valid JSON');
  }
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('LLM refinement output failed schema: ' + JSON.stringify(parsed.error.issues));
  }

  return {
    refinedBusinessLogic: parsed.data.refinedBusinessLogic,
    rationale: parsed.data.rationale,
    expectedDelta: parsed.data.expectedDelta,
    confidence: parsed.data.confidence,
    modelUsed: gateway.model,
    durationMs: Date.now() - t0,
  };
}

function buildSystemPrompt(): string {
  return [
    'You are the auto-iteration refiner inside the AO codegen pipeline.',
    'A previous codegen round produced an agent that scored below FULL on',
    'the evaluation stack. Your job: rewrite the operator\'s business',
    'description prose to be more specific where the previous round missed.',
    '',
    'Hard rules:',
    '  1. You ONLY refine the prose (businessLogic). NEVER suggest changes to',
    '     slug, displayName, stage, owner, triggerEvent, emitEvents, retries,',
    '     errorHandling — those are operator-locked.',
    '  2. Stay grounded in the evaluation report. Address the specific',
    '     missing steps, unmatched emits, code review violations the report',
    '     calls out. Do NOT invent new requirements the operator didn\'t ask for.',
    '  3. Preserve the original intent. Refine, don\'t rewrite from scratch.',
    '  4. If the report shows behavioral.diff.missingSteps, your refined',
    '     prose should explicitly mention each missing step\'s purpose.',
    '  5. If review issues mention "imports-are-allowed" or a tool not in the',
    '     registry, point the prose at a registered tool instead.',
    '  6. confidence: high = report has unambiguous structural gaps (missing',
    '     steps / emits); medium = some gaps are AO-conventional issues;',
    '     low = report shows wide misses or compile failed entirely.',
    '  7. expectedDelta: 1 bullet per concrete improvement the refinement',
    '     targets. Empty array OK for low confidence.',
    '',
    'Format the refined prose as the operator would have written it: numbered',
    'steps, plain language, mention specific tools when relevant.',
  ].join('\n');
}

function buildUserPrompt(input: AutoIterateInput): string {
  const e = input.evaluation;
  const behavioralBlock = e.behavioral
    ? [
        'Behavioral vs Ground Truth:',
        `  verdict: ${e.behavioral.verdict}  score: ${(e.behavioral.score * 100).toFixed(1)}%`,
        `  matched steps:    ${e.behavioral.diff.matchedSteps.map((s) => s.id).join(', ') || '(none)'}`,
        `  MISSING steps:    ${e.behavioral.diff.missingSteps.map((s) => `${s.id}${s.tool ? ` (tool: ${s.tool})` : ''}`).join(', ') || '(none)'}`,
        `  unexpected steps: ${e.behavioral.diff.unexpectedSteps.map((s) => s.id).join(', ') || '(none)'}`,
        `  matched emits:    ${e.behavioral.diff.matchedEmits.map((x) => x.name).join(', ') || '(none)'}`,
        `  MISSING emits:    ${e.behavioral.diff.missingEmits.map((x) => x.name).join(', ') || '(none)'}`,
        `  conventions:      NonRetriable=${e.behavioral.diff.conventionsMet.nonRetriable} · try/catch=${e.behavioral.diff.conventionsMet.tryCatch} · logger=${e.behavioral.diff.conventionsMet.loggerCalls}`,
      ].join('\n')
    : '(no behavioral data — no ground truth for this slug)';

  const reviewBlock = e.review.issues.length
    ? e.review.issues
        .slice(0, 12)
        .map((i) => `  [${i.severity}] ${i.ruleId}: ${i.message}${i.hint ? ` (→ ${i.hint})` : ''}`)
        .join('\n')
    : '(no review issues)';

  return [
    `Slug: ${input.form.slug}  Stage: ${input.form.stage}  Trigger: ${input.form.triggerEvent}`,
    `Emits: [${input.form.emitEvents.join(', ')}]`,
    '',
    `Previous round verdict: ${e.finalVerdict}  aggregate ${(e.aggregateScore * 100).toFixed(1)}%`,
    `Summary: ${e.summary}`,
    '',
    behavioralBlock,
    '',
    'Code review (first 12):',
    reviewBlock,
    '',
    'Original business description prose (the operator-written input):',
    '```',
    input.currentBusinessLogic,
    '```',
    '',
    'Refine the prose now via submit_refinement.',
  ].join('\n');
}
