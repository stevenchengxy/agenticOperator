// matchResume agent — Workflow node 10-2 (`matchResume`).
//
// 2026-05-19 consolidation: 只订 MATCH_RULE_CHECK_PASSED。
// (原第一段 — RESUME_PROCESSED → 拉 JR + emit RULE_CHECK_REQUESTED —
// 已搬到 ruleCheckAgent。)
//
// 流程:
//   1. 直连 RoboHire POST /match-resume(不走 RAAS proxy)
//   2. RAAS POST /match-results 落 overall match 字段
//   3. score 阈值分发(F3,2026-05-21 单阈值化):
//        < 40                    → MATCH_FAILED
//        其它(含 null / 缺分)     → MATCH_PASSED_NEED_INTERVIEW
//        调用失败                → MATCH_FAILED (上方 RobohireApiError 分支)
//
// 见 docs/superpowers/specs/2026-05-19-rule-check-consolidation-design.md

import { NonRetriableError } from 'inngest';
import { saveMatchResultsToPartnerPg } from '@/lib/partner-pg/match-results';
import { resolveMatchPayload } from '@/lib/partner-pg/_robohire-normalize';
import { writeCandidateMatchResultInstance } from '@/lib/allmeta-writers';
import { matchResumeDirect, RobohireApiError } from '@/lib/robohire-client';
import { createAgentLogger, runWithLogger } from '@/lib/agent-logger';
import {
  inngest,
  type MatchEventData,
  type MatchRuleCheckPassedData,
} from '@/server/inngest/client';

// Loose shape — the merged JR object from rule-check carries arbitrary
// keys (path A flatten + path B agent-view item). Field-name probes below.
type RequirementsAgentViewItem = Record<string, unknown>;

const AGENT_ID = 'match-resume-agent';
const AGENT_NAME = 'matchResume';

export const matchResumeAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Match Resume Agent',
    retries: 2,
    triggers: [{ event: 'MATCH_RULE_CHECK_PASSED' }],
  },
  async ({ event, step, logger, runId }) => {
    return await handleMatchRuleCheckPassed({ event, step, logger, runId });
  },
);

// ──────────────────────────────────────────────────────────────────────
// MATCH_RULE_CHECK_PASSED → RoboHire match → saveMatchResults → emit MATCH_*
// ──────────────────────────────────────────────────────────────────────

