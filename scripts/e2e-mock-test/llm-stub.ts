// Deterministic LLM stub — 在真实 LLM gateway 不可达时占位,让 pipeline / Neo4j /
// augmentation 管道仍能 e2e 验证。
//
// 怎么工作:
//   - 解析 user prompt 中 §2 INPUTS 块拿到 candidate_id + jr_id(从 prompt
//     header 中的 _derived_dimensions 拿 client_id;candidate.name 拿到候选人)
//   - 根据 fixture 里 expected verdict 直接构造 LLM 输出:
//     * applicable=true 的规则:把 rule_id 标 PASS 或 FAIL/REVIEW 取决于
//       fixture 期望
//     * evidence 引用 candidate.resume 里能命中的字段值(让 verifier grep 能过)
//
// 真实 LLM 来后这个 stub 用 mock(or feature flag 关掉)即可。

import type { LlmRuleCheckOutput, RuleFlag, RuleCheckInput } from '../../lib/rule-check/types';
import { SCENARIOS, candidateById, jdById } from './fixtures/scenarios';
import { classifyRules } from '../../lib/rule-check/ontology';
import { extractDims } from '../../lib/rule-check/ontology';
import { filterRules } from '../../lib/rule-check/ontology';

// ─── Stub 入口 ───
//
// 跟 runLlm() 一样的签名,返回伪 LlmRunResult。

export interface StubLlmResult {
  model_used: string;
  duration_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  raw_text: string;
  parsed_json: unknown;
  parse_error?: string;
}

/**
 * 基于 user prompt 内 candidate_id 反查 fixture,按 expected 构造输出。
 * 找不到 candidate_id (e.g. partial prompt) → 返回 KEEP 全 PASS。
 */
export async function stubLlmCall(args: { system: string; user: string }): Promise<StubLlmResult> {
  // 从 prompt 里抠 candidate_id 字符串(prompt 含 INPUTS §2.1 runtime_context 的 JSON)
  const candidateId = pickFirstMatch(args.user, /"candidate_id"\s*:\s*"([^"]+)"/);
  const jobReqId = pickFirstMatch(args.user, /"job_requisition_id"\s*:\s*"([^"]+)"/);

  let scenario = findScenarioByIds(candidateId, jobReqId);
  if (!scenario) {
    // 没匹配到 fixture(可能 candidate_id 是 mock RAAS 返回的 C_xxxx),
    // 用 prompt 里的 resume.name 反查
    const candidateName = pickFirstMatch(args.user, /"name"\s*:\s*"([^"]+)"/);
    if (candidateName) {
      scenario = SCENARIOS.find(
        (s) => candidateById(s.candidate_id).resume.name === candidateName,
      ) ?? null;
    }
  }

  // 把 prompt 里的 dims 反推出来(prompt 里有 _derived_dimensions JSON 字段)
  const clientId = pickFirstMatch(args.user, /"client_id"\s*:\s*"([^"]+)"/);
  const businessGroup = pickFirstMatch(args.user, /"business_group"\s*:\s*"([^"]+)"/) || null;
  const studio = pickFirstMatch(args.user, /"studio"\s*:\s*"([^"]+)"/) || null;

  // 用 ontology 过滤实际 applicable 的规则集
  const dims = {
    client_id: clientId || '',
    business_group: businessGroup,
    studio,
  };
  const { rules: applicable } = filterRules(dims);
  classifyRules(applicable);

  // 如果反查到 scenario,按其 expected 构造输出;否则默认 PASS / 全 PASS
  const expected = scenario?.expected ?? {
    decision: 'PASS' as const,
    llm_decision: 'PASS' as const,
    must_fail_rule_ids: [] as string[],
    must_pass_rule_ids: [] as string[],
    must_have_augmentation: true,
    rationale: '',
  };

  const candidate = scenario ? candidateById(scenario.candidate_id) : null;
  const candResume = candidate?.resume as Record<string, unknown> | undefined;

  const output = synthesizeOutput({
    applicable,
    expected,
    parsedResume: candResume,
    jobReqId: jobReqId || jdById(scenario?.jd_id ?? 'jr-tencent-pcg-frontend').jr.job_requisition_id,
    clientId: dims.client_id,
  });

  return {
    model_used: 'stub:deterministic',
    duration_ms: 10,
    prompt_tokens: estimateTokens(args.user),
    completion_tokens: estimateTokens(JSON.stringify(output)),
    raw_text: JSON.stringify(output),
    parsed_json: output,
  };
}

