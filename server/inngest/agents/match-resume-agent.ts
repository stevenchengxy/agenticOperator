// matchResume agent — Workflow node 10-2 (`matchResume`).
//
// 2026-05-19 consolidation: 只订 MATCH_RULE_CHECK_PASSED。
// (原第一段 — RESUME_PROCESSED → 拉 JR + emit RULE_CHECK_REQUESTED —
// 已搬到 ruleCheckAgent。)
//
// 流程:
//   1. 直连 RoboHire POST /match-resume(不走 RAAS proxy)
//   2. RAAS POST /match-results 落 overall match 字段
//   3. score 阈值分发(F3):
//        > 90       → MATCH_PASSED_NO_INTERVIEW
//        [50, 90]   → MATCH_PASSED_NEED_INTERVIEW
//        < 50       → MATCH_FAILED
//        null / 调用失败 → MATCH_FAILED
//
// 见 docs/superpowers/specs/2026-05-19-rule-check-consolidation-design.md

import { NonRetriableError } from 'inngest';
import {
  RaasApiError,
  saveMatchResults,
  type RequirementsAgentViewItem,
} from '@/lib/raas-api-client';
import { matchResumeDirect, RobohireApiError } from '@/lib/robohire-client';
import {
  inngest,
  type MatchEventData,
  type MatchRuleCheckPassedData,
} from '@/server/inngest/client';

const AGENT_ID = 'match-resume-agent';
const AGENT_NAME = 'matchResume';

export const matchResumeAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Match Resume Agent (workflow node 10-2)',
    retries: 2,
    triggers: [{ event: 'MATCH_RULE_CHECK_PASSED' }],
  },
  async ({ event, step, logger }) => {
    return await handleMatchRuleCheckPassed({ event, step, logger });
  },
);

// ──────────────────────────────────────────────────────────────────────
// MATCH_RULE_CHECK_PASSED → RoboHire match → saveMatchResults → emit MATCH_*
// ──────────────────────────────────────────────────────────────────────

