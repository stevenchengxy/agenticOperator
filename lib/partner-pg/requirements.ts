// lib/partner-pg/requirements.ts
//
// Direct SQL replacement for RAAS API GET /api/v1/requirements/:id.
// Replaces lib/raas-api-client.ts::getRequirementDetail.
//
// Used by:
//   - createJdAgent (F4 prompt input)
//   - ruleCheckAgent (rule fields: must_have_skills, degree_requirement, ...)
//   - matchResumeAgent (JR context for match-resume call)
//
// Partner source of truth (DO NOT MODIFY):
//   raas_v4/backend/apps/api/src/modules/requirements/requirements-main.hono.ts:417
//   raas_v4/backend/apps/api/src/modules/requirements/requirement.service.ts

import { query } from './client';
import type {
  JobRequisition,
  JobRequisitionSpecification,
  RequirementDetail,
} from './types';

/**
 * GET job_requisition + LEFT JOIN job_requisition_specification by ID.
 *
 * Returns null if not found — caller should treat as NonRetriable
 * (JR doesn't exist in partner DB, retrying won't help).
 *
 * Postgres returns the spec row as a JSON object via `row_to_json(s.*)`,
 * which `pg` driver auto-parses into a JS object (since pg ≥ 8 with jsonb).
 */
export async function getRequirementDetail(
  jobRequisitionId: string,
): Promise<RequirementDetail | null> {
  const sql = `
    SELECT
      row_to_json(r.*) AS requirement_json,
      row_to_json(s.*) AS specification_json
    FROM job_requisition r
    LEFT JOIN job_requisition_specification s
      ON s.job_requisition_specification_id = r.job_requisition_specification_id
    WHERE r.job_requisition_id = $1
    LIMIT 1
  `;
  const result = await query<{
    requirement_json: JobRequisition;
    specification_json: JobRequisitionSpecification | null;
  }>(sql, [jobRequisitionId]);

  const row = result.rows[0];
  if (!row) return null;

  const requirement = row.requirement_json;
  const specification = row.specification_json;

  return {
    ...requirement,
    specification,
  };
}

// ──────────────────────────────────────────────────────────────────────
// requirement_clarification_record — HSM 录入的需求澄清内容
// ──────────────────────────────────────────────────────────────────────

/** 一条已录入的需求澄清记录(partner 表 requirement_clarification_record)。 */
export type RequirementClarificationRecord = {
  clarified_at: Date | string | null;
  content: string;
  clarifier_name: string | null;
  client_clarifier_name: string | null;
  clarification_type: string | null;
};

/**
 * 取某需求已录入的全部澄清记录,按澄清时间正序。
 * 澄清是 JD 生成的增强信息(非关键路径),调用方应容错处理(失败回退空数组)。
 */
export async function getClarificationRecords(
  jobRequisitionId: string,
): Promise<RequirementClarificationRecord[]> {
  const sql = `
    SELECT clarified_at, content, clarifier_name, client_clarifier_name, clarification_type
    FROM requirement_clarification_record
    WHERE job_requisition_id = $1
    ORDER BY clarified_at ASC
  `;
  const result = await query<RequirementClarificationRecord>(sql, [jobRequisitionId]);
  return result.rows.filter((r) => typeof r.content === 'string' && r.content.trim().length > 0);
}
