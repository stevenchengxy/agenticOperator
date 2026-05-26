// lib/partner-pg/rule-check-result.ts
//
// Lean writer for a rule-check FAIL → partner-pg `candidate_match_result`.
//
// Why separate from saveMatchResultsToPartnerPg (2026-05-26):
//   The generic match writer is built for *match* results — it always writes
//   candidate_match_result_runtime_state, gates the main-table row behind
//   `if (resolvedJobPostingId)`, and skips writes that are "sparser than
//   existing". A rule-check FAIL has none of that machinery: no score, no
//   skill breakdown. We just need the canonical Candidate_Match_Result row to
//   record `match_status='未通过'` + the reason, UNCONDITIONALLY (so a FAIL on
//   a JR without a job_posting still lands — path A / reassign).
//
// partner-pg `candidate_match_result` has NO rule_check_result/reason columns
// (those live only on Allmeta/Neo4j); we map the rule-check outcome onto the
// existing match_status / match_reason columns. job_posting_id is resolved
// best-effort (links the row into the MatchPool when a posting exists) but the
// row is written either way.

import { withTx } from './client';

export type SaveRuleCheckFailItem = {
  candidate_match_result_id: string;
  candidate_id: string;
  job_requisition_id: string;
  client_id?: string | null;
  /** Joined failure reasons, e.g. "[10-42] CDG冷冻期: 命中冷冻期". */
  match_reason: string;
  created_by?: string | null;
};

export type SaveRuleCheckFailResult = {
  candidate_match_result_id: string;
  /** True when a brand-new row was inserted (vs updating an existing one). */
  created: boolean;
  job_posting_id: string | null;
};

const FAIL_STATUS = '未通过';

export async function saveRuleCheckFailToPartnerPg(
  item: SaveRuleCheckFailItem,
): Promise<SaveRuleCheckFailResult> {
  if (!item.candidate_match_result_id) {
    throw new Error('[partner-pg/rule-check-result] missing candidate_match_result_id');
  }
  if (!item.candidate_id) {
    throw new Error('[partner-pg/rule-check-result] missing candidate_id');
  }
  if (!item.job_requisition_id) {
    throw new Error('[partner-pg/rule-check-result] missing job_requisition_id');
  }

  const cmrId = item.candidate_match_result_id;
  const createdBy = item.created_by ?? 'ai_engine.ruleCheck';

  return withTx<SaveRuleCheckFailResult>(async (c) => {
    // Best-effort posting resolution — links the row into the MatchPool when a
    // posting exists, but we do NOT gate the write on it.
    const posting = await c.query<{ job_posting_id: string }>(
      `SELECT job_posting_id FROM job_posting
        WHERE job_requisition_id = $1
        ORDER BY published_at DESC NULLS LAST, created_at DESC
        LIMIT 1`,
      [item.job_requisition_id],
    );
    const jobPostingId: string | null = posting.rows[0]?.job_posting_id ?? null;

    const existing = await c.query<{ candidate_match_result_id: string }>(
      `SELECT candidate_match_result_id FROM candidate_match_result
        WHERE candidate_match_result_id = $1
        LIMIT 1`,
      [cmrId],
    );

    if (existing.rows[0]) {
      await c.query(
        `UPDATE candidate_match_result SET
            match_score   = NULL,
            match_reason  = $2,
            match_status  = $3,
            job_posting_id = COALESCE($4, job_posting_id),
            updated_at    = NOW()
         WHERE candidate_match_result_id = $1`,
        [cmrId, item.match_reason, FAIL_STATUS, jobPostingId],
      );
      return { candidate_match_result_id: cmrId, created: false, job_posting_id: jobPostingId };
    }

    await c.query(
      `INSERT INTO candidate_match_result (
          candidate_match_result_id, candidate_id, job_requisition_id,
          job_posting_id, match_score, match_reason, match_status,
          stage, created_by, created_at, updated_at
        ) VALUES (
          $1, $2, $3,
          $4, NULL, $5, $6,
          $7, $8, NOW(), NOW()
        )`,
      [
        cmrId,
        item.candidate_id,
        item.job_requisition_id,
        jobPostingId,
        item.match_reason,
        FAIL_STATUS,
        'rule_check',
        createdBy,
      ],
    );
    return { candidate_match_result_id: cmrId, created: true, job_posting_id: jobPostingId };
  });
}
