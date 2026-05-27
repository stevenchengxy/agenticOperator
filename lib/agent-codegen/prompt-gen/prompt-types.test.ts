// prompt-types.test.ts
import { describe, it, expect } from 'vitest';
import { AgentPromptDraftSchema, AGENT_PROMPT_DRAFT_JSON_SCHEMA } from './prompt-types';

const valid = {
  intent: 'screen inbound resumes against the JD',
  role: 'Screens resumes for a requisition and flags the top candidates.',
  trigger: { event: 'RESUME_PROCESSED', payloadExpectations: 'event.data.candidate_id, resume_id' },
  inputs: ['partner-pg parsed_resume row', 'Neo4j Candidate node'],
  steps: [{ id: 'fetch-resume', description: 'load the parsed resume from partner-pg' }],
  tools: ['partner-pg.getRequirement'],
  emits: ['MATCH_RULE_CHECK_PASSED'],
  errorHandling: 'retry',
  constraints: ['dual-write Postgres then Neo4j'],
  acceptance: ['emits exactly one downstream event'],
};

describe('AgentPromptDraftSchema', () => {
  it('accepts a well-formed draft', () => {
    expect(AgentPromptDraftSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects an empty steps array', () => {
    expect(AgentPromptDraftSchema.safeParse({ ...valid, steps: [] }).success).toBe(false);
  });
  it('rejects a non-kebab step id', () => {
    const bad = { ...valid, steps: [{ id: 'Fetch_Resume', description: 'x' }] };
    expect(AgentPromptDraftSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects an invalid errorHandling enum', () => {
    expect(AgentPromptDraftSchema.safeParse({ ...valid, errorHandling: 'panic' }).success).toBe(false);
  });
  it('exposes a JSON schema whose required list omits provenance fields', () => {
    expect(AGENT_PROMPT_DRAFT_JSON_SCHEMA.required).not.toContain('fieldOrigin');
    expect(AGENT_PROMPT_DRAFT_JSON_SCHEMA.required).not.toContain('confirmed');
  });
});
