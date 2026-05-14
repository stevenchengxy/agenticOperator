// Pipeline driver — 跑单个 scenario 端到端。
//
// 不通过 Inngest spawn agent,而是直接调 lib 函数,在 mock RAAS server 帮助下
// 模拟 agent 的 step 序列。这样:
//   - 测试到的业务逻辑跟 production 100% 一致(都用同一份 raas-api-client +
//     rule-check engine + projectResume)
//   - 不需要起 Inngest dev server / mock step infrastructure
//   - 跟 Inngest 编排 / retry 行为相关的代码不在测试范围(那是 Inngest 自己的事)
//
// 不改任何 workflow agent 源文件。

import { randomUUID } from 'node:crypto';

import {
  getRequirementDetail,
  matchResume,
  saveCandidate,
  saveMatchResults,
  type RaasMatchResumeData,
  type SaveCandidateInput,
} from '../../lib/raas-api-client';
import { buildRuleCheckInput, runRuleCheck } from '../../lib/rule-check';
import type { RuleCheckVerdict } from '../../lib/rule-check/types';

import { runRuleCheckStubbed } from './rule-check-stubbed';

import { candidateById, jdById, type Scenario } from './fixtures/scenarios';
import {
  Neo4jInstanceWriter,
  verdictToAuditFlags,
  type WriteAuditArgs,
  type WriteFlagArgs,
} from './neo4j-instance-writer';
import { writeRuleCheckAudit } from '../../lib/rule-check/neo4j-instance-writer';
import { getSeenCalls, type SeenCall } from './mock-raas-server';
import {
  clearTraces,
  getTracesByScenario,
  recordTrace,
  type TraceEvent,
} from './trace-collector';

export interface PipelineRunResult {
  scenario: Scenario;
  /** runtime context like RESUME_PROCESSED would carry */
  runtime: {
    upload_id: string;
    candidate_id: string;
    resume_id: string;
    employee_id: string;
  };
  /** rule-check 结果(包含 LLM raw output + verdict) */
  rule_check: RuleCheckVerdict;
  /** matchResume 是否被调用 + 它收到的 body */
  match_resume_call: { invoked: boolean; body?: { resume: string; jd: string }; response?: RaasMatchResumeData };
  /** saveMatchResults 是否被调用 */
  save_match_results_call: { invoked: boolean; body?: unknown };
  /** Neo4j 写入快照 */
  neo4j_written: { audit: WriteAuditArgs; flags: WriteFlagArgs[] } | null;
  /** 时间花费 */
  durations_ms: {
    save_candidate: number;
    fetch_requirement: number;
    rule_check: number;
    match_resume: number | null;
    save_match_results: number | null;
    neo4j_write: number;
    total: number;
  };
  /** AO 端调过 mock RAAS server 的所有 HTTP call(seenCalls 在 mock 服务里, snapshot 一份) */
  seen_raas_calls: SeenCall[];
  /** End-to-end trace events,跨 RAAS API / LLM / Neo4j 用 trace_id 关联 */
  trace_events: TraceEvent[];
  /** Trace id, 端到端关联键 */
  trace_id: string;
  /** 总错误(如果 throw 了) */
  error?: string;
}

// ─── Helpers ───

function flattenResumeText(parsed: Record<string, unknown> | undefined | null): string {
  if (!parsed) return '';
  if (typeof parsed === 'string') return parsed;
  return JSON.stringify(parsed, null, 2);
}

function flattenJdForMatch(jr: Record<string, unknown>): string {
  // 跟 server/inngest/agents/match-resume-agent.ts 的 flattenRequirementForMatch
  // 行为对齐(简化版,够 mock 用)。
  const r = jr as Record<string, unknown>;
  const lines: string[] = [];
  if (r.client_job_title) lines.push(`职位: ${r.client_job_title}`);
  if (r.work_years != null) lines.push(`工作年限: ${r.work_years} 年`);
  if (r.degree_requirement) lines.push(`学历要求: ${r.degree_requirement}`);
  if (Array.isArray(r.must_have_skills) && r.must_have_skills.length)
    lines.push(`必备技能: ${(r.must_have_skills as string[]).join(', ')}`);
  if (Array.isArray(r.nice_to_have_skills) && r.nice_to_have_skills.length)
    lines.push(`加分技能: ${(r.nice_to_have_skills as string[]).join(', ')}`);
  if (r.job_responsibility) lines.push(`\n岗位职责:\n${r.job_responsibility}`);
  if (r.job_requirement) lines.push(`\n任职要求:\n${r.job_requirement}`);
  return lines.join('\n');
}