// ─── helpers ───

function pickFirstMatch(s: string, re: RegExp): string | undefined {
  const m = re.exec(s);
  return m?.[1];
}

function findScenarioByIds(candidateId?: string, jobReqId?: string) {
  if (!candidateId && !jobReqId) return null;
  // candidate_id 可能是 fixture id ("c01-..." 走 buildRuleCheckInput) 或 mock
  // 返回的 C_xxx —— 反查只看 fixture id
  if (candidateId?.startsWith('c0')) {
    return SCENARIOS.find((s) => s.candidate_id === candidateId) ?? null;
  }
  return null;
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.5);
}

interface SynthArgs {
  applicable: ReadonlyArray<{ id: string; businessLogicRuleName: string; severity: string; applicableClient: string }>;
  expected: {
    decision: 'PASS' | 'FAIL';
    llm_decision: 'PASS' | 'FAIL' | 'KEEP' | 'DROP' | 'PAUSE';
    must_fail_rule_ids: string[];
    must_pass_rule_ids: string[];
    must_have_augmentation: boolean;
  };
  parsedResume?: Record<string, unknown>;
  jobReqId: string;
  clientId: string;
}

function synthesizeOutput(a: SynthArgs): LlmRuleCheckOutput {
  const ruleFlags: RuleFlag[] = a.applicable.map((r) => {
    const isMustFail = a.expected.must_fail_rule_ids.includes(r.id);
    const isMustPass = a.expected.must_pass_rule_ids.includes(r.id);
    const result: RuleFlag['result'] = isMustFail
      ? a.expected.llm_decision === 'DROP'
        ? 'FAIL'
        : 'REVIEW'
      : 'PASS';
    const next_action: RuleFlag['next_action'] = isMustFail
      ? a.expected.llm_decision === 'DROP'
        ? 'block'
        : 'pause'
      : 'continue';
    return {
      rule_id: r.id,
      rule_name: r.businessLogicRuleName,
      applicable_client: r.applicableClient,
      severity: r.severity as RuleFlag['severity'],
      applicable: true,
      result,
      evidence: buildEvidence(r.id, isMustFail, a.parsedResume),
      next_action,
    };
  });

  // 加上 must_pass_rule_ids 里"不在 applicable 集"的规则(applicable=false,result=NOT_APPLICABLE)
  // 例如 s06:腾讯专属规则在字节路径下 applicable=false
  for (const ruleId of a.expected.must_pass_rule_ids) {
    if (!ruleFlags.some((f) => f.rule_id === ruleId)) {
      ruleFlags.push({
        rule_id: ruleId,
        rule_name: `(stub) rule ${ruleId}`,
        applicable_client: '通用',
        severity: 'flag_only',
        applicable: false,
        result: 'NOT_APPLICABLE',
        evidence: `规则 ${ruleId} 在 client=${a.clientId} 场景下不适用,简历未提供相关字段。`,
        next_action: 'continue',
      });
    }
  }

  const dropReasons: string[] = [];
  const pauseReasons: string[] = [];
  for (const f of ruleFlags) {
    if (f.applicable && f.result === 'FAIL') dropReasons.push(`${f.rule_id}:stub_fail`);
    if (f.applicable && f.result === 'REVIEW') pauseReasons.push(`${f.rule_id}:stub_review`);
  }

  const augmentationLines: string[] = ['## Rule Check Annotations', ''];
  let hasNote = false;
  for (const f of ruleFlags) {
    if (!f.applicable) continue;
    const icon = f.result === 'FAIL' ? '✗' : f.result === 'REVIEW' ? '⚠' : f.severity === 'flag_only' ? 'ⓘ' : '✓';
    augmentationLines.push(`- [${f.rule_id} ${icon}] ${f.rule_name} — ${shortenEvidence(f.evidence ?? '')}`);
    hasNote = true;
  }
  if (!hasNote) {
    augmentationLines.push('- (no rule fired in this scenario)');
  }

  return {
    candidate_id: pickFirstMatch(JSON.stringify(a.parsedResume ?? {}), /"name"\s*:\s*"([^"]+)"/),
    job_requisition_id: a.jobReqId,
    client_id: a.clientId,
    overall_decision: a.expected.llm_decision,
    drop_reasons: dropReasons,
    pause_reasons: pauseReasons,
    rule_flags: ruleFlags,
    resume_augmentation: augmentationLines.join('\n'),
    notifications: [],
  };
}

