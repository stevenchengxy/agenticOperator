// lib/partner-pg/agent-view.ts
//
// F2: 路径 B 简历文件名模糊收敛 claimer 在招岗位列表.
// Direct SQL replacement for RAAS API
//   GET /api/v1/requirements/agent-view
//     ?claimer_employee_id=<employee_id>
//     &resume_filename=<原始文件名>
//
// Per raas-integration-divergence(1).md §F2:
//   - 仅路径 B 调用 (无 job_requisition_id)
//   - 文件名解析在 raas 侧 → 我们把解析逻辑直接搬过来
//   - 零回归: filename 缺/乱码/0 命中 → 退回全量 (filterRequirementsByFilename 兜底)
//   - 路径 A 不走此逻辑 (caller 保证)
//
// Partner source of truth (DO NOT MODIFY):
//   raas_v4/backend/apps/api/src/modules/requirements/requirements-agent-view.hono.ts
//   raas_v4/backend/apps/api/src/modules/requirements/job-title-fuzzy.ts
//
// Used by:
//   - ruleCheckAgent (路径 B 时,先收敛再循环每个 JR 跑规则)

import { query } from './client';

// ──────────────────────────────────────────────────────────────────────
// Fuzzy match helper — 1:1 port from raas_v4/.../job-title-fuzzy.ts
// (do NOT edit independently — keep in sync with partner)
// ──────────────────────────────────────────────────────────────────────

const JOB_TITLE_MATCH_THRESHOLD = 0.5;
const BRACKET_RE = /【([^】]*)】/;
const SEPARATOR_RE = /[+_\s　]/;

export function parseJobTitleFromFilename(
  filename: string | null | undefined,
): string | null {
  if (typeof filename !== 'string') return null;
  const m = BRACKET_RE.exec(filename);
  if (!m) return null;
  const inside = m[1] ?? '';
  const idx = inside.search(SEPARATOR_RE);
  const raw = idx >= 0 ? inside.slice(0, idx) : inside;
  const title = raw.trim();
  return title.length > 0 ? title : null;
}

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function bigrams(s: string): string[] {
  if (s.length <= 1) return s.length === 1 ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

export function jobTitleSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 1;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.length === 0 || bb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
  let overlap = 0;
  for (const g of bb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      overlap += 1;
      counts.set(g, c - 1);
    }
  }
  return (2 * overlap) / (ba.length + bb.length);
}

// ──────────────────────────────────────────────────────────────────────
// Main entry — list claimer's active JRs (with matching fields) + fuzzy filter
// ──────────────────────────────────────────────────────────────────────

/** Matching fields that downstream rule-check / match-resume actually consumes. */
const MATCHING_FIELDS = [
  'job_requisition_id',
  'job_requisition_specification_id',
  'client_id',
  'client_job_title',
  'client_job_type',
  'job_responsibility',
  'job_requirement',
  'degree_requirement',
  'education_requirement',
  'must_have_skills',
  'nice_to_have_skills',
  'language_requirements',
  'negative_requirement',
  'work_years',
  'expected_level',
  'interview_mode',
  'required_arrival_date',
  'salary_range',
  'gender',
  'age_range',
  'recruitment_type',
  'city',
] as const;

export type AgentViewItem = {
  job_requisition_id: string;
  job_requisition_specification_id: string | null;
  client_id: string | null;
  client_job_title: string | null;
  client_job_type: string | null;
  job_responsibility: string | null;
  job_requirement: string | null;
  degree_requirement: string | null;
  education_requirement: string | null;
  must_have_skills: string[] | null;
  nice_to_have_skills: string[] | null;
  language_requirements: string | null;
  negative_requirement: string | null;
  work_years: number | null;
  expected_level: string | null;
  interview_mode: string | null;
  required_arrival_date: Date | string | null;
  salary_range: string | null;
  gender: string | null;
  age_range: string | null;
  recruitment_type: string | null;
  city: string | null;
};

