// context-select.test.ts
import { describe, it, expect } from 'vitest';
import { selectContext } from './context-select';
import type { EventContext } from './context-sources';

const events: EventContext[] = [
  { name: 'RESUME_PROCESSED', stage: 'resume', summary: 'parsed resume saved', direction: 'both', payloadFields: [] },
  { name: 'MATCH_RULE_CHECK_PASSED', stage: 'match', summary: 'rule check passed', direction: 'both', payloadFields: [] },
  { name: 'JD_GENERATED', stage: 'jd', summary: 'jd produced', direction: 'both', payloadFields: [] },
  { name: 'RESUME_DOWNLOADED', stage: 'resume', summary: 'resume file downloaded', direction: 'consume', payloadFields: [] },
];
const tools = [
  { id: 'partner-pg.getRequirement', category: 'partner-pg', stage: undefined, canonicalEntity: undefined, signature: '', importFrom: '', importName: '', summary: '', sideEffects: 'read-only' },
  { id: 'allmeta.writeCandidate', category: 'allmeta', canonicalEntity: 'Candidate', signature: '', importFrom: '', importName: '', summary: '', sideEffects: 'writes Candidate' },
] as any;
const entities = [{ name: 'Candidate', fields: [] }, { name: 'Job_Requisition', fields: [] }] as any;
const agents = [
  { slug: 'resume-parser-agent', stage: 'resume', triggerEvent: 'RESUME_DOWNLOADED', emitEvents: ['RESUME_PROCESSED'], source: '...' },
  { slug: 'create-jd-agent', stage: 'jd', triggerEvent: 'CLARIFICATION_READY', emitEvents: ['JD_GENERATED'], source: '...' },
] as any;

describe('selectContext', () => {
  it('when triggerEvent is locked, includes it + same-stage neighbors', () => {
    const sel = selectContext({ intent: '', locked: { triggerEvent: 'RESUME_PROCESSED' }, events, tools, entities, agents });
    const names = sel.events.map((e) => e.name);
    expect(names).toContain('RESUME_PROCESSED');
    // RESUME_DOWNLOADED is in the same 'resume' stage — should be included as neighbor
    expect(names).toContain('RESUME_DOWNLOADED');
    // total is within cap
    expect(sel.events.length).toBeLessThanOrEqual(12);
  });
  it('without locks, ranks events by keyword overlap with intent', () => {
    const sel = selectContext({ intent: 'rule check the candidate match', locked: {}, events, tools, entities, agents });
    expect(sel.events[0].name).toBe('MATCH_RULE_CHECK_PASSED');
  });
  it('includes only entities written by selected tools', () => {
    const sel = selectContext({ intent: 'write candidate', locked: {}, events, tools, entities, agents });
    expect(sel.entities.map((e) => e.name)).toEqual(['Candidate']);
  });
  it('picks the blueprint by explicit slug when given', () => {
    const sel = selectContext({ intent: '', locked: {}, events, tools, entities, agents, blueprintSlug: 'create-jd-agent' });
    expect(sel.blueprint?.slug).toBe('create-jd-agent');
  });
  it('picks the blueprint by stage match when no slug given', () => {
    const sel = selectContext({ intent: '', locked: { stage: 'jd' }, events, tools, entities, agents });
    expect(sel.blueprint?.slug).toBe('create-jd-agent');
  });
});
