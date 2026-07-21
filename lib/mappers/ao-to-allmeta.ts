// @ts-nocheck — v0_1_010 schema migration WIP: CandidateNested in
// server/inngest/client.ts still uses the old 11-field shape; this mapper
// expects the new 31-field shape per docs/data/objects_v0_1_010.json.
// Disable type check until the type definition catches up.
// v0_1_010 终稿 — AO Nested → Allmeta DataObject payload mapper
//
// 对齐 docs/data/objects_v0_1_010.json:
//   - Candidate (31 fields)
//   - Candidate_Expectation (11 fields)
//   - Resume (24 fields)
//   - Candidate_Match_Result (8 fields)
//   - Job_Requisition (39 fields, 不动)

import type {
  CandidateNested,
  CandidateExpectationNested,
  ResumeNested,
} from '@/server/inngest/client';
import type { RaasRequirement, RaasMatchResumeData } from '@/lib/raas-api-client';

// ──────────────────────────────────────────────────────────────
//  Candidate
// ──────────────────────────────────────────────────────────────

export function toAllmetaCandidate(
  c: CandidateNested,
  candidate_id: string,
  opts: { employee_id?: string | null } = {},
): Record<string, unknown> {
  return {
    candidate_id,
    employee_id: opts.employee_id ?? null,
    name: c.name,
    phone: c.mobile,
    email: c.email,
    gender: c.gender,
    birth_date: c.birth_date,
    address: c.address,
    highest_acquired_degree: c.highest_acquired_degree,
    work_years: c.work_years,
    github: c.github,
    ethnicity: c.ethnicity,
    native_place: c.native_place,
    // 以下字段 AO 不写,留 hsm 端填:
    //   is_locked / lock_start_time / referrer_employee_id / id_number / nationality
    //   unified_enrollment / flight_risk_level / max_salary_limit / status / state
    //   blacklist_status / marital_status / conflict_of_interest_declaration
    //   conflict_clearance_deadline / gap_reason / previous_level
    //   expected_degree / expected_graduation_date
  };
}

// ──────────────────────────────────────────────────────────────
//  Candidate_Expectation
// ──────────────────────────────────────────────────────────────

export function toAllmetaCandidateExpectation(
  e: CandidateExpectationNested,
  candidate_id: string,
): Record<string, unknown> {
  return {
    candidate_expectation_id: `ce_${candidate_id}`,
    candidate_id,
    expected_positions: e.expected_positions,
    expected_locations: e.expected_locations,
    expected_salary_range: e.expected_salary_range,
    expected_industries: e.expected_industries,
    expected_work_mode: e.expected_work_mode,
    updated_time: new Date().toISOString(),
    // 以下字段 AO 不写:
    //   outsourcing_acceptance_level(hsm 填)/ expected_company_size / constraints
  };
}

// ──────────────────────────────────────────────────────────────
//  Resume
// ──────────────────────────────────────────────────────────────

// Allmeta Resume DataObject declares `skills: List<String>`. RoboHire's
// /parse-resume returns skills as a CATEGORISED OBJECT
// (`{frameworks, languages, technical, soft, tools, other}`), so the TS type
// `ResumeNested.skills: string[]` is a lie at runtime when fed from RoboHire.
// Flatten any incoming shape to a deduped string[] so Allmeta's Neo4j writer
// doesn't choke trying to store a Map as a List property.
function flattenSkillsToStringList(s: unknown): string[] {
  if (!s) return [];
  const acc: string[] = [];
  const seen = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        acc.push(trimmed);
      }
    }
  };
  if (Array.isArray(s)) {
    for (const item of s) push(item);
    return acc;
  }
  if (typeof s === 'object') {
    for (const v of Object.values(s as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        for (const item of v) push(item);
      } else {
        push(v);
      }
    }
    return acc;
  }
  return [];
}

export function toAllmetaResume(
  r: ResumeNested,
  args: {
    resume_id: string;
    candidate_id: string;
    job_requisition_id?: string | null;
    file_path?: string;
    employee_id?: string | null;
  },
): Record<string, unknown> {
  return {
    resume_id: args.resume_id,
    candidate_id: args.candidate_id,
    // job_requisition_id 是 List<String>(★ 一份简历可投多个岗位),传入单个时也包成数组
    job_requisition_id: args.job_requisition_id ? [args.job_requisition_id] : [],
    sourcing_channel_id: null,
    experience: r.experience,
    projects: r.projects,
    education: r.education,
    languages: r.languages,
    file_path: args.file_path ?? null,
    is_original: true,
    // Schema = List<String>. Flatten RoboHire's categorized object.
    skills: flattenSkillsToStringList(r.skills),
    certifications: r.certifications,
    portfolio: r.portfolio,
    publications: r.publications,
    patents: r.patents,
    awards: r.awards,
    summary: r.summary,
    language: null,
    employee_id: args.employee_id ?? null,
    created_time: new Date().toISOString(),
    updated_time: new Date().toISOString(),
    // AO 不写:highlight_keywords / recommendation_reason / project_description_validity
  };
}

