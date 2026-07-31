import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeWriteInstance: vi.fn(async (..._args: unknown[]) => ({ ok: true, instance: {} })),
}));

vi.mock('./_helpers', () => ({
  safeWriteInstance: mocks.safeWriteInstance,
  compact: (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)),
}));

import { writeCandidateExpectationInstance } from './candidate-expectation';

describe('writeCandidateExpectationInstance', () => {
  it('writes the strict RAAS-v1 Candidate_Expectation shape', async () => {
    await writeCandidateExpectationInstance({
      candidate_expectation_id: 'expectation-1',
      candidate_id: 'candidate-1',
      expectation: {
        expected_position: ' 电气工程师 ',
        expected_location: '南京',
        expected_salary_range: '13000-15000',
        expected_industry: '新能源',
        constraints: ['不接受夜班'],
      },
    });

    expect(mocks.safeWriteInstance).toHaveBeenCalledWith(
      'Candidate_Expectation',
      {
        candidate_expectation_id: 'expectation-1',
        candidate_id: 'candidate-1',
        expected_position: '电气工程师',
        expected_location: '南京',
        expected_salary_range: '13000-15000',
        expected_industry: '新能源',
        constraints: ['不接受夜班'],
        updated_time: expect.any(String),
      },
    );
  });

  it('does not send fields outside the deployed ontology schema', async () => {
    await writeCandidateExpectationInstance({
      candidate_expectation_id: 'expectation-2',
      candidate_id: 'candidate-2',
      expectation: { expected_position: '后端工程师' },
    });

    const payload = mocks.safeWriteInstance.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('expected_roles');
    expect(payload).not.toHaveProperty('expected_work_mode');
    expect(payload).not.toHaveProperty('outsourcing_acceptance_level');
    expect(payload).not.toHaveProperty('expected_company_size');
    expect(payload).not.toHaveProperty('domainId');
  });
});
