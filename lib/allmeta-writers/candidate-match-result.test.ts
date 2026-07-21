import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeWriteInstance: vi.fn(async (..._args: unknown[]) => ({ ok: true, instance: {} })),
}));
vi.mock('./_helpers', () => ({
  safeWriteInstance: mocks.safeWriteInstance,
  compact: (input: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
  nonEmptyString: (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : null,
  asNumberOrNull: (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null,
}));

import { writeCandidateMatchResultInstance } from './candidate-match-result';

describe('writeCandidateMatchResultInstance', () => {
  it('writes the optional-rule reference during rule-check stage', async () => {
    await writeCandidateMatchResultInstance({
      candidate_match_result_id: 'cmr-1',
      candidate_id: 'c-1',
      job_requisition_id: 'jr-1',
      rule_check_result: '通过',
      rule_check_reason: '【可选规则参考（不影响通过/未通过）】[]',
    });

    expect(mocks.safeWriteInstance).toHaveBeenLastCalledWith(
      'Candidate_Match_Result',
      expect.objectContaining({
        rule_check_result: '通过',
        rule_check_reason: '【可选规则参考（不影响通过/未通过）】[]',
      }),
    );
  });

  it('does not erase the rule-check reference during the later match stage', async () => {
    await writeCandidateMatchResultInstance({
      candidate_match_result_id: 'cmr-1',
      candidate_id: 'c-1',
      job_requisition_id: 'jr-1',
      overall_match_score: 88,
    });

    const payload = mocks.safeWriteInstance.mock.calls.at(-1)?.[1] as unknown as Record<string, unknown>;
    expect(payload).not.toHaveProperty('rule_check_reason');
    expect(payload.overall_match_score).toBe(88);
  });
});
