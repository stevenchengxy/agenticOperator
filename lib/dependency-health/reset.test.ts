import { describe, it, expect } from 'vitest';
import { parseResetRow, applyResets } from './reset';
import type { DepFailure } from './types';

function fail(provider: DepFailure['provider'], tsIso: string): DepFailure {
  return { provider, op: 'parseResume', reason: 'quota', domain: '招聘-v1', runId: null, ts: new Date(tsIso) };
}

describe('parseResetRow', () => {
  it('parses a provider reset marker', () => {
    const r = parseResetRow({ ts: new Date('2026-06-05T10:00:00Z'), payloadJson: JSON.stringify({ provider: 'robohire' }) });
    expect(r).toEqual({ provider: 'robohire', ts: new Date('2026-06-05T10:00:00Z') });
  });
  it('returns null for malformed / unknown provider', () => {
    expect(parseResetRow({ ts: new Date(), payloadJson: null })).toBeNull();
    expect(parseResetRow({ ts: new Date(), payloadJson: '{bad' })).toBeNull();
    expect(parseResetRow({ ts: new Date(), payloadJson: JSON.stringify({ provider: 'x' }) })).toBeNull();
  });
});

describe('applyResets', () => {
  it('drops failures at/before the latest reset for that provider', () => {
    const failures = [
      fail('robohire', '2026-06-05T09:50:00Z'), // before reset → dropped
      fail('robohire', '2026-06-05T10:10:00Z'), // after reset → kept
      fail('llm', '2026-06-05T09:50:00Z'), // different provider, no reset → kept
    ];
    const resets = [{ provider: 'robohire' as const, ts: new Date('2026-06-05T10:00:00Z') }];
    const out = applyResets(failures, resets);
    expect(out).toHaveLength(2);
    expect(out.find((f) => f.provider === 'robohire')!.ts.toISOString()).toBe('2026-06-05T10:10:00.000Z');
    expect(out.some((f) => f.provider === 'llm')).toBe(true);
  });

  it('uses the LATEST reset per provider when several exist', () => {
    const failures = [fail('robohire', '2026-06-05T10:05:00Z')];
    const resets = [
      { provider: 'robohire' as const, ts: new Date('2026-06-05T10:00:00Z') },
      { provider: 'robohire' as const, ts: new Date('2026-06-05T10:10:00Z') }, // latest, after the failure
    ];
    expect(applyResets(failures, resets)).toHaveLength(0);
  });

  it('is a no-op when there are no resets', () => {
    const failures = [fail('robohire', '2026-06-05T10:00:00Z')];
    expect(applyResets(failures, [])).toEqual(failures);
  });
});
