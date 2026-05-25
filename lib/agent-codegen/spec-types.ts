// AgentSpec — the structured intermediate representation between operator
// prompt and generated Inngest agent code. Designed so:
//   1. LLM Call A (spec-extractor) can emit it under a Zod-validated schema
//   2. Spec validator (deterministic) can check event names / lib refs
//   3. Template renderer reads it to emit the agent .ts skeleton
//   4. LLM Call B (step-body-filler) gets the per-step description as input
//
// See docs/2026-05-25-ao-behavior-codegen-research.md §A.3 + the design at
// docs/superpowers/specs/2026-05-25-ao-domain-codegen-compiler-design.md.

import { z } from 'zod';

// Stage list mirrors lib/agent-mapping.ts Stage type. Duplicated here as a
// Zod enum so the LLM is forced to pick one of these and not invent new ones.
export const StageEnum = z.enum([
  'system',
  'requirement',
  'jd',
  'resume',
  'match',
  'interview',
  'eval',
  'package',
  'submit',
]);

export const AgentSpecStepSchema = z.object({
  /** Kebab-case ID used as the step.run('id', ...) argument. */
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
  /** Free-text describing what this step does. LLM Call B reads it. */
  description: z.string().min(1).max(500),
  /** Optional Tool Registry key — guides LLM Call B's import + call selection. */
  callsLib: z.string().optional(),
  /** Step inputs that come from upstream step return values or event payload. */
  inputs: z.array(z.string()).optional(),
  /** Step outputs (variable names) that downstream steps may reference. */
  outputs: z.array(z.string()).optional(),
});

export const AgentSpecSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*-agent$/, "slug must be kebab-case ending in '-agent'"),
  displayName: z.string().min(1).max(80),
  stage: StageEnum,
  ownerTeam: z.string().min(1).max(40),
  triggerEvent: z.string().min(1).max(80),
  emitEvents: z.array(z.string().min(1).max(80)).min(0).max(8),
  retries: z.number().int().min(0).max(5).default(2),
  steps: z.array(AgentSpecStepSchema).min(1).max(12),
  errorHandling: z.enum(['retry', 'dlq', 'hitl-fallback']).default('retry'),
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;
export type AgentSpecStep = z.infer<typeof AgentSpecStepSchema>;

// Form-first split (Codegen v2): the operator-entered fields are everything
// EXCEPT the steps[] array. The LLM only fills `steps`; identity/wire-up/
// behavior decisions stay human. This keeps LLM blast radius small and
// makes "regenerate existing agent" round-trip safely against AGENT_MAP.
export const AgentFormFieldsSchema = AgentSpecSchema.omit({ steps: true });
export type AgentFormFields = z.infer<typeof AgentFormFieldsSchema>;

// LLM Call A output schema in v2 — just the steps array. Constrains the
// model to its single job and shaves ~70% off the structured-output
// schema vs. the v1 full-AgentSpec call.
export const STEPS_ONLY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description'],
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          callsLib: { type: ['string', 'null'] },
          inputs: { type: 'array', items: { type: 'string' } },
          outputs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

/**
 * JSON Schema form of AgentSpecSchema — used as the OpenAI function-call
 * parameter schema (structured output). Kept hand-written rather than via
 * zod-to-json-schema so we control compatibility with OpenAI strict mode
 * (no `default`, no `min/max` on numbers in some versions, etc.).
 */
export const AGENT_SPEC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'slug',
    'displayName',
    'stage',
    'ownerTeam',
    'triggerEvent',
    'emitEvents',
    'retries',
    'steps',
    'errorHandling',
  ],
  properties: {
    slug: { type: 'string', description: "kebab-case ending in '-agent', e.g. 'salary-checker-agent'" },
    displayName: { type: 'string' },
    stage: {
      type: 'string',
      enum: ['system', 'requirement', 'jd', 'resume', 'match', 'interview', 'eval', 'package', 'submit'],
    },
    ownerTeam: { type: 'string' },
    triggerEvent: { type: 'string', description: 'Must be a known event name from the EventDefinition table.' },
    emitEvents: { type: 'array', items: { type: 'string' } },
    retries: { type: 'integer' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description'],
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          callsLib: { type: ['string', 'null'] },
          inputs: { type: 'array', items: { type: 'string' } },
          outputs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    errorHandling: { type: 'string', enum: ['retry', 'dlq', 'hitl-fallback'] },
  },
} as const;
