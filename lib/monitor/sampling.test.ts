import { describe, it, expect } from 'vitest';
import { sampleByPct } from './sampling';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('sampleByPct', () => {
  it('returns empty for empty input or 0%', () => {
    expect(sampleByPct([], 10)).toEqual([]);
    expect(sampleByPct(range(10), 0)).toEqual([]);
  });

  it('returns everything at 100%', () => {
    expect(sampleByPct(range(5), 100)).toEqual([0, 1, 2, 3, 4]);
  });

  it('takes ~pct of items by stable stride', () => {
    const s = sampleByPct(range(100), 10);
    expect(s.length).toBe(10);
    expect(s[0]).toBe(0);
    expect(s).toEqual(sampleByPct(range(100), 10)); // deterministic
  });

  it('strides at 50%', () => {
    expect(sampleByPct(range(10), 50)).toEqual([0, 2, 4, 6, 8]);
  });
});
