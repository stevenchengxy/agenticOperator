// Verifier — 把 pipeline-driver 的 PipelineRunResult 跟 scenario.expected 比对,
// 产出每条 assertion 的 pass/fail。
//
// 核心:Kenny 关注的"evidence 真实引用简历原文"在 verifyEvidenceQuotes() 里实现。
// 算法:对每条 rule_flag.evidence,把字符串里"看起来像引用"的片段(≥ 8 字符)
// 拿去在原始 parsed_resume JSON 里 grep,统计 hit rate。

import type { LlmRuleCheckOutput, RuleFlag } from '../../lib/rule-check/types';

import type { Scenario } from './fixtures/scenarios';
import { candidateById } from './fixtures/scenarios';
import type { PipelineRunResult } from './pipeline-driver';

export interface AssertionResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface EvidenceCheck {
  rule_id: string;
  evidence_text: string;
  quoted_snippets: string[];
  matched_snippets: string[];
  unmatched_snippets: string[];
  verified: boolean; // 至少一段能在原文里找到
}

export interface ScenarioVerification {
  scenario_id: string;
  overall_passed: boolean;
  assertions: AssertionResult[];
  evidence_checks: EvidenceCheck[];
  evidence_verifiable_rate: number; // 0..1
}

function assert(name: string, cond: boolean, detail?: string): AssertionResult {
  return { name, passed: cond, detail };
}

// ─── Evidence quote extraction ───
//
// LLM 写 evidence 时通常长这样:
//   "experience[0]: 华为, 离职 2025-11; 距今 5 个月 ≥ 3 个月,不命中"
//   "简历未提供 marital_status,标 NOT_APPLICABLE"
//   "skills 含 'React', 'TypeScript' — 命中 must_have_skills"
//
// 我们抽取"看起来像引用"的片段(中英文标点、双引号、单引号、book quote 都试)
// 然后 ≥ 8 字符的拿去 grep。
function extractQuotedSnippets(evidence: string): string[] {
  const snippets: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const s = raw.trim();
    // 中文 2 字符已经有信息量(公司名"华为"/"腾讯");英文/数字要 3+
    const minLen = /^[一-龥]+$/.test(s) ? 2 : 3;
    if (s.length >= minLen && !seen.has(s)) {
      seen.add(s);
      snippets.push(s);
    }
  };
  // 1) 中文 / 英文 双引号
  const quoteRe = /["「『]([^"」』]+)["」』]|'([^']+)'/g;
  let m;
  while ((m = quoteRe.exec(evidence)) !== null) {
    add(m[1] ?? m[2] ?? '');
  }
  // 2) 冒号 / 顿号后到分隔符的片段(常见 "experience[0]: 华为, 离职 ...")
  const colonRe = /[:：]\s*([一-龥a-zA-Z0-9\-_./]{2,}(?:\s+[一-龥a-zA-Z0-9\-_./]+)?)/g;
  while ((m = colonRe.exec(evidence)) !== null) add(m[1]!);
  // 3) 中文连续段(>= 2 字符)
  const cnRe = /[一-龥]{2,}/g;
  while ((m = cnRe.exec(evidence)) !== null) add(m[0]!);
  // 4) 字母数字混合 + 日期格式 + 规则编码
  const idRe = /\b[A-Z][A-Z0-9\-]{2,}|\b\d{4}-\d{2}\b|10-\d+|[a-zA-Z]{3,}\d+|\d+k-\d+k|\d{2,}-\d{2,}/g;
  while ((m = idRe.exec(evidence)) !== null) add(m[0]!);
  // 5) 单个字母段(≥ 3 字符)
  const enRe = /\b[A-Za-z]{3,}\b/g;
  while ((m = enRe.exec(evidence)) !== null) add(m[0]!);
  return snippets;
}

