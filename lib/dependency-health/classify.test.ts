import { describe, it, expect } from 'vitest';
import { RobohireApiError } from '../robohire-client';
import { classifyRobohire, classifyLlm } from './classify';

describe('classifyRobohire — structured errors', () => {
  it('maps QUOTA_EXHAUSTED (402) → quota', () => {
    const e = new RobohireApiError(402, 'QUOTA_EXHAUSTED', 'no funds');
    const oc = classifyRobohire('parseResume', e);
    expect(oc).toMatchObject({ ok: false, provider: 'robohire', op: 'parseResume', reason: 'quota' });
  });
  it('maps RATE_LIMITED (429) → rate_limit', () => {
    expect(classifyRobohire('matchResume', new RobohireApiError(429, 'RATE_LIMITED', 'slow down')))
      .toMatchObject({ ok: false, reason: 'rate_limit' });
  });
  it('maps NETWORK (0) → network', () => {
    expect(classifyRobohire('matchResume', new RobohireApiError(0, 'NETWORK', 'econnreset')))
      .toMatchObject({ ok: false, reason: 'network' });
  });
  it('maps SERVER (5xx) → server', () => {
    expect(classifyRobohire('generateJd', new RobohireApiError(503, 'SERVER', 'down')))
      .toMatchObject({ ok: false, reason: 'server' });
  });
  it('maps 401/403 CLIENT → auth', () => {
    expect(classifyRobohire('parseResume', new RobohireApiError(401, 'CLIENT', 'unauthorized')))
      .toMatchObject({ ok: false, reason: 'auth' });
    expect(classifyRobohire('parseResume', new RobohireApiError(403, 'CLIENT', 'forbidden')))
      .toMatchObject({ ok: false, reason: 'auth' });
  });
  it('maps other 4xx CLIENT → auth (caller treats as non-retriable bad-input)', () => {
    expect(classifyRobohire('parseResume', new RobohireApiError(400, 'CLIENT', 'bad pdf')))
      .toMatchObject({ ok: false, reason: 'auth' });
  });
});

describe('classifyRobohire — empty-200 predicates', () => {
  it('parseResume: empty data → empty; any usable field → ok', () => {
    expect(classifyRobohire('parseResume', { data: {} })).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyRobohire('parseResume', { data: { name: '陈昊' } })).toEqual({ ok: true });
  });
  it('matchResume: no numeric score → empty; score 0 is valid → ok', () => {
    expect(classifyRobohire('matchResume', { data: {} })).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyRobohire('matchResume', { data: { matchScore: 0 } })).toEqual({ ok: true });
    expect(classifyRobohire('matchResume', { data: { matchScore: 0.7 } })).toEqual({ ok: true });
  });
  it('generateJd: no title/description → empty; description present → ok', () => {
    expect(classifyRobohire('generateJd', { data: {} })).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyRobohire('generateJd', { data: { description: 'We are hiring…' } })).toEqual({ ok: true });
  });
  it('inviteCandidate: no entry fields → empty; login_url/reused present → ok', () => {
    expect(classifyRobohire('inviteCandidate', { data: {} })).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyRobohire('inviteCandidate', { data: { login_url: 'https://x' } })).toEqual({ ok: true });
    expect(classifyRobohire('inviteCandidate', { data: { reused: true } })).toEqual({ ok: true });
  });
});

describe('classifyLlm', () => {
  it('insufficient_quota / billing keywords → quota', () => {
    expect(classifyLlm('ruleCheck', new Error('insufficient_quota: add credits')))
      .toMatchObject({ ok: false, provider: 'llm', reason: 'quota' });
    expect(classifyLlm('ruleCheck', new Error('billing hard limit reached')))
      .toMatchObject({ ok: false, reason: 'quota' });
  });
  it('timeout / network errors → network', () => {
    expect(classifyLlm('ruleCheck', new Error('llm-timeout'))).toMatchObject({ ok: false, reason: 'network' });
    expect(classifyLlm('ruleCheck', new Error('ECONNREFUSED'))).toMatchObject({ ok: false, reason: 'network' });
  });
  it('429 message → rate_limit; 401/403 → auth; 5xx → server', () => {
    expect(classifyLlm('ruleCheck', new Error('429 Too Many Requests'))).toMatchObject({ reason: 'rate_limit' });
    expect(classifyLlm('ruleCheck', new Error('401 Unauthorized'))).toMatchObject({ reason: 'auth' });
    expect(classifyLlm('ruleCheck', new Error('500 Internal Server Error'))).toMatchObject({ reason: 'server' });
  });
  it('empty / whitespace completion text → empty; real text → ok', () => {
    expect(classifyLlm('ruleCheck', '')).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyLlm('ruleCheck', '   \n  ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyLlm('ruleCheck', 'decision: PASS')).toEqual({ ok: true });
  });
});
