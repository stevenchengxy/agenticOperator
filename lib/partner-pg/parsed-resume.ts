// lib/partner-pg/parsed-resume.ts
//
// F1: thin RESUME_PROCESSED → fetch parsed resume body.
// Direct SQL replacement for RAAS API
//   GET /api/v1/candidates/:candidateId/resumes/:resumeId/parsed
//
// Per raas-integration-divergence(1).md §F1:
//   - 响应顶层直出 { candidate_id, resume_id, data, ... }
//   - data = RoboHire-shape parsed_data (raw_parse_result in partner schema)
//   - candidate_snapshot / resume_meta 可选
//
// Used by:
//   - ruleCheckAgent  (thin → fetch parsed body for LLM gate)
//   - matchResumeAgent (回拉 parsed for RoboHire match-resume call)
//
// Partner source of truth:
//   raas_v4/backend/prisma/schema.prisma model Resume (raw_parse_result Json?)
//   raas_v4/backend/apps/api/src/modules/candidates/candidates-main.hono.ts

import { query } from './client';

export type ParsedResumeResult = {
  candidate_id: string;
  resume_id: string;
  /** RoboHire-shape parsed_data (raw_parse_result column). May be null if parse failed/未跑. */
  data: Record<string, unknown> | null;
  /**
   * Plain PDF text (`parsed_content` column). This is RoboHire's `rawText`
   * field captured at parse time; written by lib/partner-pg/candidates.ts.
   * Partner contract (2026-05-21): matchResume should pass this verbatim as
   * the `resume` parameter to /match-resume instead of stringifying the
   * structured JSON. Null when RoboHire didn't return rawText.
   */
  parsed_content: string | null;
  /** Optional snapshot of candidate fields at time of parse (name / phone / email). */
  candidate_snapshot?: {
    name: string | null;
    phone: string | null;
    email: string | null;
    current_company: string | null;
    current_title: string | null;
  };
  /** Optional resume metadata. */
  resume_meta?: {
    file_name: string | null;
    file_type: string | null;
    file_size: number | null;
    bucket_name: string | null;
    object_key: string | null;
    parse_status: string | null;
    uploaded_at: Date | string | null;
  };
};

/**
 * Fetch parsed resume body by candidate + resume IDs.
 * Returns null if not found — caller should treat as NonRetriable.
 *
 * Per F1 doc: 「回拉成功但 data 为空对象 → 视为有效空简历，继续后续逻辑(不报错)」
 * 所以我们 always 返回 data 字段(可能是 null),caller 自己判断空 vs 不存在。
 */
export async function getParsedResume(
  candidateId: string,
  resumeId: string,
): Promise<ParsedResumeResult | null> {
  const sql = `
    SELECT
      r.candidate_id,
      r.resume_id,
      r.raw_parse_result AS data,
      r.parsed_content,
      r.file_name,
      r.file_type,
      r.file_size,
      r.bucket_name,
      r.object_key,
      r.parse_status,
      r.uploaded_at,
      c.name           AS c_name,
      c.phone          AS c_phone,
      c.email          AS c_email,
      c.current_company,
      c.current_title
    FROM resume r
    LEFT JOIN candidate c ON c.candidate_id = r.candidate_id
    WHERE r.candidate_id = $1 AND r.resume_id = $2
    LIMIT 1
  `;

  const result = await query<{
    candidate_id: string;
    resume_id: string;
    data: Record<string, unknown> | null;
    parsed_content: string | null;
    file_name: string | null;
    file_type: string | null;
    file_size: number | null;
    bucket_name: string | null;
    object_key: string | null;
    parse_status: string | null;
    uploaded_at: Date | string | null;
    c_name: string | null;
    c_phone: string | null;
    c_email: string | null;
    current_company: string | null;
    current_title: string | null;
  }>(sql, [candidateId, resumeId]);

  const row = result.rows[0];
  if (!row) return null;

  return {
    candidate_id: row.candidate_id,
    resume_id: row.resume_id,
    data: row.data,
    parsed_content: row.parsed_content,
    candidate_snapshot: {
      name: row.c_name,
      phone: row.c_phone,
      email: row.c_email,
      current_company: row.current_company,
      current_title: row.current_title,
    },
    resume_meta: {
      file_name: row.file_name,
      file_type: row.file_type,
      file_size: row.file_size,
      bucket_name: row.bucket_name,
      object_key: row.object_key,
      parse_status: row.parse_status,
      uploaded_at: row.uploaded_at,
    },
  };
}