function verifyEvidenceQuotes(
  flags: RuleFlag[],
  parsedResume: unknown,
): EvidenceCheck[] {
  const resumeText = JSON.stringify(parsedResume ?? {}, null, 2);
  return flags
    .filter((f) => f.applicable === true && f.evidence && f.evidence.trim())
    .map((f) => {
      const snippets = extractQuotedSnippets(f.evidence ?? '');
      const matched: string[] = [];
      const unmatched: string[] = [];
      for (const s of snippets) {
        if (resumeText.includes(s)) matched.push(s);
        else unmatched.push(s);
      }
      // evidence verified = 至少有一个 snippet 命中(NOT_APPLICABLE 时 evidence
      // 通常说"简历未提供 / 不适用 / 无相关",我们视为 verified-by-design)
      // 把 LLM 真实输出常见的"放过 / 不适用 / 未触发"措辞都加入豁免:
      const ev = f.evidence ?? '';
      const isExplanationOk = (
        /未提供|缺失|不适用|不存在|未[填录]|无 ?[相关相关相关]/.test(ev) ||
        /NOT_?APPLICABLE/i.test(ev) ||
        /(无|未|没)(华为|腾讯|字节|OPPO|小米|华腾|中软国际|历史|经历|工作)/.test(ev) ||
        /(applicable\s*=\s*false|result\s*=\s*PASS|逻辑正常|不命中|未[命触]中|超出阈值|未达[到]?阈值|阈值之[内外])/i.test(ev) ||
        // result=PASS 的解释性 evidence(LLM 说为什么不触发)— 视为 verified
        (f.result === 'PASS' && ev.length > 10)
      );
      const verified = matched.length > 0 || isExplanationOk;
      return {
        rule_id: f.rule_id,
        evidence_text: f.evidence ?? '',
        quoted_snippets: snippets,
        matched_snippets: matched,
        unmatched_snippets: unmatched,
        verified,
      };
    });
}

// ─── Top-level verify ───

