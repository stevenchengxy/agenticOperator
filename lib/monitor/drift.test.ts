import { describe, it, expect } from 'vitest';
import { agreementRate, isDrifting } from './drift';

describe('agreementRate', () => {
  it('compares only same-prompt-version pairs and computes agreement', () => {
    const original = [
      { sampledFrom: 'a', verdict: 'grounded', judgePromptVersion: 'v1' },
      { sampledFrom: 'b', verdict: 'not_grounded', judgePromptVersion: 'v1' },
    ];
    const rejudge = [
      { sampledFrom: 'a', verdict: 'grounded', judgePromptVersion: 'v1' },
      { sampledFrom: 'b', verdict: 'grounded', judgePromptVersion: 'v1' },
    ];
    const r = agreementRate(original, rejudge, 'v1');
    expect(r.compared).toBe(2);
    expect(r.agreed).toBe(1);
    expect(r.rate).toBeCloseTo(0.5);
  });

  it('excludes pairs from a different prompt version', () => {
    const original = [{ sampledFrom: 'a', verdict: 'grounded', judgePromptVersion: 'v1' }];
    const rejudge = [{ sampledFrom: 'a', verdict: 'not_grounded', judgePromptVersion: 'v2' }];
    expect(agreementRate(original, rejudge, 'v1').compared).toBe(0);
  });
});

describe('isDrifting', () => {
  it('flags drift below threshold', () => {
    expect(isDrifting(0.5)).toBe(true);
    expect(isDrifting(0.9)).toBe(false);
  });
});
