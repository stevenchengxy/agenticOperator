// lib/candidate-lock/decide.test.ts
import { describe, it, expect } from 'vitest';
import { decide, normalizeEmail } from './decide';
import { LockState, type LockSnapshot } from './types';

const base: LockSnapshot = {
  rmhrResumeId: '10086', lockState: LockState.LOCKED, blacklisted: false,
  lockByEmployeeId: '0006006934', lockByName: '李四',
  lockByEmail: 'lisi@company.com', lockTime: '2026-03-06 15:30:00', message: null,
};

describe('decide', () => {
  it('FREE → proceed (we just locked it)', () => {
    expect(decide({ ...base, lockState: LockState.FREE }, 'lisi@company.com').decision).toBe('proceed');
  });
  it('LOCKED by uploader → proceed', () => {
    expect(decide(base, 'lisi@company.com').decision).toBe('proceed');
  });
  it('LOCKED by uploader, case/space-insensitive → proceed', () => {
    expect(decide(base, '  LiSi@Company.com ').decision).toBe('proceed');
  });
  it('LOCKED by other → lock-only', () => {
    const r = decide(base, 'wangwu@company.com');
    expect(r.decision).toBe('lock-only');
    expect(r.reason).toBe('locked-by-other');
  });
  it('PROTECTED → lock-only', () => {
    expect(decide({ ...base, lockState: LockState.PROTECTED }, 'lisi@company.com').reason).toBe('protected');
  });
  it('blacklisted → lock-only regardless of lockState', () => {
    expect(decide({ ...base, blacklisted: true }, 'lisi@company.com').reason).toBe('blacklisted');
  });
  it('empty recruiter email vs empty lockByEmail does NOT count as owned', () => {
    expect(decide({ ...base, lockByEmail: null }, '').decision).toBe('lock-only');
  });
});