async function handleMatchRuleCheckPassed({ event, step, logger }: any) {
  const data = event.data as MatchRuleCheckPassedData;
  const traceId = data.runtime_context?.trace_id ?? undefined;
  const stepKey = sanitizeStepKey(data.job_requisition_id);
  const req = (data.job_requisition ?? {}) as RequirementsAgentViewItem;
  const candidateId = data.candidate_id ?? '';
  const uploadId = data.upload_id ?? '';

  if (!data.job_requisition || !data.parsed_resume) {
    logger.warn(
      `[${AGENT_NAME}] MATCH_RULE_CHECK_PASSED missing job_requisition or parsed_resume for JR=${data.job_requisition_id} — cannot match`,
    );
    return {
      ok: false,
      job_requisition_id: data.job_requisition_id,
      error: 'missing-job-requisition-or-parsed-resume',
    };
  }

  const resumeText = buildResumeTextFromParsed(data.parsed_resume);
  const jdText = flattenRequirementForMatch(req);

  if (!resumeText.trim()) {
    throw new NonRetriableError(
      `[${AGENT_NAME}] resume text empty for JR ${data.job_requisition_id}`,
    );
  }

  const matchResult = await step.run(`match-${stepKey}`, async () => {
    logger.info(
      `[${AGENT_NAME}] calling RoboHire /match-resume · jr=${data.job_requisition_id} ` +
        `jd_chars=${jdText.length} resume_chars=${resumeText.length}`,
    );
    try {
      const r = await matchResumeDirect(
        { resume: resumeText, jd: jdText },
        { traceId: traceId ?? undefined },
      );
      logger.info(
        `[${AGENT_NAME}] RoboHire match OK · score=${r.data.matchScore} rec=${r.data.recommendation} requestId=${r.requestId}`,
      );
      return { ok: true as const, data: r.data, requestId: r.requestId, savedAs: r.savedAs };
    } catch (e) {
      if (e instanceof RobohireApiError && e.isClientError) {
        logger.error(`[${AGENT_NAME}] RoboHire match 4xx · ${e.code} — skipping JR`);
        return { ok: false as const, error: `${e.code}: ${e.message}` };
      }
      throw e;
    }
  });

  if (!matchResult.ok) {
    const failedPayload: MatchEventData = {
      job_requisition_id: data.job_requisition_id,
      candidate_id: candidateId || null,
      matching_score: null,
      upload_id: uploadId || null,
      success: false,
      data: { error_kind: 'robohire-match-call-failed' },
      error: matchResult.error,
    };
    await step.sendEvent(`emit-match-failed-${stepKey}`, {
      name: 'MATCH_FAILED',
      data: failedPayload,
    });
    return { ok: false, job_requisition_id: data.job_requisition_id, error: matchResult.error };
  }

  await step.run(`save-match-${stepKey}`, async () => {
    try {
      const r = await saveMatchResults(
        {
          ...(matchResult.data as Record<string, unknown>),
          source: 'need_interview',
          candidate_id: candidateId || undefined,
          upload_id: uploadId || undefined,
          job_requisition_id: data.job_requisition_id,
          client_id: pickClientId(req),
          robohire_request_id: matchResult.requestId,
          savedAs: matchResult.savedAs,
        },
        { traceId },
      );
      logger.info(`[${AGENT_NAME}] saveMatchResults OK · jr=${data.job_requisition_id}`);
      return r;
    } catch (e) {
      if (e instanceof RaasApiError && e.isClientError) {
        throw new NonRetriableError(`saveMatchResults 4xx: ${e.code} ${e.message}`);
      }
      throw e;
    }
  });

  const matching_score = extractMatchingScore(matchResult.data);
  const eventName = decideMatchEvent(matching_score);

  const payload: MatchEventData = {
    job_requisition_id: data.job_requisition_id,
    candidate_id: candidateId || null,
    matching_score,
    upload_id: uploadId || null,
    job_posting_id:
      typeof (req as any).job_posting_id === 'string' && (req as any).job_posting_id.trim()
        ? ((req as any).job_posting_id as string).trim()
        : null,
    success: true,
    data: matchResult.data as unknown as Record<string, unknown>,
    requestId: matchResult.requestId,
    savedAs: matchResult.savedAs,
  };
  await step.sendEvent(`emit-match-${stepKey}`, { name: eventName, data: payload });

  logger.info(
    `[${AGENT_NAME}] ✅ emitted ${eventName} · jr=${data.job_requisition_id} score=${matching_score}`,
  );
  return {
    ok: true,
    job_requisition_id: data.job_requisition_id,
    requestId: matchResult.requestId,
    eventName,
    matching_score,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function pickClientId(req: RequirementsAgentViewItem): string | undefined {
  for (const c of [(req as any).client_id, (req as any).clientId]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return undefined;
}

function buildResumeTextFromParsed(parsed: Record<string, unknown> | null | undefined): string {
  if (!parsed) return '';
  return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
}

function flattenRequirementForMatch(req: RequirementsAgentViewItem): string {
  const r = req as Record<string, any>;
  const lines: string[] = [];
  if (r.client_job_title || r.title) lines.push(`职位: ${r.client_job_title ?? r.title}`);
  if (r.expected_level) lines.push(`期望级别: ${r.expected_level}`);
  if (r.work_city || r.city) lines.push(`工作城市: ${r.work_city ?? r.city}`);
  if (r.salary_range) lines.push(`薪资范围: ${r.salary_range}`);
  if (r.recruitment_type) lines.push(`招聘类型: ${r.recruitment_type}`);
  if (r.interview_mode) lines.push(`面试形式: ${r.interview_mode}`);
  if (r.work_years != null) lines.push(`\n工作年限: ${r.work_years} 年`);
  if (r.degree_requirement) lines.push(`学历要求: ${r.degree_requirement}`);
  if (r.education_requirement) lines.push(`专业要求: ${r.education_requirement}`);
  if (r.language_requirements) lines.push(`语言要求: ${r.language_requirements}`);
  if (Array.isArray(r.must_have_skills) && r.must_have_skills.length)
    lines.push(`\n必备技能:\n  - ${r.must_have_skills.join('\n  - ')}`);
  if (Array.isArray(r.nice_to_have_skills) && r.nice_to_have_skills.length)
    lines.push(`\n加分技能:\n  - ${r.nice_to_have_skills.join('\n  - ')}`);
  if (r.negative_requirement && r.negative_requirement !== '无')
    lines.push(`\n排除条件:\n${r.negative_requirement}`);
  if (r.job_responsibility) lines.push(`\n岗位职责:\n${r.job_responsibility}`);
  if (r.job_requirement) lines.push(`\n任职要求:\n${r.job_requirement}`);
  return lines.join('\n');
}

function sanitizeStepKey(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
}

function extractMatchingScore(robohireData: unknown): number | null {
  if (!robohireData || typeof robohireData !== 'object') return null;
  const d = robohireData as Record<string, unknown>;
  if (typeof d.matchScore === 'number') return d.matchScore;
  if (typeof d.overallMatchScore === 'number') return d.overallMatchScore;
  return null;
}

/**
 * F3 score → event-name dispatch.
 *   score > 90       → MATCH_PASSED_NO_INTERVIEW
 *   50 ≤ score ≤ 90  → MATCH_PASSED_NEED_INTERVIEW
 *   score < 50       → MATCH_FAILED
 *   null             → MATCH_PASSED_NEED_INTERVIEW (conservative when score missing)
 */
function decideMatchEvent(
  score: number | null,
): 'MATCH_PASSED_NO_INTERVIEW' | 'MATCH_PASSED_NEED_INTERVIEW' | 'MATCH_FAILED' {
  if (score === null) return 'MATCH_PASSED_NEED_INTERVIEW';
  if (score > 90) return 'MATCH_PASSED_NO_INTERVIEW';
  if (score >= 50) return 'MATCH_PASSED_NEED_INTERVIEW';
  return 'MATCH_FAILED';
}