// ──────────────────────────────────────────────────────────────
//  Job_Requisition — RAAS 64 字段投影到 Allmeta 39 字段(完全不改名)
// ──────────────────────────────────────────────────────────────

export function toAllmetaJobRequisition(raas: RaasRequirement): Record<string, unknown> {
  return {
    job_requisition_id: raas.job_requisition_id,
    job_requisition_specification_id: raas.job_requisition_specification_id ?? null,
    csi_department_id: (raas as Record<string, unknown>).csi_department_id ?? null,
    client_department_id: raas.client_department_id ?? null,
    standard_job_role_id: (raas as Record<string, unknown>).standard_job_role_id ?? null,
    evaluation_model_id: (raas as Record<string, unknown>).evaluation_model_id ?? null,
    client_job_id: raas.client_job_id ?? null,
    client_job_temp_id: (raas as Record<string, unknown>).client_job_temp_id ?? null,
    client_job_title: raas.client_job_title ?? null,
    client_job_type: (raas as Record<string, unknown>).client_job_type ?? null,
    job_responsibility: raas.job_responsibility ?? null,
    job_requirement: raas.job_requirement ?? null,
    job_type: (raas as Record<string, unknown>).job_type ?? null,
    recruitment_type: raas.recruitment_type ?? null,
    work_years: raas.work_years ?? null,
    gender: (raas as Record<string, unknown>).gender ?? null,
    age_range: (raas as Record<string, unknown>).age_range ?? null,
    degree_requirement: raas.degree_requirement ?? null,
    education_requirement: raas.education_requirement ?? null,
    city: raas.city ?? null,
    work_address: (raas as Record<string, unknown>).work_address ?? [],
    salary_range: raas.salary_range ?? null,
    must_have_skills: raas.must_have_skills ?? [],
    nice_to_have_skills: raas.nice_to_have_skills ?? [],
    language_requirements: raas.language_requirements ?? null,
    negative_requirement: raas.negative_requirement ?? null,
    headcount: raas.headcount ?? null,
    hc_status: (raas as Record<string, unknown>).hc_status ?? null,
    fill_difficulty: (raas as Record<string, unknown>).fill_difficulty ?? null,
    urgency_level: (raas as Record<string, unknown>).urgency_level ?? null,
    open_date: (raas as Record<string, unknown>).open_date ?? null,
    required_arrival_date: (raas as Record<string, unknown>).required_arrival_date ?? null,
    work_schedule_type: (raas as Record<string, unknown>).work_schedule_type ?? null,
    require_foreigner: (raas as Record<string, unknown>).require_foreigner ?? null,
    clarify_questions: (raas as Record<string, unknown>).clarify_questions ?? [],
    recruitment_strategies: (raas as Record<string, unknown>).recruitment_strategies ?? null,
    interview_mode: raas.interview_mode ?? null,
    interview_process: (raas as Record<string, unknown>).interview_process ?? null,
    expected_level: raas.expected_level ?? null,
  };
}

// ──────────────────────────────────────────────────────────────
//  Candidate_Match_Result — 8 字段极简版
// ──────────────────────────────────────────────────────────────

export function toAllmetaMatchResult(
  matchData: RaasMatchResumeData,
  context: {
    candidate_match_result_id: string;
    candidate_id: string;
    client_id: string;
    job_requisition_id: string;
  },
): Record<string, unknown> {
  const overallMatchScore = (matchData as Record<string, unknown>).overallMatchScore as
    | Record<string, unknown>
    | undefined;
  const overallFit = (matchData as Record<string, unknown>).overallFit as
    | Record<string, unknown>
    | undefined;

  return {
    candidate_match_result_id: context.candidate_match_result_id,
    client_id: context.client_id,
    candidate_id: context.candidate_id,
    job_position_id: context.job_requisition_id, // ★ Allmeta 字段名是 job_position_id
    overall_match_score:
      typeof overallMatchScore?.score === 'number' ? (overallMatchScore.score as number) : 0,
    overall_fit_verdict: typeof overallFit?.verdict === 'string' ? (overallFit.verdict as string) : '',
    overall_fit_summary: typeof overallFit?.summary === 'string' ? (overallFit.summary as string) : '',
    overall_match_grade:
      typeof overallMatchScore?.grade === 'string' ? (overallMatchScore.grade as string) : '',
  };
}
