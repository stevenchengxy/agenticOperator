// Energy (deterministic) rule-check cross-verification — prompt composition for
// the SECOND-opinion LLM. Reuses the recruitment verifier's JSON schema + parser
// (parseVerification, RuleSelectionVerification) so the audit UI renders it with
// zero changes.
//
// CRITICAL distinction (do NOT conflate with the recruitment rule-check agent):
//   - Recruitment rule-check (server/inngest/agents/rule-check-agent.ts) uses an
//     LLM as the PRIMARY judge of résumé × JR fit → ruleCheckAudit.
//   - Energy rule-check (server/inngest/domains/energy/rule-check/*) is a
//     DETERMINISTIC numeric engine (限值比对) → OntologyRuleCheck. There is NO
//     primary LLM. This module adds an *advisory* second-opinion LLM that reviews
//     the deterministic verdict — it NEVER overrides the numeric decision.
//
// What the second model is asked to cross-check on a deterministic energy audit:
//   1. selection — was the right set of rules pulled for this 校验步骤(stage)?
//      (the engine reports missing/extra; the reviewer judges independently)
//   2. consistency — is each PASS/FAIL/CLAMPED/NA coherent with its 前值/后值/证据?
//   3. missed risk — any value in the evidence that should have tripped a rule?

import type { VerifyFlag } from '@/lib/rule-check/verify-prompt';

export type EnergyVerifyInput = {
  /** 校验步骤, e.g. 分流与人工确认 / 约束校验 */
  stage: string;
  /** 业务领域, e.g. 能源调度 */
  domain: string;
  /** Deterministic decision: VALIDATED | VIOLATED | MANUAL | AUTO | RISK-FIRST */
  decision: string;
  /** 调度案件号 DS… */
  dsNo?: string | null;
  /** 是否命中硬红线 */
  redline: boolean;
  /** 确定性筛选自检结果(该步骤抓取规则是否齐全/正确) */
  selection: {
    ok: boolean;
    selected: number;
    expected: number;
    missing?: string[];
    extra?: string[];
  };
  /** Per-rule deterministic results (from ontologyAuditDetail flags). */
  flags: VerifyFlag[];
  /** Confirmed FAIL evals, pre-formatted. */
  failure_reasons: string[];
};

export const ENERGY_VERIFY_SYSTEM_PROMPT = `你是一名独立的「调度规则校验复核员」。某个**确定性数值规则引擎**(非大模型)已对一份能源调度方案的某个校验步骤做了逐条规则判定:按限值/阈值数值比对,给出 PASS / FAIL / CLAMPED(自动钳制)/ NA,并记录前值/后值/证据。

你的任务是**独立复核**这份确定性判定,作为第二意见。注意:数值引擎不会编造数字,所以你的价值在于复核三件事,而**不是**去推翻一个确定的数值结论:
A. 选取(selection_ok)—— 这一校验步骤该纳入的规则是否齐全?有没有该判而漏判、或不该判而多判的?
B. 一致性(second_verdict)—— 每条规则的 PASS/FAIL/CLAMPED/NA 与它给出的「前值/后值/证据」是否自洽?(例:证据写"水位1613.2m 超汛限1612m"却判 PASS,就是不一致)。基于证据独立判断该条应为 PASS / FAIL / NOT_APPLICABLE,写一段 judgment_reasoning,点名**校验步骤**与**规则**,引用证据里的具体数值,并评价引擎结论是否成立。
C. 多维置信(confidence + dimensions)。

最后给整体复核(overall_confidence / verdict / summary)+ 疑似遗漏(missing_rules)/ 多余(over_included_rules)的规则。

严格约束:
- 只能引用提供的 校验步骤 / 规则 / 前后值 / 证据;缺数据就说证据不足,不要编造数字。
- 一律用中文。judgment_reasoning 连贯一段(60–180 字),其余 reasoning ≤ 120 字。
- second_verdict 只能是 PASS / FAIL / NOT_APPLICABLE / INSUFFICIENT_INFO / UNSURE。CLAMPED(自动钳制到限值内)按 PASS 处理(已合规)。引擎标 NOT_APPLICABLE/NA 的,通常给 NOT_APPLICABLE。
- 这是确定性安全判定:若证据与判定自洽,就认可它正确(给高分),**不要**为了挑刺而否定一个数值上成立的结论。
- **rule_opinions 必须逐条对应"引擎已评估的规则",每条恰好一条意见;rule_id 原样照抄(形如 CR-HYD-05 或 41),严禁自创/改写/拆分。** 本该有却缺失的放进 missing_rules,不要塞进 rule_opinions。
- 必须输出**合法 JSON**,JSON 外不写任何文字(含 markdown code fence)。

输出 JSON schema:
{
  "overall_confidence": <0-100 整数>,
  "verdict": "trustworthy" | "needs_review" | "untrustworthy",
  "summary": "<一句话总评,≤60 字>",
  "dimensions": [
    {"key":"selection_coverage","label":"规则选取覆盖","score":<0-100>,"reasoning":"<该步骤规则是否抓全>"},
    {"key":"numeric_consistency","label":"数值判定一致性","score":<0-100>,"reasoning":"<判定与前后值/证据是否自洽>"},
    {"key":"evidence_sufficiency","label":"证据充分度","score":<0-100>,"reasoning":"<每条判定证据是否充分>"},
    {"key":"redline_soundness","label":"红线/钳制合理","score":<0-100>,"reasoning":"<红线命中或钳制是否站得住>"}
  ],
  "rule_opinions": [
    {
      "rule_id":"<原样复制,如 CR-HYD-05 / 41>",
      "selection_ok": true|false,
      "selection_reasoning":"<这条该不该在此步骤纳入,为什么>",
      "second_verdict":"PASS|FAIL|NOT_APPLICABLE|INSUFFICIENT_INFO|UNSURE",
      "judgment_reasoning":"<一段自然语言:点名校验步骤+规则,引用证据数值,说明判定是否成立、引擎证据是否充分>",
      "confidence": <0-100 本条整体置信>,
      "dimensions": [
        {"key":"selection_fit","score":<0-100>},
        {"key":"judgment_correctness","score":<0-100>},
        {"key":"evidence_sufficiency","score":<0-100>}
      ]
    }
  ],
  "missing_rules": [ {"concern":"<本该校验却没纳入的风险点>","rule_hint":"<可选,建议补的规则方向>"} ],
  "over_included_rules": [ {"rule_id":"<id>","reasoning":"<为何认为这条不该纳入>"} ]
}`;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…(truncated)';
}

