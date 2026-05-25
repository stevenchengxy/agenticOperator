// Phase 2 Library Codegen — types.
//
// Same split principle as v2 agent codegen:
//   - LibraryFormFields: human decisions (lib name, baseURL, auth, env vars)
//   - CurlExample[]: operator-supplied seed (one entry per endpoint)
//   - LLM only emits the methods[] array (name, verb, path, params/return
//     types) and the per-method TypeScript body.
//
// The MVP intentionally narrows the research doc's scope (§B):
//   - one seed mode (curl examples; OpenAPI / DB schema land later)
//   - one kind (http-client; db-wrapper / sdk-wrapper later)
//   - one output file (lib/generated/<name>/client.ts)
//   - no automatic TOOL_REGISTRY append (manual paste from output for now)

import { z } from 'zod';

export const AuthStyleSchema = z.enum(['bearer', 'api-key', 'basic', 'none']);
export type AuthStyle = z.infer<typeof AuthStyleSchema>;

export const LibraryFormFieldsSchema = z.object({
  /** kebab-case e.g. 'rms-client'. lib/generated/<name>/ is the output dir. */
  name: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z][a-z0-9-]*$/, "name must be kebab-case starting with a letter"),
  /** Human-readable purpose, e.g. "Thin wrapper around RMS REST API". */
  description: z.string().min(4).max(200),
  /** Base URL the wrapper points at. */
  baseUrl: z.string().url(),
  authStyle: AuthStyleSchema,
  /** Env vars the generated client reads at runtime. UI seeds reasonable defaults. */
  envVarsRequired: z.array(z.string().min(1)).max(6),
});
export type LibraryFormFields = z.infer<typeof LibraryFormFieldsSchema>;

export const CurlExampleSchema = z.object({
  httpVerb: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** Path WITH path parameter placeholders, e.g. '/api/v1/applications/:id'. */
  httpPath: z.string().min(1).max(200),
  /** One-line operator description of what this endpoint does. */
  description: z.string().min(4).max(200),
  /** Optional JSON body example (for POST/PUT/PATCH). */
  requestSample: z.string().optional(),
  /** Optional response body example so LLM can infer return shape. */
  responseSample: z.string().optional(),
});
export type CurlExample = z.infer<typeof CurlExampleSchema>;

// LLM Call C output: per-method spec + body, one entry per curl example.
export const LibMethodSchema = z.object({
  /** camelCase TS function name, e.g. 'getApplication'. */
  name: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z][A-Za-z0-9]*$/, 'method name must be camelCase'),
  description: z.string().min(4).max(200),
  httpVerb: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  httpPath: z.string().min(1).max(200),
  /** TS source for the function body (inside the async function, no outer braces).
   *  May reference `fetch`, the `client` helpers, and shared types. */
  body: z.string().min(8),
  /** TS signature for params (e.g. 'id: string' or '{ id: string; title: string }'). */
  paramsType: z.string().min(1).max(600),
  /** TS return type (e.g. 'Promise<Application>'). */
  returnType: z.string().min(1).max(200),
});
export type LibMethod = z.infer<typeof LibMethodSchema>;

export const LibraryGenerationOutputSchema = z.object({
  methods: z.array(LibMethodSchema).min(1).max(20),
  /** Shared TS type definitions emitted into types.ts. Each entry is a full
   *  `export type X = { ... };` declaration string. */
  sharedTypes: z
    .array(
      z.object({
        name: z.string().min(1).max(48),
        tsDefinition: z.string().min(8).max(2000),
      }),
    )
    .max(20),
});
export type LibraryGenerationOutput = z.infer<typeof LibraryGenerationOutputSchema>;

// JSON schema (for OpenAI structured output / function calling).
export const LIB_GEN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['methods', 'sharedTypes'],
  properties: {
    methods: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'httpVerb', 'httpPath', 'body', 'paramsType', 'returnType'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          httpVerb: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          httpPath: { type: 'string' },
          body: { type: 'string' },
          paramsType: { type: 'string' },
          returnType: { type: 'string' },
        },
      },
    },
    sharedTypes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'tsDefinition'],
        properties: {
          name: { type: 'string' },
          tsDefinition: { type: 'string' },
        },
      },
    },
  },
} as const;
