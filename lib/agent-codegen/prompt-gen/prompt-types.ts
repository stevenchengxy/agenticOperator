// prompt-types.ts
// AgentPrompt — the human-readable, reviewable artifact PromptGen produces and
// the operator approves before it is injected into the existing codegen
// pipeline. Split mirrors spec-types.ts: a Zod schema for validation + a
// hand-written JSON schema for the OpenAI tool call (strict-mode safe).
//
// LLM emits an AgentPromptDraft (no provenance, no confirmed flag). The route
// then attaches fieldOrigin + trigger.confirmed=false to make the full
// AgentPrompt the UI/versioning layer carries.

import { z } from 'zod';

export const PromptStepSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/, 'step id must be kebab-case'),
  description: z.string().min(1).max(600),
  usesTools: z.array(z.string().max(80)).max(8).optional(),
});
export type PromptStep = z.infer<typeof PromptStepSchema>;

export const AgentPromptDraftSchema = z.object({
  intent: z.string().min(1).max(400),
  role: z.string().min(1).max(600),
  trigger: z.object({
    event: z.string().min(1).max(80),
    payloadExpectations: z.string().max(1200),
  }),
  inputs: z.array(z.string().max(200)).max(20),
  steps: z.array(PromptStepSchema).min(1).max(12),
  tools: z.array(z.string().max(80)).max(20),
  emits: z.array(z.string().max(80)).max(8),
  errorHandling: z.enum(['retry', 'dlq', 'hitl-fallback']),
  constraints: z.array(z.string().max(300)).max(20),
  acceptance: z.array(z.string().max(300)).max(20),
  additionalTriggerEvents: z.array(z.string().max(80)).max(8).optional(),
});
export type AgentPromptDraft = z.infer<typeof AgentPromptDraftSchema>;

export type FieldOrigin = 'inferred' | 'locked' | 'confirmed';

// Full artifact = draft + provenance + the operator-driven confirmed flag.
export type AgentPrompt = AgentPromptDraft & {
  trigger: AgentPromptDraft['trigger'] & { confirmed: boolean };
  fieldOrigin: Record<string, FieldOrigin>;
  additionalTriggerEvents?: string[];
};

// Hand-written so we control OpenAI strict-mode compatibility (same reason as
// spec-types.ts). Provenance/confirmed are NOT in here — they aren't the LLM's.
export const AGENT_PROMPT_DRAFT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'role', 'trigger', 'inputs', 'steps', 'tools', 'emits', 'errorHandling', 'constraints', 'acceptance'],
  properties: {
    intent: { type: 'string' },
    role: { type: 'string' },
    trigger: {
      type: 'object',
      additionalProperties: false,
      required: ['event', 'payloadExpectations'],
      properties: {
        event: { type: 'string', description: 'Must be a known event name from the event registry / EventDefinition table.' },
        payloadExpectations: { type: 'string', description: 'Fields the handler reads off event.data.' },
      },
    },
    inputs: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description'],
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          usesTools: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    tools: { type: 'array', items: { type: 'string' } },
    emits: { type: 'array', items: { type: 'string' } },
    errorHandling: { type: 'string', enum: ['retry', 'dlq', 'hitl-fallback'] },
    constraints: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'string' } },
    additionalTriggerEvents: { type: 'array', items: { type: 'string' } },
  },
} as const;
