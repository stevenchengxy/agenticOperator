import { describe, it, expect } from 'vitest';
import { normalizeVerdict, tallyJury, familyOf, pickJuryModels } from './judge';

describe('normalizeVerdict', () => {
  it('maps grounded/pass/yes synonyms', () => {
    expect(normalizeVerdict('PASS')).toBe('grounded');
    expect(normalizeVerdict('grounded')).toBe('grounded');
  });
  it('maps not_grounded/fail/no synonyms', () => {
    expect(normalizeVerdict('fail')).toBe('not_grounded');
    expect(normalizeVerdict('ungrounded')).toBe('not_grounded');
  });
  it('falls back to unsure', () => {
    expect(normalizeVerdict('maybe')).toBe('unsure');
    expect(normalizeVerdict(null)).toBe('unsure');
  });
});

describe('tallyJury', () => {
  it('takes the majority of grounded/not_grounded', () => {
    const r = tallyJury(['grounded', 'grounded', 'not_grounded']);
    expect(r.verdict).toBe('grounded');
    expect(r.agreement).toBeCloseTo(2 / 3);
    expect(r.counts).toEqual({ grounded: 2, not_grounded: 1, unsure: 0 });
  });
  it('does not let unsure win', () => {
    expect(tallyJury(['not_grounded', 'not_grounded', 'unsure']).verdict).toBe('not_grounded');
  });
  it('returns unsure on a tie', () => {
    expect(tallyJury(['grounded', 'not_grounded']).verdict).toBe('unsure');
  });
});

describe('familyOf', () => {
  it('infers families from model ids', () => {
    expect(familyOf('anthropic/claude-opus-4.6')).toBe('anthropic');
    expect(familyOf('openai/gpt-5.4')).toBe('openai');
    expect(familyOf('google/gemini-2.5-pro')).toBe('google');
  });
});

describe('pickJuryModels', () => {
  it('picks N models, none in the producer family, all distinct families', () => {
    const models = pickJuryModels('openai/gpt-4o', 3);
    expect(models.length).toBe(3);
    expect(models.every((m) => familyOf(m) !== 'openai')).toBe(true);
    const fams = models.map(familyOf);
    expect(new Set(fams).size).toBe(fams.length); // distinct families
  });
});
