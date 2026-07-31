import { describe, expect, it } from 'vitest';
import { normalizeCandidateExpectationPayload } from './candidate-expectation';

describe('normalizeCandidateExpectationPayload', () => {
  it('accepts the actual RESUME_DOWNLOADED expectation_payload shape', () => {
    expect(
      normalizeCandidateExpectationPayload({
        expected_location: ' 南京 ',
        expected_position: '电气工程师',
        expected_salary_range: '13000-15000',
      }),
    ).toEqual({
      expected_location: '南京',
      expected_position: '电气工程师',
      expected_salary_range: '13000-15000',
    });
  });

  it('whitelists fields and preserves an explicitly empty constraints list', () => {
    expect(
      normalizeCandidateExpectationPayload({
        candidate_id: 'must-not-leak',
        expected_industry: ' 新能源 ',
        expected_company_size: '',
        constraints: [' 不接受夜班 ', '', 42],
      }),
    ).toEqual({
      expected_industry: '新能源',
      constraints: ['不接受夜班'],
    });

    expect(normalizeCandidateExpectationPayload({ constraints: [] })).toEqual({
      constraints: [],
    });
  });

  it('returns null for absent or empty payloads', () => {
    expect(normalizeCandidateExpectationPayload(null)).toBeNull();
    expect(normalizeCandidateExpectationPayload({})).toBeNull();
    expect(normalizeCandidateExpectationPayload({ expected_position: '  ' })).toBeNull();
  });
});
