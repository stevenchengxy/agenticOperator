import { describe, expect, it } from 'vitest';
import {
  classifyFailureKind,
  isBlockingFlag,
  parseFailureReason,
} from './failure-reason';

describe('failure-reason helpers', () => {
  it('parses bracketed rule failure reasons', () => {
    expect(
      parseFailureReason('[10-26] OPPO小米竞对红线（信息不足·需人工复核）: resume.experience 为空字符串'),
    ).toMatchObject({
      ruleId: '10-26',
      ruleName: 'OPPO小米竞对红线（信息不足·需人工复核）',
      detail: 'resume.experience 为空字符串',
    });
  });

  it('classifies info-gap failures before generic review wording', () => {
    expect(
      classifyFailureKind(
        '[10-26] OPPO小米竞对红线（信息不足·需人工复核）: resume.experience 为空字符串',
      ),
    ).toBe('insufficient');
  });

  it('treats supplement/review/block actions as blocking audit causes', () => {
    expect(isBlockingFlag({ result: 'PASS', next_action: 'supplement' })).toBe(true);
    expect(isBlockingFlag({ result: 'NOT_TRIGGERED', next_action: 'continue' })).toBe(false);
    expect(isBlockingFlag({ result: 'FAIL', next_action: 'block' })).toBe(true);
  });
});
