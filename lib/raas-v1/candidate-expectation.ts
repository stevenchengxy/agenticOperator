// RAAS RESUME_DOWNLOADED `expectation_payload` contract.
//
// The browser extension only sends non-empty values, but this boundary still
// projects the payload onto CandidateExpectation's seven public fields. Keeping
// the projection here prevents arbitrary event keys from becoming SQL columns
// or strict Allmeta properties.

export type CandidateExpectationPatch = {
  expected_position?: string;
  expected_location?: string;
  expected_salary_range?: string;
  outsourcing_acceptance_level?: string;
  expected_industry?: string;
  expected_company_size?: string;
  constraints?: string[];
};

const STRING_FIELDS = [
  'expected_position',
  'expected_location',
  'expected_salary_range',
  'outsourcing_acceptance_level',
  'expected_industry',
  'expected_company_size',
] as const;

/**
 * Trim and whitelist a RAAS candidate expectation payload.
 *
 * Empty strings and unknown keys are ignored so a partial upload payload never
 * clears fields that a recruiter previously maintained. `constraints: []` is
 * retained when explicitly supplied because an empty list is meaningful.
 */
export function normalizeCandidateExpectationPayload(
  raw: unknown,
): CandidateExpectationPatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const source = raw as Record<string, unknown>;
  const out: CandidateExpectationPatch = {};

  for (const field of STRING_FIELDS) {
    const value = source[field];
    if (typeof value === 'string' && value.trim()) {
      out[field] = value.trim();
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, 'constraints') && Array.isArray(source.constraints)) {
    out.constraints = source.constraints
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return Object.keys(out).length > 0 ? out : null;
}
