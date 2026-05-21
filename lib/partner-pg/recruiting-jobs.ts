// lib/partner-pg/recruiting-jobs.ts
//
// Partner contract — supersedes the old `getHsmJobPostingsAsRequirements`
// (which incorrectly read `spec.hsm_employee_id`). The truth source for
// "what postings is this employee currently working on" is the
// `requirement_claim` table; "招聘中" is `job_posting.publish_status` IN
// ('distributed', 'published').
//
// Spec authored by RAAS partner (2026-05-21) — see PR conversation. This
// file implements that spec verbatim:
//   - single SQL, no multi-step
//   - $1 parameter binding (NO string concatenation)
//   - JSONB columns left as parsed JS values (pg auto-parses)
//   - empty result returns [] (NOT an error)
//
// Long-term this will move to Ontology Service + event subscription; this
// direct-SQL path is the transition implementation.

import { query } from './client';

export type RecruitingJobRow = {
  posting: {
    job_posting_id: string;
    posting_title: string | null;
    publish_status: 'distributed' | 'published';
    posting_created_at: Date;
    posting_updated_at: Date;
  };
  claim: {
    recruiter_id: string;
    claimed_at: Date | null;
  };
  requisition: {
    job_requisition_id: string;
    job_requisition_specification_id: string | null;
    client_id: string | null;
    client_department_id: string | null;
    csi_department_id: string | null;
    client_job_id: string | null;
    client_job_title: string | null;
    client_job_type: string | null;
    job_responsibility: string | null;
    job_requirement: string | null;
    work_years: number | null;
    degree_requirement: string | null;
    education_requirement: string | null;
    gender: string | null;
    age_range: string | null;
    city: string | null;
    work_address: Record<string, unknown> | null;
    salary_range: string | null;
    must_have_skills: unknown[] | null;
    nice_to_have_skills: unknown[] | null;
    language_requirements: string | null;
    qualifications: string | null;
    hard_requirements: string | null;
    nice_to_have: string | null;
    interview_requirements: string | null;
    evaluation_rules: string | null;
    benefits: string | null;
    headcount: number | null;
    hc_status: string | null;
    fill_difficulty: string | null;
    urgency_level: string | null;
    open_date: Date | null;
    required_arrival_date: Date | null;
    interview_mode: string | null;
    interview_process: string | null;
    first_interviewer_name: string | null;
    final_interviewer_name: string | null;
    client_contact_name: string | null;
    demand_type: string | null;
    service_bg: string | null;
    client_published_at: Date | null;
    client_updated_at: Date | null;
    requisition_created_at: Date;
    requisition_updated_at: Date;
  };
};

const LIST_SQL = `
  SELECT
    jp.job_posting_id,
    jp.posting_title,
    jp.publish_status,
    jp.created_at        AS posting_created_at,
    jp.updated_at        AS posting_updated_at,

    rc.recruiter_id,
    rc.claimed_at,

    jr.job_requisition_id,
    jr.job_requisition_specification_id,
    jr.client_id,
    jr.client_department_id,
    jr.csi_department_id,
    jr.client_job_id,
    jr.client_job_title,
    jr.client_job_type,
    jr.job_responsibility,
    jr.job_requirement,
    jr.work_years,
    jr.degree_requirement,
    jr.education_requirement,
    jr.gender,
    jr.age_range,
    jr.city,
    jr.work_address,
    jr.salary_range,
    jr.must_have_skills,
    jr.nice_to_have_skills,
    jr.language_requirements,
    jr.qualifications,
    jr.hard_requirements,
    jr.nice_to_have,
    jr.interview_requirements,
    jr.evaluation_rules,
    jr.benefits,
    jr.headcount,
    jr.hc_status,
    jr.fill_difficulty,
    jr.urgency_level,
    jr.open_date,
    jr.required_arrival_date,
    jr.interview_mode,
    jr.interview_process,
    jr.first_interviewer_name,
    jr.final_interviewer_name,
    jr.client_contact_name,
    jr.demand_type,
    jr.service_bg,
    jr.client_published_at,
    jr.client_updated_at,
    jr.created_at        AS requisition_created_at,
    jr.updated_at        AS requisition_updated_at
  FROM job_posting       jp
  JOIN requirement_claim rc ON rc.job_requisition_id = jp.job_requisition_id
  JOIN job_requisition   jr ON jr.job_requisition_id = jp.job_requisition_id
  WHERE rc.recruiter_id    = $1
    AND rc.released_at     IS NULL
    AND jp.publish_status IN ('distributed','published')
  ORDER BY jp.updated_at DESC
`;

