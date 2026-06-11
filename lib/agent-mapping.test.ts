import { describe, it, expect } from 'vitest';
import { AGENT_MAP, byShort, byWsId } from './agent-mapping';

describe('AGENT_MAP', () => {
  it('has exactly 26 entries', () => {
    // 24 base + CandidateIdentity + CandidateOwnership (2026-06-09, domain 招聘-v1).
    expect(AGENT_MAP).toHaveLength(26);
  });

  it('every short name is unique', () => {
    const shorts = AGENT_MAP.map((a) => a.short);
    expect(new Set(shorts).size).toBe(26);
  });

  it('every wsId is unique', () => {
    const ids = AGENT_MAP.map((a) => a.wsId);
    expect(new Set(ids).size).toBe(26);
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

  it('exactly 3 agents are terminal', () => {
    // Chatbot is terminal (emits nothing, outside the workflow chain); Publisher +
    // PortalSubmitter are branch leaves. InterviewInviter became non-terminal on
    // 2026-05-25 (its _SENT is consumed by AIInterviewer — see agent-mapping.ts).
    // The new CandidateIdentity / CandidateOwnership agents are audit-only but carry a
    // RESUME_PROCESSED trigger, so they satisfy the trigger-or-terminal invariant
    // without being terminal.
    const terms = AGENT_MAP.filter((a) => a.terminal).map((a) => a.short);
    expect(terms.sort()).toEqual(['Chatbot', 'PortalSubmitter', 'Publisher']);
  });

  it('every agent has at least 1 trigger event OR is terminal', () => {
    for (const a of AGENT_MAP) {
      expect(a.triggersEvents.length > 0 || a.terminal).toBe(true);
    }
  });
});