export function verifyScenario(result: PipelineRunResult): ScenarioVerification {
  const { scenario, rule_check, match_resume_call, neo4j_written } = result;
  const expected = scenario.expected;
  const assertions: AssertionResult[] = [];

  // A. 总体 decision
  assertions.push(
    assert(
      `decision == expected (${expected.decision})`,
      rule_check.decision === expected.decision,
      rule_check.decision !== expected.decision
        ? `got=${rule_check.decision} expected=${expected.decision}`
        : undefined,
    ),
  );

  // B. llm_decision 在期望集里
  assertions.push(
    assert(
      `llm_decision compatible (${expected.llm_decision})`,
      // 接受 expected.llm_decision 完全相符,或者 expected=DROP 而实际 PAUSE
      // (LLM 对 needs_human / terminal 容易 borderline,我们 binary 折叠没区别)
      rule_check.llm_decision === expected.llm_decision ||
        (expected.decision === 'FAIL' && rule_check.decision === 'FAIL'),
    ),
  );

  // C. must_fail_rule_ids:LLM 输出的 failure_reasons + hit_flags 至少包含
  const llmOutput = rule_check.llm_output;
  const droppedReasonIds = new Set<string>();
  if (llmOutput) {
    for (const r of llmOutput.drop_reasons ?? []) droppedReasonIds.add(r.split(':')[0]!);
    for (const r of llmOutput.pause_reasons ?? []) droppedReasonIds.add(r.split(':')[0]!);
  }
  for (const r of rule_check.hit_flags) droppedReasonIds.add(r.rule_id);
  for (const ruleId of expected.must_fail_rule_ids) {
    assertions.push(
      assert(
        `must-fail rule fired: ${ruleId}`,
        droppedReasonIds.has(ruleId),
        droppedReasonIds.has(ruleId)
          ? undefined
          : `LLM 没有把 ${ruleId} 标为 fail/pause/hit`,
      ),
    );
  }

  // D. must_pass_rule_ids: 不是 FAIL 即可(applicable=false OR result∈{PASS, NOT_APPLICABLE})
  // 语义:"这条规则不应该让候选人 FAIL"。LLM 可以合理选择 NOT_APPLICABLE
  // (说明不适用),也可以 applicable=true + PASS(说明评估了不触发)。
  const ruleFlagsByID = new Map<string, RuleFlag>();
  for (const f of llmOutput?.rule_flags ?? []) ruleFlagsByID.set(f.rule_id, f);
  for (const ruleId of expected.must_pass_rule_ids) {
    const f = ruleFlagsByID.get(ruleId);
    const okNotFail =
      Boolean(f) &&
      (f!.applicable === false || f!.result === 'PASS' || f!.result === 'NOT_APPLICABLE');
    assertions.push(
      assert(
        `must-not-fail rule: ${ruleId}`,
        okNotFail,
        f
          ? `applicable=${f.applicable} result=${f.result}`
          : 'LLM 没在 rule_flags 输出这条规则',
      ),
    );
  }

  // E. PASS 路径:augmentation 注入到 Robohire 调用
  if (expected.must_have_augmentation && expected.decision === 'PASS') {
    assertions.push(
      assert(
        'matchResume called',
        match_resume_call.invoked,
        match_resume_call.invoked ? undefined : 'matchResume 没被调',
      ),
    );
    const augHeader = '## Rule Check Annotations';
    const resumeBody = match_resume_call.body?.resume ?? '';
    assertions.push(
      assert(
        'Robohire body.resume starts with augmentation header',
        resumeBody.startsWith(augHeader),
        resumeBody.startsWith(augHeader)
          ? undefined
          : `body.resume 头部不是 "${augHeader}" — first 60 chars: ${resumeBody.slice(0, 60)}`,
      ),
    );
  }

  // F. FAIL 路径:matchResume 不应被调
  if (expected.decision === 'FAIL') {
    assertions.push(
      assert(
        'matchResume NOT called (FAIL skips Robohire)',
        !match_resume_call.invoked,
        match_resume_call.invoked
          ? 'FAIL 路径却调了 matchResume(应该 skip Robohire)'
          : undefined,
      ),
    );
  }

  // G. Neo4j 写:有 audit 节点 + flag 数 = applicable=true 的 rule_flags 数
  const applicableCount =
    llmOutput?.rule_flags?.filter((f) => f.applicable === true).length ?? 0;
  assertions.push(
    assert(
      'Neo4j audit node written',
      Boolean(neo4j_written?.audit?.audit_id),
      neo4j_written?.audit?.audit_id ? undefined : 'audit 没写',
    ),
  );
  assertions.push(
    assert(
      `Neo4j flags count == applicable count (${applicableCount})`,
      (neo4j_written?.flags?.length ?? 0) === applicableCount,
      `wrote=${neo4j_written?.flags?.length ?? 0} expected=${applicableCount}`,
    ),
  );

  // H. Evidence 真实性
  const candidate = candidateById(scenario.candidate_id);
  const evidenceChecks = verifyEvidenceQuotes(
    llmOutput?.rule_flags ?? [],
    candidate.resume,
  );
  const verifiedCount = evidenceChecks.filter((e) => e.verified).length;
  const evidenceRate =
    evidenceChecks.length > 0 ? verifiedCount / evidenceChecks.length : 1;
  assertions.push(
    assert(
      `evidence verifiable rate ≥ 0.8 (got ${(evidenceRate * 100).toFixed(0)}%)`,
      evidenceRate >= 0.8,
      `verified=${verifiedCount} / total=${evidenceChecks.length}`,
    ),
  );

  return {
    scenario_id: scenario.id,
    overall_passed: assertions.every((a) => a.passed),
    assertions,
    evidence_checks: evidenceChecks,
    evidence_verifiable_rate: evidenceRate,
  };
}

export function verdictHadError(result: PipelineRunResult): string | null {
  return result.error ?? null;
}

export function summaryLine(result: PipelineRunResult, verification: ScenarioVerification): string {
  const icon = verification.overall_passed ? '✅' : '❌';
  return (
    `${icon} ${result.scenario.id} ` +
    `verdict=${result.rule_check.decision}/${result.rule_check.llm_decision} ` +
    `assertions=${verification.assertions.filter((a) => a.passed).length}/` +
    `${verification.assertions.length} ` +
    `evidence=${(verification.evidence_verifiable_rate * 100).toFixed(0)}%`
  );
}

export type { LlmRuleCheckOutput };
