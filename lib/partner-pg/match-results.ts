// lib/partner-pg/match-results.ts
//
// Direct SQL replacement for RAAS API POST /api/v1/match-results, ported
// from raas_v4's `ingestSingleMatch` so we land the same rows RAAS already
// knows how to display. Reference (DO NOT EDIT):
//   raas_v4/backend/apps/api/src/modules/matching/match-result-ingest.service.ts
//   raas_v4/backend/prisma/schema.prisma  (CandidateMatchResult + RuntimeState)
//
// Why this rewrite (2026-05-21): the previous version read scores from flat
// top-level keys (`item.matching_score`, `item.skills_score`, …) which never
// existed in RoboHire's real response — real scores nest under
// `data.overallMatchScore.score` and `data.mustHaveAnalysis.candidateEvaluation`.
// Every row landed with NULL columns and RAAS's match-pool list hid them.
// We now mirror raas_v4: normalize the RoboHire envelope first, then write.
//
// Two writes per call (matching raas_v4 layering):
//   1. UPSERT candidate_match_result_runtime_state — score breakdown + skill
//      analysis + AI summary. Dedupes by (candidate_id, job_requisition_id).
//      `client_id` / `job_posting_id` columns are NOT NULL in the schema;
//      missing values fall back to "" (empty string) per raas_v4 convention.
//   2. UPSERT candidate_match_result                — the canonical row keyed
//      by `candidate_match_result_id`. Only written when a JobPosting was
//      resolved for the requisition (otherwise the MatchPool /jd/[id]
//      surface has nowhere to link the row and skipping is preferable to
//      leaving an orphan).
//
// Both writes share a transaction so partial state can't leak.

import { randomUUID } from 'node:crypto';
import { withTx } from './client';
import {
  buildCoreTags,
  buildDimensionScores,
  extractNormalizedFields,
  resolveMatchPayload,
  richnessScore,
} from './_robohire-normalize';

// ──────────────────────────────────────────────────────────────────────
// Public input
//
// Agent caller should pass identity + the RoboHire envelope verbatim.
// Older callers that supplied flat fields (`matching_score`, `core_tags`,
// `final_recommendation`, …) still work — normalizer falls back to those
// when the RoboHire-shape detection misses.
// ──────────────────────────────────────────────────────────────────────

export type SaveMatchResultItem = {
  // identity (required)
  candidate_id: string;
  job_requisition_id: string;
  // identity (optional — resolved from DB if absent)
  job_posting_id?: string | null;
  client_id?: string | null;

  /** "need_interview" | "no_interview" | "failed" — drives final_recommendation default. */
  source: 'need_interview' | 'no_interview' | 'failed' | string;

  /** Reuse an existing candidate_match_result_id if caller already knows one (idempotent retry). */
  candidate_match_result_id?: string | null;

  /**
   * The RoboHire `/match-resume` response envelope, passed verbatim. This is
   * the SHAPE we normalize against — see _robohire-normalize.ts. Callers
   * that already pre-flattened can also drop flat fields at the top level
   * (`matching_score`, `core_tags`, `ai_summary`, …) and they'll be picked
   * up via the legacy fallback inside the normalizer.
   */
  raw_llm_response?: unknown;

  // bookkeeping
  created_by?: string | null;

  // Legacy flat overrides — accepted for back-compat but not required.
  matching_score?: number | null;
  dimension_scores?: Record<string, number> | null;
  matched_skills?: unknown;
  missing_skills?: unknown;
  must_have_analysis?: unknown;
  nice_to_have_analysis?: unknown;
  advantages?: unknown;
  disadvantages?: unknown;
  core_tags?: string[] | null;
  education_score?: number | null;
  skills_score?: number | null;
  project_experience_score?: number | null;
  stability_score?: number | null;
  experience_score?: number | null;
  experience_assessment?: string | null;
  total_weighted_score?: number | null;
  experience_years?: number | null;
  star_rating?: number | null;
  qualification_retained?: boolean | null;
  ai_summary?: string | null;
  final_recommendation?: string | null;
  match_reason?: string | null;
  match_status?: string | null;

  [key: string]: unknown;
};

