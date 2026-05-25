// LLM Call C — given a LibraryFormFields + curl examples seed, ask the
// model to emit per-method specs (name/verb/path/types/body) + shared types.
//
// Single LLM call rather than separate "spec then bodies" — for an HTTP
// client the bodies are small (fetch + parse) and the seed already says
// exactly what each call should do, so one round trip is enough.

import {
  LIB_GEN_JSON_SCHEMA,
  LibraryGenerationOutputSchema,
  type CurlExample,
  type LibraryFormFields,
  type LibraryGenerationOutput,
} from '../lib-spec-types';
import { pickCodegenGateway, makeClient } from '@/lib/agent-codegen/llm/gateway';

export type GenerateLibraryInput = {
  form: LibraryFormFields;
  examples: CurlExample[];
};

export type GenerateLibraryResult = {
  output: LibraryGenerationOutput;
  modelUsed: string;
  durationMs: number;
};

export async function generateLibrary(input: GenerateLibraryInput): Promise<GenerateLibraryResult> {
  const t0 = Date.now();
  const gateway = pickCodegenGateway();
  const client = makeClient(gateway);

  const systemPrompt = buildSystemPrompt(input.form);
  const userPrompt = buildUserPrompt(input.examples);

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
          name: 'submit_library',
          description: 'Submit per-method specs + shared types for the wrapper under construction.',
          parameters: LIB_GEN_JSON_SCHEMA,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'submit_library' } },
  });

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    throw new Error('LLM did not return a tool call');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error('LLM tool call arguments were not valid JSON');
  }

  const parsed = LibraryGenerationOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'LLM library output failed schema validation: ' + JSON.stringify(parsed.error.issues),
    );
  }

  return {
    output: parsed.data,
    modelUsed: gateway.model,
    durationMs: Date.now() - t0,
  };
}

function buildSystemPrompt(form: LibraryFormFields): string {
  return [
    `You are generating a thin TypeScript HTTP client wrapper named '${form.name}'.`,
    'Output ONLY via the submit_library tool — never reply in prose.',
    '',
    'Fixed configuration from the operator:',
    `  name:             ${form.name}`,
    `  description:      ${form.description}`,
    `  baseUrl:          ${form.baseUrl}`,
    `  authStyle:        ${form.authStyle}`,
    `  envVarsRequired:  [${form.envVarsRequired.join(', ')}]`,
    '',
    'You produce:',
    '  1. methods[]: one method per provided curl example, in order.',
    '     Method `name` is camelCase derived from verb + path (e.g. GET /applications → listApplications,',
    '     GET /applications/:id → getApplication, POST /applications → createApplication).',
    '  2. sharedTypes[]: TS `export type X = { ... };` declarations for non-trivial response shapes.',
    '     Infer field names + types STRICTLY from the response sample JSON the operator provided.',
    '     Never invent fields not present in the sample. Mark optional fields that appear in only some samples.',
    '',
    'Hard rules for the body:',
    '  - returnType MUST be wrapped in `Promise<...>` since every method is async.',
    '    Examples: `Promise<Application>`, `Promise<{ data: Application; requestId: string }>`,',
    '    `Promise<void>`. NEVER emit a bare type like `Application` — TypeScript will reject it.',
    '  - You MAY use globalThis.fetch, JSON.parse, JSON.stringify, and helper functions',
    '    `requestUrl(path, params)` and `authHeaders()` which exist in the rendered client.ts.',
    '  - You MUST NOT add new imports — the template provides them all.',
    '  - You MUST construct URLs via `requestUrl(httpPath, pathParams)` so :id-style params are substituted.',
    '  - You MUST throw a typed Error subclass on non-2xx HTTP responses; the template defines `ClientApiError`.',
    '  - You MUST return the parsed response body cast to the method `returnType`.',
    '  - Keep bodies short: typically 6-15 lines.',
    '',
    'Body shape template (adapt — do NOT copy verbatim):',
    '```ts',
    'const url = requestUrl(\'/api/v1/applications/:id\', { id: params.id });',
    'const res = await fetch(url, { method: \'GET\', headers: authHeaders() });',
    'if (!res.ok) throw new ClientApiError(res.status, await res.text());',
    'return (await res.json()) as Application;',
    '```',
  ].join('\n');
}

function buildUserPrompt(examples: CurlExample[]): string {
  const lines = examples.map((e, i) => {
    const parts = [
      `## Endpoint ${i + 1}: ${e.httpVerb} ${e.httpPath}`,
      `Description: ${e.description}`,
    ];
    if (e.requestSample) parts.push('Request body sample:\n```json\n' + e.requestSample + '\n```');
    if (e.responseSample) parts.push('Response sample:\n```json\n' + e.responseSample + '\n```');
    return parts.join('\n');
  });
  return [
    'Generate the wrapper from these endpoint examples (one method each, in order):',
    '',
    lines.join('\n\n'),
  ].join('\n');
}
