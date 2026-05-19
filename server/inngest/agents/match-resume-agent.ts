// matchResume agent — Workflow node 10 (PR-4 2026-05-19 双段订阅版).
//
// 订阅两类事件,根据 event.name 分支:
//
// 1. RESUME_PROCESSED (第一段)
//    - 通过 RAAS API Server 拉招聘人员名下在招 JR 列表
//    - 对每条 JR emit RULE_CHECK_REQUESTED → ruleCheckAgent
//    - 不再内嵌 runRuleCheck(已抽到 ruleCheckAgent)
//    - 不再调 matchResume(等 ruleCheckAgent 回信 RULE_CHECK_PASSED)
//
// 2. RULE_CHECK_PASSED (第二段)
//    - 直连 RoboHire POST /match-resume (不再走 RAAS proxy)
//    - 持久化:RAAS POST /match-results (写 Postgres,保留)
//    - emit MATCH_PASSED_NEED_INTERVIEW
//
// 改动 vs PR-4 前:
//   ❌ 删除 RULE_CHECK_ENABLED env gate + step 4.0 inline rule-check
//   ✅ 双段订阅 — RESUME_PROCESSED + RULE_CHECK_PASSED
//   ✅ matchResume 切换 RoboHire 直连
//   ✅ POST /match-results 保留(RAAS dual-write 契约,见 memory)

import { NonRetriableError } from 'inngest';
import {
  RaasApiError,
  getRequirementDetail,
  getRequirementsAgentView,
  getParsedResume,
  isRaasApiConfigured,
  saveMatchResults,
  type RequirementsAgentViewItem,
} from '@/lib/raas-api-client';
import { matchResumeDirect, RobohireApiError } from '@/lib/robohire-client';
import {
  inngest,
  type MatchPassedNeedInterviewData,
  type ResumeProcessedData,
  type RuleCheckPassedData,
  type RuleCheckRequestedData,
} from '@/server/inngest/client';

const AGENT_ID = 'match-resume-agent';
const AGENT_NAME = 'matchResume';

export const matchResumeAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Match Resume Agent (workflow node 10)',
    retries: 2,
    triggers: [
      { event: 'RESUME_PROCESSED' },
      { event: 'RULE_CHECK_PASSED' },
    ],
  },
  async ({ event, step, logger }) => {
    if (event.name === 'RESUME_PROCESSED') {
      return await handleResumeProcessed({ event, step, logger });
    }
    if (event.name === 'RULE_CHECK_PASSED') {
      return await handleRuleCheckPassed({ event, step, logger });
    }
    logger.warn(`[${AGENT_NAME}] unexpected event name: ${event.name}`);
    return { ok: true, skipped: true };
  },
);

// ──────────────────────────────────────────────────────────────────────
// 第一段:RESUME_PROCESSED → emit RULE_CHECK_REQUESTED 一条/JR
// ──────────────────────────────────────────────────────────────────────