export type AgentViewResult = {
  items: AgentViewItem[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

export type AgentViewOptions = {
  /** Required: only return JRs claimed by this employee_id. */
  claimerEmployeeId: string;
  /** Optional: original resume filename (with 【岗位名】). Triggers fuzzy filter. */
  resumeFilename?: string | null;
  /** Optional: paginate. Default 1. */
  page?: number;
  /** Optional: page size. Default 20, max 100. */
  pageSize?: number;
};

const MAX_FILTER_FETCH = 500;

/**
 * 2026-05-20 path B 改造:HSM 名下有 Job_Posting 才进 rule-check。
 *
 * 业务语义:
 *   - Job_Posting 是已发布(或预发布)给候选人投递的岗位
 *   - HSM(hsm_employee_id 在 Job_Requisition_Specification 上)是岗位负责人
 *   - 没有 Job_Posting 意味着 JR 还在草稿阶段 / 未发布 → 不该 rule-check
 *
 * 取出该 HSM 名下所有 Job_Posting,反推到 Job_Requisition,作为 path B
 * 的 rule-check 范围。返回 shape 跟 getRequirementsAgentView 一致,
 * 这样 rule-check-agent 下游不用改。
 *
 * 可选 resumeFilename 仍然做 F2 fuzzy match(零回归 fallback)。
 */
export async function getHsmJobPostingsAsRequirements(
  opts: AgentViewOptions,
): Promise<AgentViewResult> {
  const { claimerEmployeeId: hsmEmployeeId } = opts;
  if (!hsmEmployeeId || !hsmEmployeeId.trim()) {
    throw new Error('[partner-pg] hsmEmployeeId is required');
  }

  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const filename = (opts.resumeFilename ?? '').trim();
  const willFilter = filename.length > 0;

  // ── Step 1: HSM 名下的 Job_Posting → 反推 distinct job_requisition_id ──
  // 通过 JR 的 job_requisition_specification_id JOIN 到 spec,
  // 按 spec.hsm_employee_id 筛选。同时 OR job_posting.recruiter_id 匹配
  // (兼容 recruiter 视角)。
  const postingRes = await query<{ job_requisition_id: string }>(
    `SELECT DISTINCT jp.job_requisition_id
       FROM job_posting jp
       LEFT JOIN job_requisition jr
         ON jr.job_requisition_id = jp.job_requisition_id
       LEFT JOIN job_requisition_specification spec
         ON spec.job_requisition_specification_id = jr.job_requisition_specification_id
      WHERE spec.hsm_employee_id = $1 OR jp.recruiter_id = $1`,
    [hsmEmployeeId],
  );
  const jrIds = postingRes.rows
    .map((r) => r.job_requisition_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (jrIds.length === 0) {
    // HSM 没有任何 Job_Posting → caller(rule-check-agent)应该停止匹配
    return { items: [], page, page_size: pageSize, total: 0, total_pages: 1 };
  }

  // ── Step 2: 拉这些 JR 的 matching fields ──
  const selectCols = MATCHING_FIELDS.join(', ');
  const limit = willFilter ? MAX_FILTER_FETCH : pageSize;
  const offset = willFilter ? 0 : (page - 1) * pageSize;

  const jrRes = await query<AgentViewItem>(
    `SELECT ${selectCols}
       FROM job_requisition
      WHERE job_requisition_id = ANY($1::text[])
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    [jrIds],
  );

  let items: AgentViewItem[] = jrRes.rows;
  let total: number = items.length;

  // ── Step 3: optional fuzzy filter by filename ──
  if (willFilter) {
    const parsedTitle = parseJobTitleFromFilename(filename);
    if (parsedTitle) {
      const scored = items
        .map((it) => ({
          it,
          score: jobTitleSimilarity(parsedTitle, it.client_job_title ?? ''),
        }))
        .filter((x) => x.score >= JOB_TITLE_MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        items = scored.map((x) => x.it);
        total = items.length;
      }
    }
    const start = (page - 1) * pageSize;
    items = items.slice(start, start + pageSize);
  }

  return {
    items,
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * F2: list claimer's active JRs, optionally narrowed by filename fuzzy match.
 *
 * Zero-regression contract: if `resumeFilename` is empty, missing, or 0-hit,
 * returns the full claimed list (same as if filename were not passed).
 */
export async function getRequirementsAgentView(
  opts: AgentViewOptions,
): Promise<AgentViewResult> {
  const { claimerEmployeeId } = opts;
  if (!claimerEmployeeId || !claimerEmployeeId.trim()) {
    throw new Error('[partner-pg] claimerEmployeeId is required');
  }

  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const filename = (opts.resumeFilename ?? '').trim();
  const willFilter = filename.length > 0;

  // ── Step 1: get claimed JR IDs (requirement_claim with released_at IS NULL) ──
  const claimedRes = await query<{ job_requisition_id: string }>(
    `SELECT DISTINCT job_requisition_id
       FROM requirement_claim
      WHERE recruiter_id = $1 AND released_at IS NULL`,
    [claimerEmployeeId],
  );
  const claimedIds = claimedRes.rows.map((r) => r.job_requisition_id);

  if (claimedIds.length === 0) {
    return { items: [], page, page_size: pageSize, total: 0, total_pages: 1 };
  }

  // ── Step 2: fetch JR rows with matching fields ──
  // When filtering: fetch up to MAX_FILTER_FETCH to apply fuzzy match,
  // then slice to page after.  Otherwise: paginate directly.
  const selectCols = MATCHING_FIELDS.join(', ');
  const limit = willFilter ? MAX_FILTER_FETCH : pageSize;
  const offset = willFilter ? 0 : (page - 1) * pageSize;

  const jrRes = await query<AgentViewItem>(
    `SELECT ${selectCols}
       FROM job_requisition
      WHERE job_requisition_id = ANY($1::text[])
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    [claimedIds],
  );

  let items: AgentViewItem[] = jrRes.rows;
  let total: number = items.length;

  // ── Step 3: optional fuzzy filter by filename ──
  if (willFilter) {
    const parsedTitle = parseJobTitleFromFilename(filename);
    if (parsedTitle) {
      const scored = items
        .map((it) => ({
          it,
          score: jobTitleSimilarity(parsedTitle, it.client_job_title ?? ''),
        }))
        .filter((x) => x.score >= JOB_TITLE_MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        // Hit: narrow to scored items
        items = scored.map((x) => x.it);
        total = items.length;
      }
      // 0-hit: keep full list (zero regression)
    }
    // unparseable filename: keep full list (zero regression)

    // Apply pagination to (possibly narrowed) list
    const start = (page - 1) * pageSize;
    items = items.slice(start, start + pageSize);
  }

  return {
    items,
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
