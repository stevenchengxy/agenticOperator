// LLM Call F — debug + auto-fix generated TS that the compiler rejected.
//
// Input: (filename + code + diagnostics + relevant tool registry)
// Output: { explanation, patchedCode, changeSummary[], confidence }
//
// The operator always reviews the diff before applying — see the
// CompilerPanel "Suggest fix" button + dialog. We never overwrite code
// automatically.
//
// Compared to the generation LLM calls (spec extractor, step body filler),
// this one runs ad-hoc on demand and gets a much tighter context:
//   - the FULL current source (small, single file)
//   - only the diagnostics that fired (not the whole compiler output)
//   - the tool registry IDs the source already imports from (so the LLM
//     knows which legit imports exist if it needs to add one)

import { z } from 'zod';
import { pickCodegenGateway, makeClient } from './gateway';
import type { Diagnostic } from '../compiler/types';
import { getToolRegistry } from '../registries';
import type { DomainId } from '@/lib/domains';

export type FixSuggestionInput = {
  filename: string;
  code: string;
  diagnostics: Diagnostic[];
  domain: DomainId;
};

export type FixSuggestionResult = {
  /** Plain-language analysis of what's wrong + why. 2-5 sentences. */
  explanation: string;
  /** Full rewritten file content. Operator reviews via diff before apply. */
  patchedCode: string;
  /** Bullet list of concrete changes ("wrapped return type in Promise<>"). */
  changeSummary: string[];
  /** Model self-assessed confidence. UI shows it next to the Apply button. */
  confidence: 'high' | 'medium' | 'low';
  modelUsed: string;
  durationMs: number;
};

const ResponseSchema = z.object({
  explanation: z.string().min(8).max(2_000),
  patchedCode: z.string().min(8).max(256 * 1024),
  changeSummary: z.array(z.string().min(2).max(280)).min(0).max(20),
  confidence: z.enum(['high', 'medium', 'low']),
});

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['explanation', 'patchedCode', 'changeSummary', 'confidence'],
  properties: {
    explanation: { type: 'string' },
    patchedCode: { type: 'string' },
    changeSummary: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
} as const;

export async function suggestFix(input: FixSuggestionInput): Promise<FixSuggestionResult> {
  const t0 = Date.now();
  if (input.diagnostics.length === 0) {
    throw new Error('No diagnostics to fix — nothing to do.');
  }

  const gateway = pickCodegenGateway();
  const client = makeClient(gateway);
  const toolRegistry = getToolRegistry(input.domain);

  const systemPrompt = buildSystemPrompt(input, toolRegistry);
  const userPrompt = buildUserPrompt(input);

  const completion = await client.chat.completions.create({
    model: gateway.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'submit_fix',
          description: 'Submit a debug analysis + patched file content + change summary.',
          parameters: FIX_SCHEMA,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'submit_fix' } },
  });

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    throw new Error('LLM did not return a tool call');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error('LLM fix arguments were not valid JSON');
  }
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'LLM fix output failed schema validation: ' + JSON.stringify(parsed.error.issues),
    );
  }

  return {
    explanation: parsed.data.explanation,
    patchedCode: parsed.data.patchedCode,
    changeSummary: parsed.data.changeSummary,
    confidence: parsed.data.confidence,
    modelUsed: gateway.model,
    durationMs: Date.now() - t0,
  };
}

// ────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(
  input: FixSuggestionInput,
  toolRegistry: ReturnType<typeof getToolRegistry>,
): string {
  // Only include tool registry entries the code already imports OR ones
  // that look relevant by name. Keep the prompt small.
  const importedPaths = new Set<string>();
  const importRe = /^import[^;]+from\s+['"]([^'"]+)['"]/gm;
  for (const m of input.code.matchAll(importRe)) importedPaths.add(m[1]);

  const relevantTools = toolRegistry.filter(
    (t) => importedPaths.has(t.importFrom) || isMentionedInDiagnostics(t.importName, input.diagnostics),
  );

  const toolsBlock = relevantTools.length
    ? relevantTools
        .map(
          (t) =>
            `  - ${t.id}\n      import { ${t.importName} } from '${t.importFrom}';\n      ${t.signature}`,
        )
        .join('\n')
    : '  (no directly-relevant tool registry entries)';

  return [
    'You are debugging a single TypeScript file that failed type checking.',
    'You will receive: the full source, the compiler diagnostics, and any',
    'tool-registry entries that the file imports from or that the errors',
    'reference. Produce a patched version of the FULL file via submit_fix.',
    '',
    'Hard rules:',
    '  1. Output the COMPLETE patched file (not a diff, not a snippet).',
    '  2. Fix only what the diagnostics describe. Do NOT refactor unrelated',
    '     code, do NOT remove logger calls, do NOT change step.run IDs.',
    '  3. Preserve all imports unless an import is itself one of the errors.',
    '  4. Preserve the existing exports, function names, and signatures',
    '     except where a signature is the source of the error.',
    '  5. Async function return types MUST be Promise<T>; never bare T.',
    '  6. New imports may only come from the tool registry below or from',
    '     framework paths the file already uses (inngest, @/server/inngest/client,',
    '     @/lib/agent-logger, @/server/agent-logger, node:crypto).',
    '  7. confidence: high if the diagnostics are unambiguous and the fix is',
    '     a 1-3 line edit; medium if guesswork is involved; low if the',
    '     diagnostics could mean several things — but ALWAYS submit a fix.',
    '  8. changeSummary: 1 bullet per logical change ("wrapped X return type",',
    '     "added missing import Y", etc.). Empty array if confidence=low.',
    '',
    'Available tool registry entries (use exactly these names when importing):',
    toolsBlock,
  ].join('\n');
}

function isMentionedInDiagnostics(name: string, diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.message.includes(name));
}

function buildUserPrompt(input: FixSuggestionInput): string {
  const diagBlock = input.diagnostics
    .map(
      (d, i) =>
        `  ${i + 1}. [${d.severity}] TS${d.code} at L${d.line}:${d.column} (${d.category})\n     ${d.message}`,
    )
    .join('\n');

  return [
    `File: ${input.filename}`,
    `Diagnostics (${input.diagnostics.length}):`,
    diagBlock,
    '',
    '── Source ──',
    '```ts',
    input.code,
    '```',
  ].join('\n');
}