async function handleMatchRuleCheckPassed({ event, step, logger, runId }: any) {
  const data = event.data as MatchRuleCheckPassedData;
  const traceId = data.runtime_context?.trace_id ?? undefined;
  const stepKey = sanitizeStepKey(data.job_requisition_id);
  const req = (data.job_requisition ?? {}) as RequirementsAgentViewItem;
  const candidateId = data.candidate_id ?? '';
  const uploadId = data.upload_id ?? '';

  const fileLogger = createAgentLogger({
    agent: 'matchResume',
    runId: runId ?? `local-${Date.now()}`,
    traceId: traceId ?? null,
    anchors: {
      candidate_id: candidateId || undefined,
      job_requisition_id: data.job_requisition_id,
      upload_id: uploadId || undefined,
    },
  });
  return runWithLogger(fileLogger, async () => {
  fileLogger.event('handler.start', {
    event_name: event.name,
    candidate_id: candidateId,
    job_requisition_id: data.job_requisition_id,
  });

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

  // 2026-05-21 partner contract: pass PDF plain text (parsed_content /
  // RoboHire rawText) as the `resume` parameter. Falls back to the legacy
  // stringified-JSON shape only when parsed_content is missing (e.g. older
  // resume rows from before partner started writing the column, or RoboHire
  // didn't return rawText for that PDF).
  const parsedContent =
    typeof data.parsed_content === 'string' && data.parsed_content.trim().length > 0
      ? data.parsed_content
      : null;
  const resumeText = parsedContent ?? buildResumeTextFromParsed(data.parsed_resume);
  const resumeSource: 'parsed_content' | 'parsed_resume_json' = parsedContent
    ? 'parsed_content'
    : 'parsed_resume_json';
  const jdText = flattenRequirementForMatch(req);

  if (!resumeText.trim()) {
    throw new NonRetriableError(
      `[${AGENT_NAME}] resume text empty for JR ${data.job_requisition_id}`,
    );
  }

  const matchResult = await step.run(`match-${stepKey}`, async () => {
    logger.info(
      `[${AGENT_NAME}] calling RoboHire /match-resume · jr=${data.job_requisition_id} ` +
        `jd_chars=${jdText.length} resume_chars=${resumeText.length} resume_src=${resumeSource}`,
    );
    fileLogger.event('match.input', {
      job_requisition_id: data.job_requisition_id,
      candidate_id: candidateId || undefined,
      resume_chars: resumeText.length,
      resume_src: resumeSource,
      jd_chars: jdText.length,
    });
    try {
      const r = await matchResumeDirect(
        { resume: resumeText, jd: jdText },
        // 显式传 fileLogger → RoboHire match-resume 完整 in/out 进 per-run 审计
        // (Inngest step.run 内 ALS 不可靠,必须显式传闭包 logger).
        { traceId: traceId ?? undefined, logger: fileLogger },
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
      overall_status: '不匹配',
      success: false,
      data: { error_kind: 'robohire-match-call-failed' },
      error: matchResult.error,
    };
    fileLogger.event('emit.match-failed-robohire-error', {
      candidate_id: candidateId,
      job_requisition_id: data.job_requisition_id,
      error: matchResult.error,
    });
    await step.sendEvent(`emit-match-failed-${stepKey}`, {
      name: 'MATCH_FAILED',
      data: failedPayload,
    });
    return { ok: false, job_requisition_id: data.job_requisition_id, error: matchResult.error };
  }

  const saveResult = await step.run(`save-match-${stepKey}`, async () => {
    // 2026-05-21: pass the RoboHire envelope verbatim — the writer now
    // ports raas_v4's resolveMatchPayload / buildShapeDInner so real scores
    // (nested under overallMatchScore.score + breakdown) land in the right
    // columns. job_posting_id is resolved server-side from the JR if absent.
    const rd = matchResult.data as Record<string, unknown>;
    const r = await saveMatchResultsToPartnerPg({
      candidate_id: candidateId,
      job_requisition_id: data.job_requisition_id,
      client_id: pickClientId(req) ?? null,
      job_posting_id:
        typeof (req as Record<string, unknown>).job_posting_id === 'string'
          ? ((req as Record<string, unknown>).job_posting_id as string)
          : null,
      source: 'need_interview',
      created_by: 'ai_engine',
      raw_llm_response: rd,
    });
    logger.info(
      `[${AGENT_NAME}] partner-pg saveMatchResults OK · jr=${data.job_requisition_id} ` +
        `cmr=${r.candidate_match_result_id} jp=${r.job_posting_id ?? '-'} ` +
        `created=${r.created}${r.skipped ? ` skipped=${r.reason}` : ''}`,
    );
    return r;
  });

  const matching_score = extractMatchingScore(matchResult.data);
  const eventName = decideMatchEvent(matching_score);
  const overall_status: '匹配' | '不匹配' = eventName === 'MATCH_FAILED' ? '不匹配' : '匹配';

  // ── 写 Neo4j Candidate_Match_Result overall_* fields via allmeta ──
  // PK 复用 ruleCheckAgent 已建的 cmr_<candidate>_<jr>(allmeta upsert by PK)
  // 跟 ruleCheckAgent 那条 row 合并 — 覆盖 overall_* 不动 rule_check_*
  await step.run(`write-cmr-neo4j-${stepKey}`, async () => {
    const rd = matchResult.data as Record<string, unknown>;
    const cmrId = `cmr_${candidateId || 'unknown'}_${data.job_requisition_id}`;
    const r = await writeCandidateMatchResultInstance({
      candidate_match_result_id: cmrId,
      client_id: pickClientId(req) ?? null,
      candidate_id: candidateId,
      job_requisition_id: data.job_requisition_id,
      overall_match_score: matching_score,
      overall_fit_verdict: overall_status,
      overall_fit_summary:
        typeof rd.recommendation === 'string' ? rd.recommendation : null,
      overall_match_grade: gradeFromScore(matching_score),
    });
    if (r.ok)
      logger.info(`[${AGENT_NAME}] ✓ allmeta wrote Candidate_Match_Result ${cmrId} overall_*`);
    else logger.warn(`[${AGENT_NAME}] allmeta CMR write failed: ${r.error}`);
    return r;
  });

  const payload: MatchEventData = {
    job_requisition_id: data.job_requisition_id,
    candidate_id: candidateId || null,
    matching_score,
    upload_id: uploadId || null,
    job_posting_id:
      typeof (req as any).job_posting_id === 'string' && (req as any).job_posting_id.trim()
        ? ((req as any).job_posting_id as string).trim()
        : null,
    candidate_match_result_id: saveResult.candidate_match_result_id,
    overall_status,
    success: true,
    data: matchResult.data as unknown as Record<string, unknown>,
    requestId: matchResult.requestId,
    savedAs: matchResult.savedAs,
  };
  fileLogger.event('emit.match-event', {
    event_name: eventName,
    candidate_id: candidateId,
    job_requisition_id: data.job_requisition_id,
    matching_score,
    candidate_match_result_id: saveResult.candidate_match_result_id,
    overall_status,
  });
  await step.sendEvent(`emit-match-${stepKey}`, { name: eventName, data: payload });

  logger.info(
    `[${AGENT_NAME}] ✅ emitted ${eventName} · jr=${data.job_requisition_id} score=${matching_score}`,
  );
  fileLogger.event('handler.done', {
    event_name: eventName,
    candidate_id: candidateId,
    job_requisition_id: data.job_requisition_id,
    matching_score,
  });
  return {
    ok: true,
    job_requisition_id: data.job_requisition_id,
    requestId: matchResult.requestId,
    eventName,
    matching_score,
  };
  }); // runWithLogger
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
  // RoboHire real-shape: d.matchScore is always null, real score nests at
  // d.overallMatchScore.score. Reuse the normalizer (same logic as
  // saveMatchResultsToPartnerPg) so event routing and DB write agree.
  if (!robohireData || typeof robohireData !== 'object') return null;
  const { inner } = resolveMatchPayload(robohireData as Record<string, unknown>);
  const s = (inner as { matchScore?: unknown }).matchScore;
  return typeof s === 'number' ? s : null;
}

/**
 * F3 score → event-name dispatch (2026-05-21 单阈值化):
 *   score < 40 → MATCH_FAILED
 *   其它(含 null) → MATCH_PASSED_NEED_INTERVIEW
 *
 * MATCH_PASSED_NO_INTERVIEW 路径已下线 —— 不再按分数自动免面试,统一让 ≥40
 * 的候选人都进面试环节。
 */
function decideMatchEvent(
  score: number | null,
): 'MATCH_PASSED_NEED_INTERVIEW' | 'MATCH_FAILED' {
  if (score === null) return 'MATCH_PASSED_NEED_INTERVIEW';
  if (score < 40) return 'MATCH_FAILED';
  return 'MATCH_PASSED_NEED_INTERVIEW';
}

function gradeFromScore(score: number | null): string {
  if (score === null) return '未评级';
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}