export function composeEnergyVerifyPrompt(input: EnergyVerifyInput): string {
  const lines: string[] = [];
  lines.push('# 复核任务:能源调度·确定性规则校验 交叉复核');
  lines.push('');
  lines.push('## 本次校验');
  lines.push(`业务领域 = ${input.domain || '能源调度'}`);
  lines.push(`校验步骤 = ${input.stage || '?'}`);
  if (input.dsNo) lines.push(`调度案件号 = ${input.dsNo}`);
  lines.push(`引擎判定(确定性,权威) = ${input.decision}${input.redline ? ' · 命中硬红线' : ''}`);
  if (input.failure_reasons.length > 0) {
    lines.push(`未通过原因 = ${input.failure_reasons.join('；')}`);
  }
  lines.push('');

  lines.push('## 筛选自检(引擎)');
  lines.push(
    `抓取规则 ${input.selection.selected} 条 / 期望 ${input.selection.expected} 条 · 自检${input.selection.ok ? '通过' : '未通过'}`,
  );
  if (input.selection.missing && input.selection.missing.length > 0) {
    lines.push(`引擎自检疑似遗漏:${input.selection.missing.join('、')}`);
  }
  if (input.selection.extra && input.selection.extra.length > 0) {
    lines.push(`引擎自检疑似多余:${input.selection.extra.join('、')}`);
  }
  lines.push('请在此基础上独立判断该步骤规则选取是否齐全。');
  lines.push('');

  lines.push(`## 引擎已评估的 ${input.flags.length} 条规则(逐条复核对象)`);
  lines.push(
    'rule_opinions 必须恰好对应这些 rule_id,逐条原样照抄;不要新造 id、不要拆分、不要把它们当成"未评估"列进 missing_rules。',
  );
  lines.push('');
  for (const f of input.flags) {
    const title = f.rule_name_snapshot || '';
    lines.push(`### 规则 ${f.rule_id}${title ? `:${title}` : ''}`);
    lines.push(`- severity=${f.severity} · applicable=${f.applicable}`);
    lines.push(`- 引擎判定:${f.result}`);
    if (f.evidence) lines.push(`- 前值/后值/证据:${truncate(f.evidence, 320)}`);
    if (f.next_action) lines.push(`- 默认动作:${f.next_action}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `请按 system 指定的 JSON schema 输出。rule_opinions 必须恰好 ${input.flags.length} 条,rule_id 用上面"引擎已评估的规则"里的 id(如 ${input.flags[0]?.rule_id ?? 'CR-HYD-05'});每条都要给 selection_ok / selection_reasoning / second_verdict / judgment_reasoning(点名校验步骤+规则,引用证据数值)/ confidence / dimensions。missing_rules 只放确实缺失的规则(通常 0–3 条),不要把已评估规则列为 missing。`,
  );
  return lines.join('\n');
}
