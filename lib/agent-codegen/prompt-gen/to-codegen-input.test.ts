// to-codegen-input.test.ts
import { describe, it, expect } from 'vitest';
import { toCodegenInput } from './to-codegen-input';
import type { AgentPrompt } from './prompt-types';
import type { AgentFormFields } from '../spec-types';

const prompt: AgentPrompt = {
  intent: 'screen resumes',
  role: 'Screens parsed resumes for a requisition.',
  trigger: { event: 'RESUME_PROCESSED', payloadExpectations: 'candidate_id', confirmed: true },
  inputs: ['parsed_resume row'],
  steps: [
    { id: 'fetch-resume', description: 'load parsed resume from partner-pg', usesTools: ['partner-pg.getRequirement'] },
    { id: 'emit-result', description: 'emit the downstream event' },
  ],
  tools: ['partner-pg.getRequirement'],
  emits: ['MATCH_RULE_CHECK_PASSED'],
  errorHandling: 'retry',
  constraints: ['dual-write Postgres then Neo4j'],
  acceptance: ['emits exactly one downstream event'],
  fieldOrigin: {},
};
const form: AgentFormFields = {
  slug: 'resume-screener-agent', displayName: 'Resume Screener', stage: 'resume', ownerTeam: 'recruiting',
  triggerEvent: 'RESUME_PROCESSED', emitEvents: ['MATCH_RULE_CHECK_PASSED'], retries: 2, errorHandling: 'retry',
};

describe('toCodegenInput', () => {
  it('returns the confirmed form verbatim', () => {
    expect(toCodegenInput(prompt, form).form).toEqual(form);
  });
  it('renders businessLogic prose containing role, every step description, and constraints', () => {
    const bl = toCodegenInput(prompt, form).businessLogic;
    expect(bl).toContain('Screens parsed resumes');
    expect(bl).toContain('load parsed resume from partner-pg');
    expect(bl).toContain('emit the downstream event');
    expect(bl).toContain('dual-write Postgres then Neo4j');
  });
  it('produces businessLogic that satisfies the pipeline route min length (>= 8 chars)', () => {
    expect(toCodegenInput(prompt, form).businessLogic.length).toBeGreaterThanOrEqual(8);
  });
});
