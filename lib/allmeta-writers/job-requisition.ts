// Write Job_Requisition instance to Neo4j via allmeta ontology API.
//
// Canonical schema (neo4j_data/objects_v0_1_015.json):
//   job_requisition_id, job_requisition_specification_id, csi_department_id,
//   client_department_id, standard_job_role_id, evaluation_model_id,
//   client_job_id, client_job_temp_id, client_job_title, client_job_type,
//   job_responsibility, job_requirement, job_type, recruitment_type,
//   work_years (Integer), gender, age_range, degree_requirement,
//   education_requirement, city, work_address (List<String>), salary_range,
//   must_have_skills (List<String>), nice_to_have_skills (List<String>),
//   language_requirements, negative_requirement, headcount (Integer),
//   hc_status, fill_difficulty, urgency_level, open_date (Date),
//   required_arrival_date (Date), work_schedule_type, require_foreigner (Boolean),
//   clarify_questions (List<String>), recruitment_strategies, interview_mode,
//   interview_process, expected_level
//
// JR 数据由 partner 创建,AO 在 createJdAgent / ruleCheckAgent 读到 partner Postgres
// 的 JR 后顺手镜像到 Neo4j(upsert idempotent)。这样 Rule Check Audit 的
// "实时读 Neo4j" anchor :Job_Requisition 才能查到。

import {
  safeWriteInstance,
  compact,
  nonEmptyString,
  asStringArray,
  asNumberOrNull,
  asIsoDateOrNull,
  type WriteResult,
} from './_helpers';

/** Partner Postgres requirement row(or JOIN'd RequirementDetail). 字段对齐 canonical. */
export type WriteJobRequisitionInput = {
  /** Partner-pg row(loose typed,fields read by name). */
  requirement: Record<string, unknown>;
};

function asInteger(v: unknown): number | null {
  const n = asNumberOrNull(v);
  if (n === null) return null;
  return Math.round(n);
}

function asBooleanOrNull(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return null;
}

/** Partner Postgres work_address 可能是 string / array / { city,district,address } object. */
function flattenWorkAddress(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return asStringArray(v);
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const parts = [o.city, o.district, o.address]
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    return parts.length > 0 ? [parts.join(' ')] : [];
  }
  return [];
}

export async function writeJobRequisitionInstance(
  input: WriteJobRequisitionInput,
): Promise<WriteResult> {
  const r = input.requirement;
  const payload = compact({
    job_requisition_id: nonEmptyString(r.job_requisition_id),
    job_requisition_specification_id: nonEmptyString(r.job_requisition_specification_id),
    csi_department_id: nonEmptyString(r.csi_department_id),
    client_department_id: nonEmptyString(r.client_department_id),
    standard_job_role_id: nonEmptyString(r.standard_job_role_id),
    evaluation_model_id: nonEmptyString(r.evaluation_model_id),
    client_job_id: nonEmptyString(r.client_job_id),
    client_job_temp_id: nonEmptyString(r.client_job_temp_id),
    client_job_title: nonEmptyString(r.client_job_title),
    client_job_type: nonEmptyString(r.client_job_type),
    job_responsibility: nonEmptyString(r.job_responsibility),
    job_requirement: nonEmptyString(r.job_requirement),
    job_type: nonEmptyString(r.job_type),
    recruitment_type: nonEmptyString(r.recruitment_type),
    work_years: asInteger(r.work_years),
    gender: nonEmptyString(r.gender),
    age_range: nonEmptyString(r.age_range),
    degree_requirement: nonEmptyString(r.degree_requirement),
    education_requirement: nonEmptyString(r.education_requirement),
    city: nonEmptyString(r.city),
    work_address: flattenWorkAddress(r.work_address),
    salary_range: nonEmptyString(r.salary_range),
    must_have_skills: asStringArray(r.must_have_skills),
    nice_to_have_skills: asStringArray(r.nice_to_have_skills),
    language_requirements: nonEmptyString(r.language_requirements),
    negative_requirement: nonEmptyString(r.negative_requirement),
    headcount: asInteger(r.headcount),
    hc_status: nonEmptyString(r.hc_status),
    fill_difficulty: nonEmptyString(r.fill_difficulty),
    urgency_level: nonEmptyString(r.urgency_level),
    open_date: asIsoDateOrNull(r.open_date),
    required_arrival_date: asIsoDateOrNull(r.required_arrival_date),
    work_schedule_type: nonEmptyString(r.work_schedule_type),
    require_foreigner: asBooleanOrNull(r.require_foreigner),
    clarify_questions: asStringArray(r.clarify_questions),
    recruitment_strategies: nonEmptyString(r.recruitment_strategies),
    interview_mode: nonEmptyString(r.interview_mode),
    interview_process: nonEmptyString(r.interview_process),
    expected_level: nonEmptyString(r.expected_level),
  });

  if (!payload.job_requisition_id) {
    return { ok: false, error: 'missing job_requisition_id' };
  }

  return safeWriteInstance('Job_Requisition', payload);
}
