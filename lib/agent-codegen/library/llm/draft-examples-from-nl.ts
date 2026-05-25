// LLM Call: free-text wrapper description → draft CurlExample[].
//
// The operator can describe an external API in prose ("I need RoboHire
// invite endpoint that returns an invite URL + success flag"). This call
// drafts a structured list of endpoints (verb + path + description, no
// JSON samples) that the operator THEN reviews/refines in the existing
// CurlExamplesInput before running library codegen.
//
// IMPORTANT — the LLM never produces a production library directly from
// pure NL. The drafted examples are always presented for human review
// first (sample JSON, in particular, is on the operator to supply because
// LLM-fabricated response shapes are the #1 source of bugs in lib codegen
// per research doc §B.3.4).

import { z } from 'zod';
import { pickCodegenGateway, makeClient } from '@/lib/agent-codegen/llm/gateway';
import type { CurlExample } from '../lib-spec-types';

export type DraftExamplesInput = {
  description: string;
  /** Operator-supplied base URL hint — helps the LLM not invent host names. */
  baseUrlHint?: string;
};

export type DraftExamplesResult = {
  examples: CurlExample[];
  modelUsed: string;
  durationMs: number;
};

const DraftSchema = z.object({
  examples: z
    .array(
      z.object({
        httpVerb: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        httpPath: z.string().min(1).max(200),
        description: z.string().min(4).max(200),
      }),
    )
    .min(1)
    .max(20),
});

const DRAFT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['examples'],
  properties: {
    examples: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['httpVerb', 'httpPath', 'description'],
        properties: {
          httpVerb: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          httpPath: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
} as const;

export async function draftExamplesFromNL(
  input: DraftExamplesInput,
): Promise<DraftExamplesResult> {
  const t0 = Date.now();
  const gateway = pickCodegenGateway();
  const client = makeClient(gateway);

  const systemPrompt = [
    'You are drafting a list of HTTP endpoint stubs from a natural-language',
    'description of an external API. Output only via submit_draft.',
    '',
    'Each entry has:',
    '  - httpVerb: GET / POST / PUT / PATCH / DELETE',
    '  - httpPath: e.g. /api/v1/applications/:id  (use :name for path params)',
    '  - description: one-line, what this endpoint does',
    '',
    'Rules:',
    '  1. NEVER invent host names — use only relative paths.',
    '  2. Prefer the conventional CRUD shape when the description implies it',
    '     (e.g. "manage applications" → list / get / create / update / delete).',
    '  3. 3-8 endpoints typical, never more than 12.',
    '  4. Do NOT include request/response sample bodies — the operator will',
    '     supply those after reviewing this draft.',
    '  5. If the description is too vague to draft anything concrete, return',
    '     just one entry asking for clarification in description.',
    input.baseUrlHint
      ? `\nOperator-supplied base URL hint: ${input.baseUrlHint} (DO NOT include in paths — paths are relative).`
      : '',
  ].join('\n');

  const completion = await client.chat.completions.create({
    model: gateway.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.description },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'submit_draft',
          description: 'Submit a drafted list of endpoint stubs for operator review.',
          parameters: DRAFT_JSON_SCHEMA,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'submit_draft' } },
  });

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    throw new Error('LLM did not return a tool call');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error('LLM draft arguments were not valid JSON');
  }
  const parsed = DraftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('LLM draft failed schema: ' + JSON.stringify(parsed.error.issues));
  }

  return {
    examples: parsed.data.examples as CurlExample[],
    modelUsed: gateway.model,
    durationMs: Date.now() - t0,
  };
}
