import { describe, it, expect } from 'vitest';
import { foldDecision } from './runner';
import type { MatchResumeCheckStats } from './types';

function stats(p: Partial<MatchResumeCheckStats>): MatchResumeCheckStats {
  return {
    total: 0,
    pass: 0,
    fail: 0,
    pending: 0,
    insufficient_info: 0,
    not_triggered: 0,
    not_executed: 0,
    ...p,
  };
}

describe('foldDecision (2026-05-26: REVIEW folded into PASS)', () => {
  it('FAIL when any rule failed', () => {
    expect(foldDecision(stats({ fail: 1, pass: 3 }))).toBe('FAIL');
  });

  it('pending folds to PASS (no longer REVIEW)', () => {
    // 规则要求 HSM 主观判断(pending)不再阻断、不再单列 REVIEW — 直接 PASS。
    expect(foldDecision(stats({ pending: 2, pass: 1 }))).toBe('PASS');
  });

  it('insufficient_info folds to PASS', () => {
    expect(foldDecision(stats({ insufficient_info: 2 }))).toBe('PASS');
  });

  it('all pass → PASS', () => {
    expect(foldDecision(stats({ pass: 5 }))).toBe('PASS');
  });

  it('fail wins over pending', () => {
    expect(foldDecision(stats({ fail: 1, pending: 3 }))).toBe('FAIL');
  });
});
