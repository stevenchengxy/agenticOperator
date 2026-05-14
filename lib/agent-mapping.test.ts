import { describe, it, expect } from 'vitest';
import { AGENT_MAP, byShort, byWsId } from './agent-mapping';

describe('AGENT_MAP', () => {
  it('has exactly 23 entries', () => {
    expect(AGENT_MAP).toHaveLength(23);
  });

  it('every short name is unique', () => {
    const shorts = AGENT_MAP.map((a) => a.short);
    expect(new Set(shorts).size).toBe(23);
  });

  it('every wsId is unique', () => {
    const ids = AGENT_MAP.map((a) => a.wsId);
    expect(new Set(ids).size).toBe(23);
  });

  it('uses only the 9 valid stages', () => {
    const validStages = new Set([
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
    for (const a of AGENT_MAP) expect(validStages.has(a.stage)).toBe(true);
  });

  it('uses only the 3 valid kinds', () => {
    const validKinds = new Set(['auto', 'hitl', 'hybrid']);
    for (const a of AGENT_MAP) expect(validKinds.has(a.kind)).toBe(true);
  });

  it('byShort("Matcher") returns the matcher agent', () => {
    const a = byShort('Matcher');
    expect(a?.wsId).toBe('10');
    expect(a?.stage).toBe('match');
  });

  it('byWsId("16") returns PortalSubmitter', () => {
    const a = byWsId('16');
    expect(a?.short).toBe('PortalSubmitter');
    expect(a?.terminal).toBe(true);
  });

  it('exactly 4 agents are terminal', () => {
    // Chatbot is terminal because it emits no events and is outside the business workflow chain.
    const terms = AGENT_MAP.filter((a) => a.terminal).map((a) => a.short);
    expect(terms.sort()).toEqual(['Chatbot', 'InterviewInviter', 'PortalSubmitter', 'Publisher']);
  });

  it('every agent has at least 1 trigger event OR is terminal', () => {
    for (const a of AGENT_MAP) {
      expect(a.triggersEvents.length > 0 || a.terminal).toBe(true);
    }
  });
});