async function handleResumeProcessed({ event, step, logger }: any) {
  const data = unwrapResumeProcessedEvent(event.data);
  const traceId = getTraceId(event.data);
  const uploadId = pickUploadId(data);
  const candidateId = pickCandidateId(data);
  const employeeId = pickEmployeeId(data);
  const resumeId = typeof data.resume_id === 'string' ? data.resume_id : '';

  if (!uploadId && !candidateId) {
    throw new NonRetriableError(`[${AGENT_NAME}] RESUME_PROCESSED 缺 upload_id 和 candidate_id`);
  }
  if (!employeeId) {
    throw new NonRetriableError(`[${AGENT_NAME}] RESUME_PROCESSED 缺 employee_id`);
  }
  if (!isRaasApiConfigured()) {
    throw new NonRetriableError(`[${AGENT_NAME}] RAAS_API_BASE_URL / AGENT_API_KEY env 未配置`);
  }

  logger.info(
    `[${AGENT_NAME}] received RESUME_PROCESSED · upload_id=${uploadId ?? '—'} ` +
      `candidate_id=${candidateId ?? '—'} employee_id=${employeeId}`,
  );

  const linkedJrId =
    typeof data.job_requisition_id === 'string' && data.job_requisition_id.trim().length > 0
      ? data.job_requisition_id.trim()
      : null;

  const requirements = await step.run('list-requirements', async () => {
    if (linkedJrId) {
      try {
        const detail = await getRequirementDetail(linkedJrId, { traceId });
        const merged = {
          ...(detail.specification ?? {}),
          ...(detail.requirement ?? {}),
        } as unknown as RequirementsAgentViewItem;
        if (!hasMatchableContent(merged)) {
          logger.warn(`[${AGENT_NAME}] linked JR ${linkedJrId} 内容空,跳过`);
          return [];
        }
        return [merged];
      } catch (e) {
        if (e instanceof RaasApiError && e.isClientError) {
          throw new NonRetriableError(`getRequirementDetail 4xx for ${linkedJrId}: ${e.code} ${e.message}`);
        }
        throw e;
      }
    }
    try {
      const r = await getRequirementsAgentView({ claimer_employee_id: employeeId }, { traceId });
      const recruiting = (r.items ?? []).filter(isRecruitingStatus);
      const matchable = recruiting.filter(hasMatchableContent);
      logger.info(
        `[${AGENT_NAME}] RAAS returned ${r.items?.length ?? 0} requirement(s); ` +
          `${recruiting.length} recruiting; ${matchable.length} matchable`,
      );
      return matchable;
    } catch (e) {
      if (e instanceof RaasApiError && e.isClientError) {
        throw new NonRetriableError(`getRequirementsAgentView 4xx: ${e.code} ${e.message}`);
      }
      throw e;
    }
  });

  if (requirements.length === 0) {
    return {
      ok: true,
      upload_id: uploadId,
      candidate_id: candidateId,
      employee_id: employeeId,
      requested_count: 0,
      reason: 'no-matchable-requirements',
    };
  }

  // 对每条 JR emit RULE_CHECK_REQUESTED
  // F1 (2026-05-19): RESUME_PROCESSED is now a thin event — no parsed.data inline.
  // If event payload doesn't have parsed.data, back-pull from RAAS.
  let parsedData: Record<string, unknown> | null =
    data.parsed && typeof data.parsed === 'object'
      ? ((data.parsed as Record<string, unknown>).data as Record<string, unknown> | undefined) ?? null
      : null;

  if (!parsedData) {
    // thin event path: back-pull parsed body from RAAS
    if (!candidateId || !resumeId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] thin RESUME_PROCESSED missing candidate_id or resume_id — cannot back-pull parsed`,
      );
    }
    parsedData = await step.run('fetch-parsed-resume', async () => {
      try {
        const r = await getParsedResume(candidateId, resumeId, { traceId });
        logger.info(
          `[${AGENT_NAME}] thin-event back-pull OK · candidate_id=${candidateId} ` +
            `resume_id=${resumeId} data_keys=${Object.keys(r.data ?? {}).length}`,
        );
        return r.data ?? {};
      } catch (e) {
        if (e instanceof RaasApiError && e.isClientError) {
          throw new NonRetriableError(
            `RAAS GET /candidates/${candidateId}/resumes/${resumeId}/parsed 4xx: ${e.code} ${e.message}`,
          );
        }
        throw e;
      }
    });
  }

  const bypass = process.env.RULE_CHECK_BYPASS === 'true';

  let requested = 0;
  for (const req of requirements) {
    const jrid = pickRequisitionId(req);
    if (!jrid) continue;
    const stepKey = sanitizeStepKey(jrid);

    if (bypass) {
      // RULE_CHECK_BYPASS=true: skip ruleCheckAgent, emit RULE_CHECK_PASSED directly.
      // matchResumeAgent's 2nd segment will pick it up and call RoboHire match.
      const bypassPayload: RuleCheckPassedData = {
        upload_id: uploadId ?? '',
        candidate_id: candidateId ?? '',
        resume_id: resumeId,
        job_requisition_id: jrid,
        client_id: pickClientId(req) ?? '',
        audit: {
          rules_evaluated: 0,
          graph_calls: 0,
          client_id: pickClientId(req) ?? '',
          business_group: null,
          studio: null,
          llm_model: 'bypass',
          llm_duration_ms: 0,
          llm_round_trips: 0,
          rule_source: 'json-fallback',
          fail_reason: 'bypassed',
        },
        job_requisition: req as unknown as Record<string, unknown>,
        parsed_resume: parsedData ?? null,
        runtime_context: {
          upload_id: uploadId ?? '',
          candidate_id: candidateId ?? '',
          resume_id: resumeId,
          employee_id: employeeId,
          filename: typeof data.filename === 'string' ? data.filename : undefined,
          received_at: typeof data.receivedAt === 'string' ? data.receivedAt : undefined,
          trace_id: traceId ?? null,
        },
        employee_id: employeeId,
      };
      await step.sendEvent(`emit-bypass-passed-${stepKey}`, {
        name: 'RULE_CHECK_PASSED',
        data: bypassPayload,
      });
      logger.info(
        `[${AGENT_NAME}] ⏭ RULE_CHECK_BYPASS=true · directly emit RULE_CHECK_PASSED for JR=${jrid}`,
      );
      requested += 1;
      continue;
    }

    const payload: RuleCheckRequestedData = {
      upload_id: uploadId ?? '',
      candidate_id: candidateId ?? '',
      resume_id: resumeId,
      employee_id: employeeId,
      job_requisition_id: jrid,
      client_id: pickClientId(req),
      job_requisition: req as unknown as Record<string, unknown>,
      parsed_resume: parsedData ?? null,
      runtime_context: {
        upload_id: uploadId ?? '',
        candidate_id: candidateId ?? '',
        resume_id: resumeId,
        employee_id: employeeId,
        filename: typeof data.filename === 'string' ? data.filename : undefined,
        received_at: typeof data.receivedAt === 'string' ? data.receivedAt : undefined,
        trace_id: traceId ?? null,
      },
      trace_id: traceId ?? null,
    };
    await step.sendEvent(`emit-rule-check-requested-${stepKey}`, {
      name: 'RULE_CHECK_REQUESTED',
      data: payload,
    });
    logger.info(`[${AGENT_NAME}] ✓ emitted RULE_CHECK_REQUESTED for JR=${jrid}`);
    requested += 1;
  }

  return {
    ok: true,
    upload_id: uploadId,
    candidate_id: candidateId,
    employee_id: employeeId,
    requested_count: requested,
  };
}

// ──────────────────────────────────────────────────────────────────────
// 第二段:RULE_CHECK_PASSED → RoboHire match → saveMatchResults → emit
// ──────────────────────────────────────────────────────────────────────

async function handleRuleCheckPassed({ event, step, logger }: any) {
  const data = event.data as RuleCheckPassedData;
  const traceId = data.runtime_context?.trace_id ?? undefined;
  const stepKey = sanitizeStepKey(data.job_requisition_id);
  const req = (data.job_requisition ?? {}) as RequirementsAgentViewItem;
  const candidateId = data.candidate_id ?? '';
  const uploadId = data.upload_id ?? '';

  if (!data.job_requisition || !data.parsed_resume) {
    logger.warn(
      `[${AGENT_NAME}] RULE_CHECK_PASSED missing job_requisition or parsed_resume for JR=${data.job_requisition_id} — cannot match`,
    );
    return { ok: false, job_requisition_id: data.job_requisition_id, error: 'missing-job-requisition-or-parsed-resume' };
  }

  const resumeText = buildResumeTextFromParsed(data.parsed_resume);
  const jdText = flattenRequirementForMatch(req);

  if (!resumeText.trim()) {
    throw new NonRetriableError(`[${AGENT_NAME}] resume text empty for JR ${data.job_requisition_id}`);
  }

  // 4a. 直连 RoboHire
  const matchResult = await step.run(`match-${stepKey}`, async () => {
    logger.info(
      `[${AGENT_NAME}] calling RoboHire /match-resume · jr=${data.job_requisition_id} ` +
        `jd_chars=${jdText.length} resume_chars=${resumeText.length}`,
    );
    try {
      const r = await matchResumeDirect({ resume: resumeText, jd: jdText }, { traceId: traceId ?? undefined });
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
    return { ok: false, job_requisition_id: data.job_requisition_id, error: matchResult.error };
  }

  // 4b. RAAS POST /match-results 持久化(保留)
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

  // 4c. emit MATCH_PASSED_NEED_INTERVIEW
  const payload: MatchPassedNeedInterviewData = {
    upload_id: uploadId,
    job_requisition_id: data.job_requisition_id,
    success: true,
    data: matchResult.data as unknown as Record<string, unknown>,
    requestId: matchResult.requestId,
    savedAs: matchResult.savedAs,
  };
  await step.sendEvent(`emit-match-${stepKey}`, { name: 'MATCH_PASSED_NEED_INTERVIEW', data: payload });

  logger.info(`[${AGENT_NAME}] ✅ emitted MATCH_PASSED_NEED_INTERVIEW · jr=${data.job_requisition_id}`);
  return { ok: true, job_requisition_id: data.job_requisition_id, requestId: matchResult.requestId };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function unwrapResumeProcessedEvent(raw: unknown): ResumeProcessedData & Record<string, any> {
  if (!raw || typeof raw !== 'object') return raw as ResumeProcessedData;
  const r = raw as Record<string, unknown>;
  if (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)) {
    return { ...(r.payload as Record<string, unknown>) } as unknown as ResumeProcessedData;
  }
  return raw as ResumeProcessedData;
}

function pickUploadId(data: any): string | null {
  for (const c of [data.upload_id, data.uploadId, data.etag, data.object_key, data.objectKey]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}
function pickCandidateId(data: any): string | null {
  if (typeof data.candidate_id === 'string' && data.candidate_id.trim()) return data.candidate_id.trim();
  return null;
}
function pickEmployeeId(data: any): string | null {
  for (const c of [data.claimer_employee_id, data.employee_id, data.employeeId, data.operator_id, process.env.RAAS_DEFAULT_EMPLOYEE_ID]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}
function pickRequisitionId(req: RequirementsAgentViewItem): string | null {
  for (const c of [(req as any).job_requisition_id, (req as any).requisition_id, (req as any).job_id, (req as any).id]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}
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
  if (Array.isArray(r.must_have_skills) && r.must_have_skills.length) lines.push(`\n必备技能:\n  - ${r.must_have_skills.join('\n  - ')}`);
  if (Array.isArray(r.nice_to_have_skills) && r.nice_to_have_skills.length) lines.push(`\n加分技能:\n  - ${r.nice_to_have_skills.join('\n  - ')}`);
  if (r.negative_requirement && r.negative_requirement !== '无') lines.push(`\n排除条件:\n${r.negative_requirement}`);
  if (r.job_responsibility) lines.push(`\n岗位职责:\n${r.job_responsibility}`);
  if (r.job_requirement) lines.push(`\n任职要求:\n${r.job_requirement}`);
  return lines.join('\n');
}
function hasMatchableContent(req: RequirementsAgentViewItem): boolean {
  const r = req as Record<string, any>;
  return !!(r.job_responsibility?.toString().trim() || r.job_requirement?.toString().trim() ||
    (Array.isArray(r.must_have_skills) && r.must_have_skills.length > 0));
}
function isRecruitingStatus(req: RequirementsAgentViewItem): boolean {
  const r = req as Record<string, any>;
  let raw: unknown = undefined;
  for (const c of [r.status, r.hc_status, r.requisition_status, r.spec_status, r.job_requisition_status]) {
    if (c != null && String(c).trim() !== '') { raw = c; break; }
  }
  if (raw === undefined) return true;
  const s = String(raw).toLowerCase().trim();
  return s === 'recruiting' || s === '招聘中' || s === 'active' || s === 'open';
}
function sanitizeStepKey(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
}
function getTraceId(eventData: unknown): string | undefined {
  if (!eventData || typeof eventData !== 'object') return undefined;
  const r = eventData as Record<string, any>;
  const t = r.trace;
  if (t && typeof t === 'object' && typeof t.trace_id === 'string' && t.trace_id) return t.trace_id;
  return undefined;
}