// ─── Main driver ───

export async function runOneScenario(args: {
  scenario: Scenario;
  run_id: string;
  neo4j: Neo4jInstanceWriter;
  /** false → skip rule-check entirely(对照组,验证 gate-off 行为) */
  rule_check_enabled: boolean;
  /** 'real' → 调真实 LLM(走 runRuleCheck);'stub' → deterministic stub */
  llm_mode: 'real' | 'stub';
}): Promise<PipelineRunResult> {
  const { scenario, run_id, neo4j, rule_check_enabled, llm_mode } = args;
  const candidate = candidateById(scenario.candidate_id);
  const jd = jdById(scenario.jd_id);

  // 端到端 trace_id — 模拟 raas envelope.trace.trace_id
  const trace_id = `trace_${run_id.slice(-8)}_${scenario.id.slice(0, 6)}_${randomUUID().slice(0, 6)}`;
  recordTrace({
    hop: 'event-emit',
    trace_id,
    scenario_id: scenario.id,
    message: `[raas-mock] emit RESUME_DOWNLOADED envelope candidate=${scenario.candidate_id} jd=${scenario.jd_id}`,
    metadata: { event: 'RESUME_DOWNLOADED' },
  });

  const t0 = Date.now();
  const result: PipelineRunResult = {
    scenario,
    runtime: {
      upload_id: `upl_${scenario.id}_${randomUUID().slice(0, 6)}`,
      candidate_id: '',
      resume_id: '',
      employee_id: 'EMP_TEST_001',
    },
    rule_check: null as unknown as RuleCheckVerdict,
    match_resume_call: { invoked: false },
    save_match_results_call: { invoked: false },
    neo4j_written: null,
    durations_ms: {
      save_candidate: 0,
      fetch_requirement: 0,
      rule_check: 0,
      match_resume: null,
      save_match_results: null,
      neo4j_write: 0,
      total: 0,
    },
    seen_raas_calls: [],
    trace_events: [],
    trace_id,
  };

  try {
    // ═══ Step A: 模拟 resumeParserAgent 的 saveCandidate ═══
    const tA = Date.now();
    const saveCandidateInput: SaveCandidateInput = {
      upload_id: result.runtime.upload_id,
      bucket: 'recruit-resume-raw',
      object_key: `2026/05/${result.runtime.upload_id}.pdf`,
      etag: `etag_${randomUUID().slice(0, 8)}`,
      mime_type: 'application/pdf',
      file_size: 380_000,
      original_filename: `${scenario.candidate_id}.pdf`,
      operator_employee_id: 'EMP_TEST_001',
      operator_id: 'op_test',
      client_id: jd.jr.client_id as string,
      job_requisition_id: jd.jr.job_requisition_id,
      parsed: candidate.resume as unknown as Record<string, unknown> as never, // RaasParseResumeData 类型
    };
    recordTrace({
      hop: 'raas-api-call',
      trace_id,
      scenario_id: scenario.id,
      message: `POST /api/v1/candidates upload=${result.runtime.upload_id}`,
    });
    const saveCandidateRes = await saveCandidate(saveCandidateInput);
    result.runtime.candidate_id = saveCandidateRes.candidate_id;
    result.runtime.resume_id = saveCandidateRes.resume_id ?? `R_${randomUUID().slice(0, 6)}`;
    result.durations_ms.save_candidate = Date.now() - tA;
    recordTrace({
      hop: 'raas-api-resp',
      trace_id,
      scenario_id: scenario.id,
      message: `candidate_id=${result.runtime.candidate_id} resume_id=${result.runtime.resume_id}`,
    });

    // ═══ Step B: 模拟 matchResumeAgent fetch requirement ═══
    recordTrace({
      hop: 'event-emit',
      trace_id,
      scenario_id: scenario.id,
      message: `[ao] emit RESUME_PROCESSED candidate=${result.runtime.candidate_id} jr=${jd.jr.job_requisition_id}`,
    });
    const tB = Date.now();
    recordTrace({
      hop: 'raas-api-call',
      trace_id,
      scenario_id: scenario.id,
      message: `GET /api/v1/requirements/${jd.jr.job_requisition_id}`,
    });
    const reqDetail = await getRequirementDetail(jd.jr.job_requisition_id);
    result.durations_ms.fetch_requirement = Date.now() - tB;

    // ═══ Step C: rule check ═══
    let augmentation: string | undefined;
    if (rule_check_enabled) {
      const tC = Date.now();
      const ruleCheckInput = buildRuleCheckInput({
        runtime_context: {
          upload_id: result.runtime.upload_id,
          candidate_id: result.runtime.candidate_id,
          resume_id: result.runtime.resume_id,
          employee_id: result.runtime.employee_id,
          filename: saveCandidateInput.original_filename,
          received_at: new Date().toISOString(),
          trace_id: null,
        },
        parsed_resume: candidate.resume as unknown as Record<string, unknown>,
        job_requisition: reqDetail.requirement as unknown as Record<string, unknown>,
        job_requisition_specification: (reqDetail.specification ?? null) as unknown as
          | Record<string, unknown>
          | null,
        hsm_feedback: null,
      });
      recordTrace({
        hop: 'rule-fetch',
        trace_id,
        scenario_id: scenario.id,
        message: `fetch rules from Neo4j (client=${jd.jr.client_id} bg=${jd.jr.client_business_group ?? jd.jr.client_department_id ?? 'unk'})`,
      });
      recordTrace({
        hop: 'llm-call',
        trace_id,
        scenario_id: scenario.id,
        message: `LLM call (mode=${llm_mode}) — compose prompt + send`,
      });
      const verdict =
        llm_mode === 'stub'
          ? await runRuleCheckStubbed(ruleCheckInput)
          : await runRuleCheck(ruleCheckInput);
      result.rule_check = verdict;
      result.durations_ms.rule_check = Date.now() - tC;
      recordTrace({
        hop: 'llm-response',
        trace_id,
        scenario_id: scenario.id,
        message: `model=${verdict.audit.llm_model} latency=${verdict.audit.llm_duration_ms}ms tokens=${verdict.audit.llm_prompt_tokens ?? '?'}/${verdict.audit.llm_completion_tokens ?? '?'}`,
      });
      recordTrace({
        hop: 'verdict',
        trace_id,
        scenario_id: scenario.id,
        message: `decision=${verdict.decision} llm_decision=${verdict.llm_decision} rules_evaluated=${verdict.audit.rules_evaluated}/${verdict.audit.rules_total_in_ontology} failures=${verdict.failure_reasons.join(',') || 'none'}`,
      });

      // Kenny §3:KEEP 路径 augmentation 注入
      if (
        verdict.decision === 'PASS' &&
        verdict.resume_augmentation &&
        process.env.RULE_CHECK_AUGMENT_RESUME !== 'false'
      ) {
        augmentation = verdict.resume_augmentation;
      }

      // Neo4j 写 — 走 production writer 单一路径,自动写 audit + flags +
      // :Candidate / :Resume / :JobRequisition 实例锚节点 + 全部关系
      const tNeo = Date.now();
      await writeRuleCheckAudit({
        verdict,
        context: {
          run_id,
          scenario_id: scenario.id, // test 专用,production 不传
          upload_id: result.runtime.upload_id,
          candidate_id: result.runtime.candidate_id,
          resume_id: result.runtime.resume_id,
          job_requisition_id: jd.jr.job_requisition_id,
          trace_id,
          parsed_resume: candidate.resume as unknown as Record<string, unknown>,
          job_requisition: jd.jr as unknown as Record<string, unknown>,
        },
      });
      // 仍把 audit/flags 反射出来给 reporter 用 — 用 test helper 构造一份
      const { audit, flags } = verdictToAuditFlags(verdict, {
        run_id,
        scenario_id: scenario.id,
        candidate_id: result.runtime.candidate_id,
        job_requisition_id: jd.jr.job_requisition_id,
        upload_id: result.runtime.upload_id,
        resume_id: result.runtime.resume_id,
      });
      result.neo4j_written = { audit, flags };
      result.durations_ms.neo4j_write = Date.now() - tNeo;
      recordTrace({
        hop: 'neo4j-write',
        trace_id,
        scenario_id: scenario.id,
        message: `wrote RuleCheckAudit ${audit.audit_id} + ${flags.length} flags + :Candidate / :Resume / :JR anchors`,
      });
      recordTrace({
        hop: 'event-emit',
        trace_id,
        scenario_id: scenario.id,
        message: `[ao] emit RULE_CHECK_${verdict.decision === 'PASS' ? 'PASSED' : 'FAILED'} reasons=${verdict.failure_reasons.join(',') || 'none'}`,
      });
    } else {
      // gate 关闭:构造一个伪 verdict 占位(audit 字段空,decision='PASS' 让流程继续)
      result.rule_check = {
        decision: 'PASS',
        llm_decision: 'KEEP',
        failure_reasons: [],
        hit_flags: [],
        llm_output: null,
        audit: {
          rules_evaluated: 0,
          rules_total_in_ontology: 0,
          dims: { client_id: '', business_group: null, studio: null },
          llm_model: '(gate disabled)',
          llm_duration_ms: 0,
          raw_text_preview: '',
        },
      };
    }

    // ═══ Step D: matchResume(只在 PASS 时调) ═══
    if (result.rule_check.decision === 'PASS') {
      const resumeText = flattenResumeText(candidate.resume as unknown as Record<string, unknown>);
      const augmentedResume = augmentation
        ? `${augmentation}\n\n---\n\n${resumeText}`
        : resumeText;
      const jdText = flattenJdForMatch(reqDetail.requirement as unknown as Record<string, unknown>);

      recordTrace({
        hop: 'augment',
        trace_id,
        scenario_id: scenario.id,
        message: augmentation
          ? `injecting "## Rule Check Annotations" prefix (${augmentation.length} chars) into Robohire resume`
          : 'no augmentation (LLM did not produce or env disabled)',
      });
      recordTrace({
        hop: 'raas-api-call',
        trace_id,
        scenario_id: scenario.id,
        message: `POST /api/v1/match-resume (→ Robohire via raas) resume_chars=${augmentedResume.length}`,
      });
      const tD = Date.now();
      const mr = await matchResume({ resume: augmentedResume, jd: jdText });
      result.match_resume_call = {
        invoked: true,
        body: { resume: augmentedResume, jd: jdText },
        response: mr.data,
      };
      result.durations_ms.match_resume = Date.now() - tD;
      recordTrace({
        hop: 'raas-api-resp',
        trace_id,
        scenario_id: scenario.id,
        message: `matchScore=${(mr.data as { matchScore?: number })?.matchScore ?? '?'} requestId=${mr.requestId}`,
      });

      // Step E: save match results
      const tE = Date.now();
      const smr = await saveMatchResults({
        ...(mr.data as Record<string, unknown>),
        source: 'need_interview',
        candidate_id: result.runtime.candidate_id,
        upload_id: result.runtime.upload_id,
        job_requisition_id: jd.jr.job_requisition_id,
        client_id: jd.jr.client_id as string,
        robohire_request_id: mr.requestId,
        savedAs: mr.savedAs,
      });
      result.save_match_results_call = { invoked: true, body: { source: 'need_interview' } };
      result.durations_ms.save_match_results = Date.now() - tE;
      void smr; // 不用,只是确认不抛
    }
  } catch (err) {
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    recordTrace({
      hop: 'note',
      trace_id,
      scenario_id: scenario.id,
      message: `ERROR: ${result.error}`,
    });
  } finally {
    result.durations_ms.total = Date.now() - t0;
    result.seen_raas_calls = getSeenCalls();
    result.trace_events = getTracesByScenario(scenario.id);
  }

  return result;
}

export { clearTraces };
