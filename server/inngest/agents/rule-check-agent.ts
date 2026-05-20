// ruleCheckAgent — Workflow node 10-1 (`ruleCheckForMatchResume`).
//
// 2026-05-19 consolidation: 吸收原 matchResumeAgent 第一段。直接订阅
// `RESUME_PROCESSED` 后,本函数承担:
//   1. F1 — parsed.data 缺失时回拉 RAAS GET /candidates/:id/resumes/:rid/parsed
//   2. JR 列表收敛 —
//      - 路径 A (event.job_requisition_id 存在) → GET /requirements/:id
//      - 路径 B → GET /requirements/agent-view?claimer=&resume_filename= (F2)
//   3. for each JR:
//      - runRuleCheck(Ontology + Neo4j + LLM,fail-safe in-band)
//      - RAAS POST /match-results 写 rule_check_*(actions JSON 10-1 side-effect)
//      - PASS → emit MATCH_RULE_CHECK_PASSED (carries jr + parsed)
//      - FAIL/REVIEW → emit MATCH_RULE_CHECK_FAILED (F3 平铺 payload)
//
// 重派场景:partner 直接重发 `RESUME_PROCESSED`(带新 `job_requisition_id`),
// 本函数走路径 A,无任何额外订阅或代码改动。
//
// 见 docs/superpowers/specs/2026-05-19-rule-check-consolidation-design.md

import { NonRetriableError } from 'inngest';
import { buildRuleCheckInput, runRuleCheck } from '@/lib/rule-check';
import { extractDims } from '@/lib/rule-check/ontology';
import {
  RaasApiError,
  getRequirementDetail,
  getRequirementsAgentView,
  getParsedResume,
  isRaasApiConfigured,
  type RequirementsAgentViewItem,
} from '@/lib/raas-api-client';
import {
  inngest,
  type MatchEventData,
  type MatchRuleCheckPassedData,
  type RuleCheckAuditMeta,
  type RuleCheckRuntimeContext,
} from '@/server/inngest/client';
import { prisma } from '@/server/db';
import { writeInstance, AllmetaApiError } from '@/lib/allmeta-client';

const AGENT_ID = 'rule-check-agent';
const AGENT_NAME = 'ruleCheck';

