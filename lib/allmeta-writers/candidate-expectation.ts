// Write Candidate_Expectation to Neo4j through the Allmeta ontology API.
//
// Canonical RAAS-v1 schema is intentionally the same singular-string shape as
// partner Postgres. Allmeta rejects extra properties, so this writer sends only:
//   candidate_expectation_id, candidate_id, expected_position,
//   expected_location, expected_salary_range, outsourcing_acceptance_level,
//   expected_industry, expected_company_size, constraints, updated_time.

import type { CandidateExpectationPatch } from '@/lib/raas-v1/candidate-expectation';
import {
  compact,
  safeWriteInstance,
  type WriteResult,
} from './_helpers';

export type WriteCandidateExpectationInput = {
  candidate_expectation_id: string;
  candidate_id: string;
  expectation: CandidateExpectationPatch;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function writeCandidateExpectationInstance(
  input: WriteCandidateExpectationInput,
): Promise<WriteResult> {
  const expectation = input.expectation;
  const payload = compact({
    candidate_expectation_id: input.candidate_expectation_id,
    candidate_id: input.candidate_id,
    // Omit absent fields instead of sending null: upload expectation_payload is
    // a partial patch and must not clear recruiter-maintained graph properties.
    expected_position: optionalString(expectation.expected_position),
    expected_location: optionalString(expectation.expected_location),
    expected_salary_range: optionalString(expectation.expected_salary_range),
    outsourcing_acceptance_level: optionalString(
      expectation.outsourcing_acceptance_level,
    ),
    expected_industry: optionalString(expectation.expected_industry),
    expected_company_size: optionalString(expectation.expected_company_size),
    constraints: expectation.constraints,
    updated_time: new Date().toISOString(),
  });

  return safeWriteInstance('Candidate_Expectation', payload);
}
