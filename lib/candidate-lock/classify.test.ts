// lib/candidate-lock/classify.test.ts
// TDD: tests written BEFORE implementation.

import { describe, it, expect } from 'vitest';
import { RmhrApiError } from './rmhr-client';
import { classifyRmhr } from './classify';

describe('classifyRmhr — BUSINESS code', () => {
  it('BUSINESS with 邮箱 in message → email-unresolvable, recoverable: false', () => {
    const e = new RmhrApiError('BUSINESS', '招聘邮箱不存在，不入库', 0, 1001);
    const result = classifyRmhr(e);
    expect(result).toMatchObject({ ok: false, reason: 'email-unresolvable', recoverable: false });
  });

  it('BUSINESS without 邮箱 in message → infra-fault, recoverable: false', () => {
    const e = new RmhrApiError('BUSINESS', '业务拒绝：不符合条件', 0, 1001);
    const result = classifyRmhr(e);
    expect(result).toMatchObject({ ok: false, reason: 'infra-fault', recoverable: false });
  });

  it('BUSINESS result is never ok:true', () => {
    const e = new RmhrApiError('BUSINESS', '邮箱已停用', 0, 1001);
    const result = classifyRmhr(e);
    expect(result.ok).toBe(false);
  });
});

describe('classifyRmhr — infra / transient faults (recoverable)', () => {
  it('NETWORK → infra-fault, recoverable: true, depReason: network', () => {
    const e = new RmhrApiError('NETWORK', 'fetch failed: ECONNRESET');
    const result = classifyRmhr(e);
    expect(result).toMatchObject({ ok: false, reason: 'infra-fault', recoverable: true, depReason: 'network' });
  });

  it('SERVER → infra-fault, recoverable: true, depReason: server', () => {
    const e = new RmhrApiError('SERVER', 'RMHR 503 Service Unavailable', 503);
    const result = classifyRmhr(e);
    expect(result).toMatchObject({ ok: false, reason: 'infra-fault', recoverable: true, depReason: 'server' });
  });

  it('RATE_LIMITED → infra-fault, recoverable: true, depReason: rate_limit', () => {
    const e = new RmhrApiError('RATE_LIMITED', 'RMHR 429 Too Many Requests', 429);
    const result = classifyRmhr(e);
    expect(result).toMatchObject({ ok: false, reason: 'infra-fault', recoverable: true, depReason: 'rate_limit' });
  });

  it('QUOTA_EXHAUSTED → infra-fault, recoverable: true, depReason: quota', () => {
    const e = new RmhrApiError('QUOTA_EXHAUSTED', 'RMHR 402 Payment Required', 402);
    const result = classifyRmhr(e);
    expect(result).toMatchObject({ ok: false, reason: 'infra-fault', recoverable: true, depReason: 'quota' });
  });
});

describe('classifyRmhr — CLIENT (non-business 4xx / auth)', () => {
  it('CLIENT → infra-fault, recoverable: false (bad creds / bad input)', () => {
    const e = new RmhrApiError('CLIENT', 'RMHR 401 Unauthorized', 401);
    const result = classifyRmhr(e);
    expect(result).toMatchObject({ ok: false, reason: 'infra-fault', recoverable: false });
  });

  it('CLIENT 403 → infra-fault, recoverable: false', () => {
    const e = new RmhrApiError('CLIENT', 'RMHR 403 Forbidden', 403);
    const result = classifyRmhr(e);
    expect(result).toMatchObject({ ok: false, reason: 'infra-fault', recoverable: false });
  });
});

describe('classifyRmhr — unknown / non-RmhrApiError errors', () => {
  it('plain Error (non-RmhrApiError) → infra-fault, recoverable: true (unknown=infra)', () => {
    const e = new Error('unexpected failure');
    const result = classifyRmhr(e);
    expect(result).toMatchObject({ ok: false, reason: 'infra-fault', recoverable: true });
  });

  it('string thrown → infra-fault, recoverable: true', () => {
    const result = classifyRmhr('some string error');
    expect(result).toMatchObject({ ok: false, reason: 'infra-fault', recoverable: true });
  });

  it('null thrown → infra-fault, recoverable: true', () => {
    const result = classifyRmhr(null);
    expect(result).toMatchObject({ ok: false, reason: 'infra-fault', recoverable: true });
  });
});