// Exported separately so it can be unit-tested without a live Inngest runtime.
export async function ruleCheckAgentHandler({
  event,
  step,
  logger,
}: {
  event: { name: string; data: unknown };
  step: {
    run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
    sendEvent: (id: string, e: { name: string; data: unknown }) => Promise<unknown>;
  };
  logger: { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void };
}) {
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
    `[${AGENT_NAME}] received ${event.name} · upload_id=${uploadId ?? '—'} ` +
      `candidate_id=${candidateId ?? '—'} employee_id=${employeeId}`,
  );

  const linkedJrId =
    typeof data.job_requisition_id === 'string' && data.job_requisition_id.trim().length > 0
      ? data.job_requisition_id.trim()
      : null;

  // ── 1. JR 列表收敛 ──
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
          throw new NonRetriableError(
            `getRequirementDetail 4xx for ${linkedJrId}: ${e.code} ${e.message}`,
          );
        }
        throw e;
      }
    }
    try {
      const resumeFilenameRaw =
        typeof data.filename === 'string' && data.filename.trim()
          ? data.filename.trim()
          : undefined;
      if (resumeFilenameRaw) {
        logger.info(`[${AGENT_NAME}] path-B agent-view with resume_filename="${resumeFilenameRaw}"`);
      }
      const r = await getRequirementsAgentView(
        { claimer_employee_id: employeeId, resume_filename: resumeFilenameRaw },
        { traceId },
      );
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

  // ── 2. F1 — parsed.data 缺失时回拉 ──
  let parsedData: Record<string, unknown> | null =
    data.parsed && typeof data.parsed === 'object'
      ? ((data.parsed as Record<string, unknown>).data as Record<string, unknown> | undefined) ??
        null
      : null;

  if (!parsedData) {
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
  let passed = 0;
  let failed = 0;

  // ── 3. for each JR: runRuleCheck → persist → emit ──
  for (const req of requirements) {
    const jrid = pickRequisitionId(req);
    if (!jrid) continue;
    const stepKey = sanitize(jrid);
    const clientId = pickClientId(req) ?? '';

    const runtimeContext: RuleCheckRuntimeContext = {
      upload_id: uploadId ?? '',
      candidate_id: candidateId ?? '',
      resume_id: resumeId,
      employee_id: employeeId,
      filename: typeof data.filename === 'string' ? data.filename : undefined,
      received_at: typeof data.receivedAt === 'string' ? data.receivedAt : undefined,
      trace_id: traceId ?? null,
    };

    if (bypass) {
      const bypassAudit: RuleCheckAuditMeta = {
        rules_evaluated: 0,
        graph_calls: 0,
        client_id: clientId,
        business_group: null,
        studio: null,
        llm_model: 'bypass',
        llm_duration_ms: 0,
        llm_round_trips: 0,
        rule_source: 'json-fallback',
        fail_reason: 'bypassed',
      };
      const bypassPayload: MatchRuleCheckPassedData = {
        upload_id: uploadId ?? null,
        candidate_id: candidateId ?? null,
        resume_id: resumeId || null,
        job_requisition_id: jrid,
        client_id: clientId,
        employee_id: employeeId,
        audit: bypassAudit,
        job_requisition: req as unknown as Record<string, unknown>,
        parsed_resume: parsedData ?? null,
        runtime_context: runtimeContext,
      };
      await step.sendEvent(`emit-bypass-passed-${stepKey}`, {
        name: 'MATCH_RULE_CHECK_PASSED',
        data: bypassPayload,
      });
      logger.info(
        `[${AGENT_NAME}] ⏭ RULE_CHECK_BYPASS=true · directly emit MATCH_RULE_CHECK_PASSED for JR=${jrid}`,
      );
      passed += 1;
      continue;
    }

    const result = await step.run(`rule-check-${stepKey}`, async () => {
      const input = buildRuleCheckInput({
        runtime_context: runtimeContext,
        parsed_resume: parsedData,
        job_requisition: req as unknown as Record<string, unknown>,
      });
      const r = await runRuleCheck(input);
      logger.info(
        `[${AGENT_NAME}] jr=${jrid} decision=${r.decision} ` +
          `stats=pass:${r.stats.pass}/fail:${r.stats.fail}/pending:${r.stats.pending}/info:${r.stats.insufficient_info} ` +
          `rules=${r.audit.rules_evaluated} graph_calls=${r.audit.graph_calls} ` +
          `model=${r.audit.llm_model} latency_ms=${r.audit.llm_duration_ms} ` +
          `tool_rounds=${r.audit.llm_round_trips}` +
          (r.audit.fail_reason ? ` fail_reason=${r.audit.fail_reason}` : ''),
      );
      return r;
    });

    const dims = extractDims(req as unknown as Record<string, unknown>);
    const audit: RuleCheckAuditMeta = {
      rules_evaluated: result.audit.rules_evaluated,
      graph_calls: result.audit.graph_calls,
      client_id: dims.client_id,
      business_group: dims.business_group,
      studio: dims.studio,
      llm_model: result.audit.llm_model,
      llm_duration_ms: result.audit.llm_duration_ms,
      llm_round_trips: result.audit.llm_round_trips,
      llm_prompt_tokens: result.audit.llm_prompt_tokens,
      llm_completion_tokens: result.audit.llm_completion_tokens,
      rule_source: result.audit.rule_source,
      fail_reason: result.audit.fail_reason,
    };

    // ★ Wire audit into Prisma so /rule-check UI gets live data
    //   (the page reads from prisma.ruleCheckAudit via /api/rule-check-audits;
    //    before this hook the table only had stale 2026-05-15 fixtures).
    //   Soft-fail: write errors don't break the rule-check flow.
    const auditWriteResult = await step.run(`write-audit-${stepKey}`, async () => {
      const auditId = `rca_${runtimeContext.trace_id ?? 'no-trace'}_${stepKey.slice(0, 50)}_${Date.now()}`;
      try {
        await prisma.ruleCheckAudit.create({
          data: {
            audit_id: auditId,
            run_id: runtimeContext.trace_id ?? auditId,
            trace_id: runtimeContext.trace_id ?? null,
            upload_id: uploadId ?? '',
            candidate_id: candidateId ?? '',
            resume_id: resumeId || '',
            job_requisition_id: jrid,
            client_name: dims.client_id || null,
            business_group: dims.business_group ?? null,
            studio: dims.studio ?? null,
            // Policy 2026-05-20: 信息缺失/REVIEW 都放行,只有真违反才 FAIL。
            // foldDecision 已经把 insufficient_info 折成 PASS;REVIEW 表示需要
            // HSM 人工复核,但流程不阻断 — audit decision 仍记 'PASS' 让 UI 不显失败。
            decision: result.decision === 'FAIL' ? 'FAIL' : 'PASS',
            llm_decision: result.decision,
            failure_reasons: JSON.stringify(
              result.explanations
                .filter((e) => e.status === 'fail')
                .map((e) => `${e.rule_id}:${(e.reason ?? '').slice(0, 240)}`),
            ),
            llm_model: result.audit.llm_model,
            llm_duration_ms: Math.round(result.audit.llm_duration_ms ?? 0),
            llm_prompt_tokens: result.audit.llm_prompt_tokens ?? null,
            llm_completion_tokens: result.audit.llm_completion_tokens ?? null,
            rules_evaluated: result.audit.rules_evaluated ?? 0,
            rules_total_in_ontology: result.audit.rules_evaluated ?? 0,
            rule_source: result.audit.rule_source ?? 'unknown',
            partial_resume_fields: '[]',
            parsed_resume_json: parsedData
              ? JSON.stringify(parsedData).slice(0, 200_000)
              : null,
            job_requisition_json: req
              ? JSON.stringify(req).slice(0, 200_000)
              : null,
          },
        });
        logger.info(`[${AGENT_NAME}] ✓ wrote RuleCheckAudit ${auditId} decision=${result.decision}`);
        return { ok: true, auditId };
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        logger.warn(`[${AGENT_NAME}] write-audit failed jr=${jrid}: ${msg.slice(0, 240)}`);
        return { ok: false, error: msg.slice(0, 240) };
      }
    });

    // ★ actions JSON 10-1 side_effect: write Candidate_Match_Result instance
    //   to Neo4j via Allmeta Ontology API. rule_check_result / rule_check_reason
    //   are property-bag additions (not in the 8-field schema, allowed by API).
    //   PK convention: cmr_<candidate>_<jr>  (one row per (candidate, JR) pair).
    //   Soft-fail: write errors don't block emit downstream.
    await step.run(`write-cmr-${stepKey}`, async () => {
      const cmrId = `cmr_${candidateId || 'unknown'}_${jrid}`;
      // Only true violations (decision='FAIL') get 未通过. REVIEW (rules
      // explicitly need HSM judgment) folds to 通过 with a note in reason —
      // the workflow continues, human reviews via /rule-check UI.
      const ruleCheckResult = result.decision === 'FAIL' ? '未通过' : '通过';
      const ruleCheckReason =
        result.decision === 'FAIL'
          ? result.explanations
              .filter((e) => e.status === 'fail')
              .map((e) => `[${e.rule_id}] ${e.rule_name}: ${e.reason ?? ''}`)
              .join(' | ')
              .slice(0, 1000)
          : result.decision === 'REVIEW'
            ? '待人工复核:' + result.explanations
                .filter((e) => e.status === 'pending')
                .map((e) => `[${e.rule_id}] ${e.rule_name}`)
                .join(', ')
                .slice(0, 1000)
            : '';
      try {
        await writeInstance('Candidate_Match_Result', {
          candidate_match_result_id: cmrId,
          client_id: clientId || '',
          candidate_id: candidateId || '',
          job_position_id: jrid,
          rule_check_result: ruleCheckResult,
          rule_check_reason: ruleCheckReason,
        });
        logger.info(
          `[${AGENT_NAME}] ✓ wrote Candidate_Match_Result ${cmrId} rule_check_result=${ruleCheckResult}`,
        );
        return { ok: true, cmrId };
      } catch (e) {
        const msg =
          e instanceof AllmetaApiError ? `${e.status} ${e.message}` : (e as Error).message;
        logger.warn(`[${AGENT_NAME}] write-cmr failed jr=${jrid}: ${msg.slice(0, 240)}`);
        return { ok: false, error: msg.slice(0, 240) };
      }
    });

    // Policy 2026-05-20: 信息缺失放行,只有违反才 FAIL。
    // PASS + REVIEW 都进 MATCH_RULE_CHECK_PASSED 路径 — 流程继续,REVIEW
    // 案例通过 /rule-check UI + Candidate_Match_Result.rule_check_reason
    // 给到 HSM 复核。
    if (result.decision !== 'FAIL') {
      const payload: MatchRuleCheckPassedData = {
        upload_id: uploadId ?? null,
        candidate_id: candidateId ?? null,
        resume_id: resumeId || null,
        job_requisition_id: jrid,
        client_id: clientId,
        employee_id: employeeId,
        audit,
        job_requisition: req as unknown as Record<string, unknown>,
        parsed_resume: parsedData ?? null,
        runtime_context: runtimeContext,
      };
      await step.sendEvent(`emit-passed-${stepKey}`, {
        name: 'MATCH_RULE_CHECK_PASSED',
        data: payload,
      });
      logger.info(`[${AGENT_NAME}] ✓ emitted MATCH_RULE_CHECK_PASSED for JR=${jrid}`);
      passed += 1;
    } else {
      const failedPayload: MatchEventData = {
        job_requisition_id: jrid,
        candidate_id: candidateId || null,
        matching_score: null,
        upload_id: uploadId || null,
        success: false,
        data: {
          rule_check_decision: result.decision,
          failed_rules: result.explanations.map((e) => ({
            rule_id: e.rule_id,
            rule_name: e.rule_name,
            step_id: e.step_id,
            status: e.status,
            reason: e.reason,
          })),
          audit,
        },
        error: `rule-check-${result.decision.toLowerCase()}`,
      };
      // Rule-check FAIL/REVIEW → emit MATCH_RULE_CHECK_FAILED (distinct from
      // matchResume 自身的 MATCH_FAILED 低分淘汰).  Reverted from short-lived
      // Plan B unification (2026-05-19) per team review — keeping the
      // separate event preserves semantic distinction in audits and lets
      // partner dispatchers route differently if they choose.
      await step.sendEvent(`emit-failed-${stepKey}`, {
        name: 'MATCH_RULE_CHECK_FAILED',
        data: failedPayload,
      });
      logger.info(
        `[${AGENT_NAME}] ✗ emitted MATCH_RULE_CHECK_FAILED for JR=${jrid} (${result.decision})`,
      );
      failed += 1;
    }
  }

  return {
    ok: true,
    upload_id: uploadId,
    candidate_id: candidateId,
    employee_id: employeeId,
    requested_count: requirements.length,
    passed,
    failed,
  };
}

export const ruleCheckAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Rule Check Agent (workflow node 10-1)',
    retries: 1,
    triggers: [{ event: 'RESUME_PROCESSED' }],
  },
  async (ctx) => ruleCheckAgentHandler(ctx as unknown as Parameters<typeof ruleCheckAgentHandler>[0]),
);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function unwrapResumeProcessedEvent(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, any>;
  if (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)) {
    return { ...(r.payload as Record<string, any>) };
  }
  return r;
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
  for (const c of [
    data.claimer_employee_id,
    data.employee_id,
    data.employeeId,
    data.operator_id,
    process.env.RAAS_DEFAULT_EMPLOYEE_ID,
  ]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function pickRequisitionId(req: RequirementsAgentViewItem): string | null {
  for (const c of [
    (req as any).job_requisition_id,
    (req as any).requisition_id,
    (req as any).job_id,
    (req as any).id,
  ]) {
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

function hasMatchableContent(req: RequirementsAgentViewItem): boolean {
  const r = req as Record<string, any>;
  return !!(
    r.job_responsibility?.toString().trim() ||
    r.job_requirement?.toString().trim() ||
    (Array.isArray(r.must_have_skills) && r.must_have_skills.length > 0)
  );
}

function isRecruitingStatus(req: RequirementsAgentViewItem): boolean {
  const r = req as Record<string, any>;
  let raw: unknown = undefined;
  for (const c of [r.status, r.hc_status, r.requisition_status, r.spec_status, r.job_requisition_status]) {
    if (c != null && String(c).trim() !== '') {
      raw = c;
      break;
    }
  }
  if (raw === undefined) return true;
  const s = String(raw).toLowerCase().trim();
  return s === 'recruiting' || s === '招聘中' || s === 'active' || s === 'open';
}

function getTraceId(eventData: unknown): string | undefined {
  if (!eventData || typeof eventData !== 'object') return undefined;
  const r = eventData as Record<string, any>;
  const t = r.trace;
  if (t && typeof t === 'object' && typeof t.trace_id === 'string' && t.trace_id) {
    return t.trace_id;
  }
  return undefined;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
}