function shortenEvidence(s: string): string {
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

/**
 * 给每条规则配 evidence 字符串,引用简历原文字段(让 verifier grep 能命中)。
 * 命中规则:用最具识别度的字段值;不命中:写 NOT_APPLICABLE 解释。
 */
function buildEvidence(
  ruleId: string,
  isFail: boolean,
  resume: Record<string, unknown> | undefined,
): string {
  if (!resume) return '简历未提供该字段,标 NOT_APPLICABLE';
  const exp = resume.experience as Array<Record<string, unknown>> | undefined;
  const firstCompany = exp?.[0]?.company as string | undefined;
  const firstEnd = exp?.[0]?.endDate as string | undefined;
  const csi = resume.former_csi_employment as Record<string, unknown> | undefined;
  const tencentHist = resume.former_tencent_employment as Record<string, unknown> | undefined;
  const birthDate = resume.birth_date as string | undefined;
  const gender = resume.gender as string | undefined;
  const marital = resume.marital_status as string | undefined;
  const expectedSalary = resume.expected_salary_range as string | undefined;
  const nationality = resume.nationality as string | undefined;

  // 按 rule_id 大类
  if (ruleId === '10-25' || ruleId === '10-26') {
    // 华为 / OPPO 小米冷冻
    if (isFail && firstCompany && firstEnd) {
      return `experience[0]: ${firstCompany}, 离职 ${firstEnd}, 距今 < 阈值,命中`;
    }
    return `experience[0]: ${firstCompany ?? '(空)'}, 不是华为/OPPO/小米,result=PASS`;
  }
  if (ruleId === '10-38' || ruleId === '10-40' || ruleId === '10-45') {
    // 腾讯历史从业
    if (isFail && tencentHist) {
      return `former_tencent_employment: ${tencentHist.business_group ?? ''}/${tencentHist.studio ?? ''}, leave_type=${tencentHist.leave_type ?? ''},命中`;
    }
    return `简历未提供 former_tencent_employment(或非腾讯历史),result=PASS`;
  }
  if (ruleId === '10-17' || ruleId === '10-18' || ruleId === '10-16') {
    // CSI 黑名单
    if (isFail && csi) {
      return `former_csi_employment: ${csi.company ?? ''}, leave_code=${csi.leave_code ?? ''},命中`;
    }
    return `简历未提供 former_csi_employment,标 NOT_APPLICABLE`;
  }
  if (ruleId === '10-21' || ruleId === '10-22' || ruleId === '10-12') {
    return `birth_date: ${birthDate ?? '(未提供)'},按教育/年龄逻辑校验`;
  }
  if (ruleId === '10-7') {
    return `expected_salary_range: ${expectedSalary ?? '(未提供)'} vs jr.salary_range`;
  }
  if (ruleId === '10-47' || ruleId === '10-36') {
    return `gender=${gender ?? '?'}, birth_date=${birthDate ?? '?'}, marital=${marital ?? '?'}`;
  }
  if (ruleId === '10-35') {
    return `nationality=${nationality ?? '中国'} → 通道限制判定`;
  }
  if (ruleId === '10-43') {
    if (isFail && tencentHist) {
      return `former_tencent_employment.studio=${tencentHist.studio ?? ''} 跟 target studio 不同,跨室禁止`;
    }
    return `简历未提供 former_tencent_employment 工作室记录,result=PASS`;
  }
  if (ruleId === '10-42') {
    return `former_tencent_employment / CDG 6 个月拦截不适用(候选人非 CDG 史),result=PASS`;
  }
  // 兜底:引用 experience 第一段
  if (firstCompany) {
    return `experience[0]: ${firstCompany} (${firstEnd ?? ''})`;
  }
  return `规则 ${ruleId}:简历未提供相关字段,result=${isFail ? 'FAIL' : 'PASS'}`;
}
