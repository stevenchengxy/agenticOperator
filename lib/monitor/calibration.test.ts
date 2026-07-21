import { describe, it, expect } from 'vitest';
import { confusion } from './calibration';

describe('confusion', () => {
  it('computes precision/recall/f1/accuracy/kappa (not_grounded = positive class)', () => {
    // tp=2, fp=1, fn=1, tn=2
    const pairs = [
      { judge: 'not_grounded', human: 'not_grounded' }, // tp
      { judge: 'not_grounded', human: 'not_grounded' }, // tp
      { judge: 'not_grounded', human: 'grounded' }, // fp
      { judge: 'grounded', human: 'not_grounded' }, // fn
      { judge: 'grounded', human: 'grounded' }, // tn
      { judge: 'grounded', human: 'grounded' }, // tn
    ] as const;
    const c = confusion([...pairs]);
    expect(c).toMatchObject({ tp: 2, fp: 1, fn: 1, tn: 2 });
    expect(c.precision).toBeCloseTo(2 / 3);
    expect(c.recall).toBeCloseTo(2 / 3);
    expect(c.f1).toBeCloseTo(2 / 3);
    expect(c.accuracy).toBeCloseTo(2 / 3);
    expect(c.kappa).toBeCloseTo(1 / 3);
  });

  it('handles an empty set without NaN', () => {
    const c = confusion([]);
    expect(c.precision).toBe(0);
    expect(Number.isFinite(c.kappa)).toBe(true);
  });
});