export type SaveMatchResultsResult = {
  candidate_match_result_id: string;
  candidate_id: string;
  job_requisition_id: string;
  /** True when a brand-new candidate_match_result_id was minted. */
  created: boolean;
  /** True when the upsert was skipped because incoming data was sparser than existing. */
  skipped?: boolean;
  /** Skip reason — currently only "sparser_than_existing". */
  reason?: string;
  /** The JobPosting we linked the main-table row to (null if main table was skipped). */
  job_posting_id: string | null;
};

// ──────────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────────

export async function saveMatchResultsToPartnerPg(
  item: SaveMatchResultItem,
): Promise<SaveMatchResultsResult> {
  if (!item.candidate_id) {
    throw new Error('[partner-pg/match-results] missing candidate_id');
  }
  if (!item.job_requisition_id) {
    throw new Error('[partner-pg/match-results] missing job_requisition_id');
  }

  // The envelope we normalize against. Most callers pass the RoboHire
  // response under `raw_llm_response`; for legacy callers that pre-spread
  // we still try `item` itself so flat fields are reachable.
  const envelope =
    (item.raw_llm_response && typeof item.raw_llm_response === 'object'
      ? (item.raw_llm_response as Record<string, unknown>)
      : (item as unknown as Record<string, unknown>)) ?? {};
  const resolved = resolveMatchPayload(envelope);
  const fields = extractNormalizedFields(envelope, resolved);

  // Caller-provided flat overrides win over the normalized envelope, so
  // existing pre-flattened pipelines (e.g. createJdAgent test fixtures)
  // don't suddenly start emitting NULLs.
  const matchingScore =
    typeof item.matching_score === 'number'
      ? item.matching_score
      : typeof item.total_weighted_score === 'number'
        ? item.total_weighted_score
        : fields.matchingScore;
  const skillsScore = item.skills_score ?? fields.skillsScore;
  const experienceScore = item.experience_score ?? fields.experienceScore;
  const experienceAssessment = item.experience_assessment ?? fields.experienceAssessment;
  const matchedSkills = (item.matched_skills as string[] | null | undefined) ?? fields.matchedSkills;
  const missingSkills = (item.missing_skills as string[] | null | undefined) ?? fields.missingSkills;
  const mustHaveAnalysis = item.must_have_analysis ?? fields.mustHaveAnalysis;
  const niceToHaveAnalysis = item.nice_to_have_analysis ?? fields.niceToHaveAnalysis;
  const advantages =
    (item.advantages as string[] | undefined) ?? fields.advantages ?? [];
  const disadvantages =
    (item.disadvantages as string[] | undefined) ?? fields.disadvantages ?? [];
  const aiSummary = item.ai_summary ?? fields.aiSummary;
  const finalRecommendation =
    item.final_recommendation ??
    fields.finalRecommendation ??
    (item.source === 'need_interview'
      ? 'need_interview'
      : item.source === 'no_interview'
        ? 'direct_recommend'
        : null);

  return withTx<SaveMatchResultsResult>(async (c) => {
    // ── Resolve job_posting_id if caller didn't pass one ──
    // RAAS's MatchPool surface keys by job_posting_id; without one, the
    // row is "homeless" and the /jd/[id]/match-pool list can't surface it.
    // Mirror raas_v4 `resolveJobPostingIdForRequisition` — pick the most
    // recent posting attached to this requisition.
    let resolvedJobPostingId: string | null = item.job_posting_id ?? null;
    if (!resolvedJobPostingId) {
      const r = await c.query<{ job_posting_id: string }>(
        `SELECT job_posting_id FROM job_posting
          WHERE job_requisition_id = $1
          ORDER BY published_at DESC NULLS LAST, created_at DESC
          LIMIT 1`,
        [item.job_requisition_id],
      );
      resolvedJobPostingId = r.rows[0]?.job_posting_id ?? null;
    }
    const clientId = item.client_id ?? '';

    // ── Step 1: dedup runtime_state row by (candidate, requisition) ──
    const existingRuntime = await c.query<{
      candidate_match_result_id: string;
      total_weighted_score: number | null;
      skills_score: number | null;
      experience_score: number | null;
      experience_assessment: string | null;
      matched_skills: unknown;
      missing_skills: unknown;
      must_have_analysis: unknown;
      nice_to_have_analysis: unknown;
      advantages: unknown;
      disadvantages: unknown;
      ai_summary: string | null;
      final_recommendation: string | null;
    }>(
      `SELECT candidate_match_result_id, total_weighted_score, skills_score,
              experience_score, experience_assessment,
              matched_skills, missing_skills,
              must_have_analysis, nice_to_have_analysis,
              advantages, disadvantages,
              ai_summary, final_recommendation
         FROM candidate_match_result_runtime_state
        WHERE candidate_id = $1 AND job_requisition_id = $2
        ORDER BY updated_at DESC
        LIMIT 1`,
      [item.candidate_id, item.job_requisition_id],
    );

    const existing = existingRuntime.rows[0] ?? null;

    // Anti-regression: if the incoming row is sparser than what's there,
    // skip the upsert entirely (matches raas_v4 ingestSingleMatch).
    const incoming = {
      total_weighted_score: matchingScore,
      skills_score: skillsScore,
      experience_score: experienceScore,
      experience_assessment: experienceAssessment,
      matched_skills: matchedSkills,
      missing_skills: missingSkills,
      must_have_analysis: mustHaveAnalysis,
      nice_to_have_analysis: niceToHaveAnalysis,
      advantages,
      disadvantages,
      ai_summary: aiSummary,
      final_recommendation: finalRecommendation,
    };
    if (existing) {
      const oldScore = richnessScore(existing);
      const newScore = richnessScore(incoming);
      if (oldScore > 0 && newScore < oldScore) {
        return {
          candidate_match_result_id: existing.candidate_match_result_id,
          candidate_id: item.candidate_id,
          job_requisition_id: item.job_requisition_id,
          created: false,
          skipped: true,
          reason: 'sparser_than_existing',
          job_posting_id: resolvedJobPostingId,
        };
      }
    }

    const cmrId =
      item.candidate_match_result_id ??
      existing?.candidate_match_result_id ??
      randomUUID();
    const created = !existing && !item.candidate_match_result_id;

    // ── Step 2: UPSERT runtime_state ──
    // client_id + job_posting_id are NOT NULL in schema → fall back to ""
    // (matches raas_v4 candidateMatchRuntimeRepository.upsert convention).
    const runtimePostingId = resolvedJobPostingId ?? '';

    if (existing) {
      await c.query(
        `UPDATE candidate_match_result_runtime_state SET
            job_posting_id        = COALESCE(NULLIF($2, ''), job_posting_id),
            client_id             = COALESCE(NULLIF($3, ''), client_id),
            education_score       = $4,
            skills_score          = $5,
            project_experience_score = $6,
            stability_score       = $7,
            experience_score      = $8,
            experience_assessment = $9,
            total_weighted_score  = $10,
            matched_skills        = $11::jsonb,
            missing_skills        = $12::jsonb,
            must_have_analysis    = $13::jsonb,
            nice_to_have_analysis = $14::jsonb,
            star_rating           = $15,
            qualification_retained = $16,
            advantages            = $17::jsonb,
            disadvantages         = $18::jsonb,
            ai_summary            = $19,
            final_recommendation  = $20,
            raw_llm_response      = $21::jsonb,
            updated_at            = NOW()
         WHERE candidate_match_result_id = $1`,
        [
          cmrId,
          runtimePostingId,
          clientId,
          item.education_score ?? null,
          skillsScore,
          item.project_experience_score ?? null,
          item.stability_score ?? null,
          experienceScore,
          experienceAssessment,
          matchingScore,
          JSON.stringify(matchedSkills ?? null),
          JSON.stringify(missingSkills ?? null),
          JSON.stringify(mustHaveAnalysis ?? null),
          JSON.stringify(niceToHaveAnalysis ?? null),
          typeof item.star_rating === 'number' ? item.star_rating : null,
          typeof item.qualification_retained === 'boolean' ? item.qualification_retained : null,
          JSON.stringify(advantages),
          JSON.stringify(disadvantages),
          aiSummary,
          finalRecommendation,
          JSON.stringify(fields.raw),
        ],
      );
    } else {
      await c.query(
        `INSERT INTO candidate_match_result_runtime_state (
            candidate_match_result_id, candidate_id, job_requisition_id,
            job_posting_id, client_id,
            education_score, skills_score, project_experience_score,
            stability_score, experience_score,
            experience_assessment, total_weighted_score,
            matched_skills, missing_skills,
            must_have_analysis, nice_to_have_analysis,
            star_rating, qualification_retained,
            advantages, disadvantages,
            ai_summary, final_recommendation, raw_llm_response,
            created_at, updated_at
          ) VALUES (
            $1, $2, $3,
            $4, $5,
            $6, $7, $8,
            $9, $10,
            $11, $12,
            $13::jsonb, $14::jsonb,
            $15::jsonb, $16::jsonb,
            $17, $18,
            $19::jsonb, $20::jsonb,
            $21, $22, $23::jsonb,
            NOW(), NOW()
          )`,
        [
          cmrId,
          item.candidate_id,
          item.job_requisition_id,
          runtimePostingId,
          clientId,
          item.education_score ?? null,
          skillsScore,
          item.project_experience_score ?? null,
          item.stability_score ?? null,
          experienceScore,
          experienceAssessment,
          matchingScore,
          JSON.stringify(matchedSkills ?? null),
          JSON.stringify(missingSkills ?? null),
          JSON.stringify(mustHaveAnalysis ?? null),
          JSON.stringify(niceToHaveAnalysis ?? null),
          typeof item.star_rating === 'number' ? item.star_rating : null,
          typeof item.qualification_retained === 'boolean' ? item.qualification_retained : null,
          JSON.stringify(advantages),
          JSON.stringify(disadvantages),
          aiSummary,
          finalRecommendation,
          JSON.stringify(fields.raw),
        ],
      );
    }

    // ── Step 3: UPSERT main candidate_match_result row ──
    // Skipped when no JobPosting exists — without one, /jd/[id]/match-pool
    // can't link the row. Runtime_state is enough for back-fill once a
    // posting lands.
    if (resolvedJobPostingId) {
      const dimensionScores = buildDimensionScores(envelope, resolved);
      const coreTags = buildCoreTags(envelope, matchedSkills ?? null);
      const matchStatus =
        item.match_status ??
        (item.source === 'need_interview'
          ? 'matched'
          : item.source === 'no_interview'
            ? 'tentative'
            : item.source === 'failed'
              ? 'failed'
              : null);
      const matchReason =
        item.match_reason ??
        (typeof aiSummary === 'string' && aiSummary ? aiSummary : null);

      const existingMain = await c.query<{ candidate_match_result_id: string }>(
        `SELECT candidate_match_result_id FROM candidate_match_result
          WHERE candidate_match_result_id = $1
          LIMIT 1`,
        [cmrId],
      );

      if (existingMain.rows[0]) {
        await c.query(
          `UPDATE candidate_match_result SET
              job_posting_id   = $2,
              match_score      = $3,
              match_reason     = $4,
              match_status     = $5,
              dimension_scores = $6::jsonb,
              core_tags        = $7::jsonb,
              experience_years = $8,
              created_by       = COALESCE($9, created_by),
              updated_at       = NOW()
           WHERE candidate_match_result_id = $1`,
          [
            cmrId,
            resolvedJobPostingId,
            matchingScore,
            matchReason,
            matchStatus,
            JSON.stringify(dimensionScores ?? null),
            JSON.stringify(coreTags),
            typeof item.experience_years === 'number' ? item.experience_years : null,
            item.created_by ?? null,
          ],
        );
      } else {
        // ADR-0061 §② (2026-06-14): CMR.stage 已从招聘漏斗信号下线。raas 端不再
        // 读/写该列（漏斗一律走 Application SSOT），AO 停止写入初值 'draft'。列在
        // raas schema 为 nullable，省略即落 NULL；AO 本就从不读 stage，行为零变化。
        await c.query(
          `INSERT INTO candidate_match_result (
              candidate_match_result_id, candidate_id, job_requisition_id,
              match_score, match_reason, match_status,
              job_posting_id, dimension_scores, core_tags,
              experience_years, created_by,
              created_at, updated_at
            ) VALUES (
              $1, $2, $3,
              $4, $5, $6,
              $7, $8::jsonb, $9::jsonb,
              $10, $11,
              NOW(), NOW()
            )`,
          [
            cmrId,
            item.candidate_id,
            item.job_requisition_id,
            matchingScore,
            matchReason,
            matchStatus,
            resolvedJobPostingId,
            JSON.stringify(dimensionScores ?? null),
            JSON.stringify(coreTags),
            typeof item.experience_years === 'number' ? item.experience_years : null,
            item.created_by ?? 'ai_engine',
          ],
        );
      }
    }

    return {
      candidate_match_result_id: cmrId,
      candidate_id: item.candidate_id,
      job_requisition_id: item.job_requisition_id,
      created,
      job_posting_id: resolvedJobPostingId,
    };
  });
}
