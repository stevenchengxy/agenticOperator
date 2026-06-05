import { describe, it, expect } from 'vitest';
import { parseGroundedness, decideVerdict, buildGroundednessPrompt } from './groundedness';

describe('parseGroundedness', () => {
  it('parses a fenced JSON judge response', () => {
    const r = parseGroundedness('```json\n{"score":0.5,"verdict":"not_grounded","rationale":"x"}\n```');
    expect(r).toEqual({ score: 0.5, verdict: 'not_grounded', rationale: 'x' });
  });
  it('returns null on garbage', () => {
    expect(parseGroundedness('not json at all')).toBeNull();
  });
  it('returns null when neither score nor verdict is usable', () => {
    expect(parseGroundedness('{"foo":1}')).toBeNull();
  });
});

describe('decideVerdict', () => {
  it('grounded at/above threshold, not_grounded below, unsure on null', () => {
    expect(decideVerdict(0.9)).toBe('grounded');
    expect(decideVerdict(0.5)).toBe('not_grounded');
    expect(decideVerdict(null)).toBe('unsure');
  });
});

describe('buildGroundednessPrompt', () => {
  it('embeds output and context', () => {
    const { system, user } = buildGroundednessPrompt({
      sampledFrom: 'run1',
      domain: '招聘-v1',
      agent: 'Matcher',
      runId: 'run1',
      auditId: null,
      anchors: {},
      output: 'CLAIM_TEXT',
      context: 'RULE_CONTEXT',
    });
    expect(system.length).toBeGreaterThan(0);
    expect(user).toContain('CLAIM_TEXT');
    expect(user).toContain('RULE_CONTEXT');
  });
});
