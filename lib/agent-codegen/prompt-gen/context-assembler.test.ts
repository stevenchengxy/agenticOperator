// context-assembler.test.ts
import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt } from './context-assembler';

const sel = {
  events: [{ name: 'RESUME_PROCESSED', stage: 'resume', summary: 'parsed', direction: 'both', payloadFields: [{ name: 'candidate_id', type: 'String', required: true }] }],
  tools: [{ id: 'partner-pg.getRequirement', category: 'partner-pg', signature: 'getRequirementDetail(id)', importFrom: '@/x', importName: 'getRequirementDetail', summary: 'reads requirement', sideEffects: 'read-only' }] as any,
  entities: [{ name: 'Candidate', fields: [{ name: 'candidate_id', type: 'string', pk: true }] }] as any,
  blueprint: { slug: 'resume-parser-agent', stage: 'resume', triggerEvent: 'RESUME_DOWNLOADED', emitEvents: ['RESUME_PROCESSED'], source: 'export const resumeParserAgent = ...' },
};

describe('assembleSystemPrompt', () => {
  it('includes selected event names, tool ids, entity names, and the blueprint slug', () => {
    const s = assembleSystemPrompt({ selected: sel as any, locked: { triggerEvent: 'RESUME_PROCESSED' } });
    expect(s).toContain('RESUME_PROCESSED');
    expect(s).toContain('partner-pg.getRequirement');
    expect(s).toContain('Candidate');
    expect(s).toContain('resume-parser-agent');
  });
  it('marks locked fields as fixed constraints', () => {
    const s = assembleSystemPrompt({ selected: sel as any, locked: { triggerEvent: 'RESUME_PROCESSED' } });
    expect(s.toLowerCase()).toContain('locked');
    expect(s).toContain('RESUME_PROCESSED');
  });
  it('renders payloadFields when non-empty', () => {
    const s = assembleSystemPrompt({ selected: sel as any, locked: {} });
    expect(s).toContain('candidate_id');
  });
});
