import { describe, it, expect } from 'vitest';
import { verdictLabel } from './verdict-label';

// identity translator → assert the chosen i18n key for each internal value.
const t = (k: string) => k;

describe('verdictLabel', () => {
  it('maps decision/flag results to the 通过/不通过 vocabulary keys', () => {
    expect(verdictLabel('PASS', t)).toBe('rc_verdict_pass');
    expect(verdictLabel('FAIL', t)).toBe('rc_verdict_fail');
    expect(verdictLabel('INSUFFICIENT_INFO', t)).toBe('rc_verdict_insufficient');
    expect(verdictLabel('REVIEW', t)).toBe('rc_verdict_review');
    expect(verdictLabel('PENDING', t)).toBe('rc_verdict_review');
    expect(verdictLabel('NOT_TRIGGERED', t)).toBe('rc_verdict_na');
    expect(verdictLabel('NOT_APPLICABLE', t)).toBe('rc_verdict_na');
  });

  it('is case-insensitive', () => {
    expect(verdictLabel('pass', t)).toBe('rc_verdict_pass');
    expect(verdictLabel('insufficient_info', t)).toBe('rc_verdict_insufficient');
  });

  it('passes through unknown / empty values unchanged', () => {
    expect(verdictLabel('WHATEVER', t)).toBe('WHATEVER');
    expect(verdictLabel(null, t)).toBe('');
    expect(verdictLabel(undefined, t)).toBe('');
  });
});
