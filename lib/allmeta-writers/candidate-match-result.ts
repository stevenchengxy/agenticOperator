// Write Candidate_Match_Result instance to Neo4j via allmeta ontology API.
//
// Canonical schema (neo4j_data/objects_v0_1_015.json):
//   candidate_match_result_id (pk),
//   client_id, candidate_id, job_position_id (FK→Job_Requisition),
//   overall_match_score (Float), overall_fit_verdict, overall_fit_summary,
//   overall_match_grade,
//   rule_check_result, rule_check_reason
//
// 2 个调用点:
//   1. ruleCheckAgent — 阶段一,只写 rule_check_result/reason
//      (overall_* 留空,等 RoboHire match 完再补)
//   2. matchResumeAgent — 阶段二,补 overall_* 字段
//      (PK 复用 ruleCheckAgent 已建的 row;allmeta upsert by PK)

import {
  safeWriteInstance,
  compact,
  nonEmptyString,
  asNumberOrNull,
  type WriteResult,
} from './_helpers';

export type WriteCMRInput = {
  candidate_match_result_id: string;
  client_id?: string | null;
  candidate_id: string;
  /** Per canonical: 引用 Job_Requisition (字段名是 job_position_id). */
  job_requisition_id: string;
  // ── 阶段一 (rule-check) 字段 ──
  rule_check_result?: '通过' | '未通过';
  rule_check_reason?: string;
  // ── 阶段二 (matchResume) 字段 ──
  overall_match_score?: number | null;
  overall_fit_verdict?: string | null;
  overall_fit_summary?: string | null;
  overall_match_grade?: string | null;
};

export async function writeCandidateMatchResultInstance(
  input: WriteCMRInput,
): Promise<WriteResult> {
  const payload = compact({
    candidate_match_result_id: input.candidate_match_result_id,
    client_id: nonEmptyString(input.client_id),
    candidate_id: input.candidate_id,
    job_position_id: input.job_requisition_id, // canonical 字段名是 job_position_id
    rule_check_result: input.rule_check_result,
    // Stage 2 (matchResume) updates the same node without rule-check fields.
    // Omitting the key preserves the optional-rule reference written by stage
    // 1; an explicitly provided empty string still maps to null and clears a
    // stale reason on a later PASS re-check.
    ...(input.rule_check_reason !== undefined
      ? { rule_check_reason: nonEmptyString(input.rule_check_reason) }
      : {}),
    overall_match_score: asNumberOrNull(input.overall_match_score),
    overall_fit_verdict: nonEmptyString(input.overall_fit_verdict),
    overall_fit_summary: nonEmptyString(input.overall_fit_summary),
    overall_match_grade: nonEmptyString(input.overall_match_grade),
  });

  return safeWriteInstance('Candidate_Match_Result', payload);
}
