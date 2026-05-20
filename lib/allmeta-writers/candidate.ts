// Write Candidate instance to Neo4j via allmeta ontology API.
//
// Canonical schema (neo4j_data/objects_v0_1_015.json). Allmeta 严格校验:
// 多/错字段 → 整条 reject。所以严格 only canonical 字段:
//   candidate_id, employee_id, is_locked, lock_start_time, referrer_employee_id,
//   id_number, name, nationality, gender, birth_date, phone, email, address,
//   highest_acquired_degree, unified_enrollment, work_years (Float),
//   flight_risk_level, max_salary_limit, status, state, blacklist_status,
//   marital_status, conflict_of_interest_declaration, conflict_clearance_deadline,
//   gap_reason, previous_level, expected_degree, expected_graduation_date,
//   github, ethnicity, native_place

import {
  safeWriteInstance,
  compact,
  nonEmptyString,
  asNumberOrNull,
  asIsoDateOrNull,
  type WriteResult,
} from './_helpers';

export type WriteCandidateInput = {
  candidate_id: string;
  employee_id?: string | null;
  /** RoboHire parse-resume `data` object (or partner pre-parsed JSON). */
  parsed: Record<string, unknown>;
};

export async function writeCandidateInstance(
  input: WriteCandidateInput,
): Promise<WriteResult> {
  const p = input.parsed;
  const phone =
    nonEmptyString(p.phone) ??
    nonEmptyString(p.mobile) ??
    nonEmptyString((p as Record<string, unknown>).phoneNumber);
  const address =
    nonEmptyString(p.address) ??
    nonEmptyString(p.currentLocation) ??
    nonEmptyString(p.location);
  const workYears = asNumberOrNull(p.workYears ?? p.experienceYears ?? p.work_years);
  const payload = compact({
    candidate_id: input.candidate_id,
    employee_id: nonEmptyString(input.employee_id),
    name: nonEmptyString(p.name) ?? '未命名候选人',
    phone,
    email: nonEmptyString(p.email),
    gender: nonEmptyString(p.gender),
    birth_date: asIsoDateOrNull(p.birthDate ?? p.birth_date),
    address,
    highest_acquired_degree:
      nonEmptyString(p.highestDegree) ??
      nonEmptyString(
        p.education &&
          Array.isArray(p.education) &&
          (p.education[0] as Record<string, unknown>)?.degree,
      ),
    work_years: workYears,
  });

  return safeWriteInstance('Candidate', payload);
}