/**
 * Return every active recruiter claim for this employee that maps to a
 * currently-publishing job_posting, with the originating job_requisition
 * fully hydrated.
 *
 * Empty array (NOT an error) when:
 *   - the employee has no active claims, or
 *   - every claimed JR's posting is draft / pending / closed.
 *
 * One JR may appear multiple times if more than one recruiter has claimed
 * it (peer collaboration); the partner spec is explicit that this is
 * expected. Callers that need a per-JR view should dedupe by
 * `requisition.job_requisition_id`.
 */
export async function listRecruitingJobsForEmployee(
  employeeId: string,
): Promise<RecruitingJobRow[]> {
  const id = employeeId?.trim();
  if (!id) return [];
  const { rows } = await query(LIST_SQL, [id]);
  return rows.map(
    (r): RecruitingJobRow => ({
      posting: {
        job_posting_id: r.job_posting_id,
        posting_title: r.posting_title,
        publish_status: r.publish_status,
        posting_created_at: r.posting_created_at,
        posting_updated_at: r.posting_updated_at,
      },
      claim: {
        recruiter_id: r.recruiter_id,
        claimed_at: r.claimed_at,
      },
      requisition: {
        job_requisition_id: r.job_requisition_id,
        job_requisition_specification_id: r.job_requisition_specification_id,
        client_id: r.client_id,
        client_department_id: r.client_department_id,
        csi_department_id: r.csi_department_id,
        client_job_id: r.client_job_id,
        client_job_title: r.client_job_title,
        client_job_type: r.client_job_type,
        job_responsibility: r.job_responsibility,
        job_requirement: r.job_requirement,
        work_years: r.work_years,
        degree_requirement: r.degree_requirement,
        education_requirement: r.education_requirement,
        gender: r.gender,
        age_range: r.age_range,
        city: r.city,
        work_address: r.work_address,
        salary_range: r.salary_range,
        must_have_skills: r.must_have_skills,
        nice_to_have_skills: r.nice_to_have_skills,
        language_requirements: r.language_requirements,
        qualifications: r.qualifications,
        hard_requirements: r.hard_requirements,
        nice_to_have: r.nice_to_have,
        interview_requirements: r.interview_requirements,
        evaluation_rules: r.evaluation_rules,
        benefits: r.benefits,
        headcount: r.headcount,
        hc_status: r.hc_status,
        fill_difficulty: r.fill_difficulty,
        urgency_level: r.urgency_level,
        open_date: r.open_date,
        required_arrival_date: r.required_arrival_date,
        interview_mode: r.interview_mode,
        interview_process: r.interview_process,
        first_interviewer_name: r.first_interviewer_name,
        final_interviewer_name: r.final_interviewer_name,
        client_contact_name: r.client_contact_name,
        demand_type: r.demand_type,
        service_bg: r.service_bg,
        client_published_at: r.client_published_at,
        client_updated_at: r.client_updated_at,
        requisition_created_at: r.requisition_created_at,
        requisition_updated_at: r.requisition_updated_at,
      },
    }),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Adapter — keep the AgentViewResult shape that rule-check-agent already
// consumes, so the agent's downstream helpers (hasMatchableContent,
// pickRequisitionId, isRecruitingStatus, …) keep working unmodified.
// ──────────────────────────────────────────────────────────────────────

import type { AgentViewItem, AgentViewOptions, AgentViewResult } from './agent-view';
import { parseJobTitleFromFilename, jobTitleSimilarity } from './agent-view';

const FILTER_MIN_SCORE = 0.45;

/**
 * Drop-in replacement for `getHsmJobPostingsAsRequirements`. Wraps
 * `listRecruitingJobsForEmployee` and returns a flat AgentViewItem[]
 * shape (same fields rule-check-agent.ts has always read).
 *
 * Optional `resumeFilename` does best-effort fuzzy match against
 * `client_job_title` (zero-regression with the prior helper). When
 * nothing crosses FILTER_MIN_SCORE the unfiltered list is returned —
 * a hard filter would hide all postings on a noisy filename and
 * silently drop rule-check coverage.
 */
export async function getRecruitingJobsAsRequirements(
  opts: AgentViewOptions,
): Promise<AgentViewResult> {
  const employeeId = opts.claimerEmployeeId?.trim();
  if (!employeeId) {
    throw new Error('[partner-pg] claimerEmployeeId (= recruiter employee_id) is required');
  }

  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));

  const rows = await listRecruitingJobsForEmployee(employeeId);

  // Flatten to AgentViewItem shape (one row per posting; if the same JR
  // is claimed by multiple recruiters this employee is only ever one of
  // them, so dedup on job_requisition_id within this employee's slice).
  const seen = new Set<string>();
  const flat: AgentViewItem[] = [];
  for (const r of rows) {
    const jrid = r.requisition.job_requisition_id;
    if (seen.has(jrid)) continue;
    seen.add(jrid);
    flat.push({
      job_requisition_id: jrid,
      client_id: r.requisition.client_id,
      client_job_title: r.requisition.client_job_title,
      client_job_type: r.requisition.client_job_type,
      // Posting layer carried alongside JR so downstream can decide.
      job_posting_id: r.posting.job_posting_id,
      // Bring along enough of the JR to flatten into the rule-check input —
      // this mirrors the previous helper's projection.
      client_department_id: r.requisition.client_department_id,
      csi_department_id: r.requisition.csi_department_id,
      client_job_id: r.requisition.client_job_id,
      job_responsibility: r.requisition.job_responsibility,
      job_requirement: r.requisition.job_requirement,
      work_years: r.requisition.work_years,
      degree_requirement: r.requisition.degree_requirement,
      education_requirement: r.requisition.education_requirement,
      gender: r.requisition.gender,
      age_range: r.requisition.age_range,
      city: r.requisition.city,
      work_address: r.requisition.work_address,
      salary_range: r.requisition.salary_range,
      must_have_skills: r.requisition.must_have_skills,
      nice_to_have_skills: r.requisition.nice_to_have_skills,
      language_requirements: r.requisition.language_requirements,
      qualifications: r.requisition.qualifications,
      hard_requirements: r.requisition.hard_requirements,
      nice_to_have: r.requisition.nice_to_have,
      interview_requirements: r.requisition.interview_requirements,
      evaluation_rules: r.requisition.evaluation_rules,
      benefits: r.requisition.benefits,
      headcount: r.requisition.headcount,
      hc_status: r.requisition.hc_status,
      fill_difficulty: r.requisition.fill_difficulty,
      urgency_level: r.requisition.urgency_level,
      open_date: r.requisition.open_date,
      required_arrival_date: r.requisition.required_arrival_date,
      interview_mode: r.requisition.interview_mode,
      interview_process: r.requisition.interview_process,
      first_interviewer_name: r.requisition.first_interviewer_name,
      final_interviewer_name: r.requisition.final_interviewer_name,
      client_contact_name: r.requisition.client_contact_name,
      demand_type: r.requisition.demand_type,
      service_bg: r.requisition.service_bg,
      client_published_at: r.requisition.client_published_at,
      client_updated_at: r.requisition.client_updated_at,
      // Force AgentViewItem index signature
    } as unknown as AgentViewItem);
  }

  // Optional fuzzy match by resume filename (preserve F2 narrowing).
  const filename = (opts.resumeFilename ?? '').trim();
  let items = flat;
  if (filename.length > 0) {
    const parsedTitle = parseJobTitleFromFilename(filename);
    if (parsedTitle) {
      const scored = flat
        .map((it) => ({
          it,
          score: jobTitleSimilarity(parsedTitle, (it.client_job_title as string | null) ?? ''),
        }))
        .filter((s) => s.score >= FILTER_MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .map((s) => s.it);
      if (scored.length > 0) items = scored;
      // else: keep unfiltered — never silently drop coverage.
    }
  }

  const total = items.length;
  const start = (page - 1) * pageSize;
  const paged = items.slice(start, start + pageSize);
  return {
    items: paged,
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
