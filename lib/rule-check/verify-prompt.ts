// Rule-selection cross-validation — prompt composition + verifier-model
// selection + tolerant parser for the second-opinion LLM.
//
// A SECOND, independent model re-judges a rule-check audit:
//   1. Was the right *set* of rules pulled in for this candidate × position?
//   2. Is each per-rule PASS/FAIL verdict correct?
//   3. How confident is it (0-100), broken down across dimensions?
//
// The verifier produces the confidence + dimension scores itself (no hardcoded
// weighted sum). We additionally compute the factual per-rule agreement rate
// between the two real model outputs as a transparency metric.

import { pickGateway } from '@/server/llm/gateway';

/** The 4 dimension keys the verifier is asked to always return. The frontend
 *  maps these to i18n labels (falling back to the model-provided `label`). */
export const VERIFIER_DIMENSION_KEYS = [
  'selection_coverage', // 该拉的规则都拉进来了吗(尤其底线规则)
  'candidate_jr_fit', // 规则集贴合这个候选人×岗位吗
  'evidence_sufficiency', // 每条判定的证据够不够、有没有引用具体字段
  'filter_soundness', // 被过滤掉的规则,排除理由站得住吗
] as const;

export type VerifierDimensionKey = (typeof VERIFIER_DIMENSION_KEYS)[number];

export type VerifierVerdict = 'trustworthy' | 'needs_review' | 'untrustworthy';

export type VerifierDimension = {
  key: string;
  label: string;
  score: number; // 0-100
  reasoning: string;
};

export type SecondVerdict = 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'INSUFFICIENT_INFO' | 'UNSURE';

/** Fixed per-rule confidence dimensions (FE maps key → i18n label). */
export const RULE_DIMENSION_KEYS = [
  'selection_fit', // 这条规则该不该被筛选纳入此候选人×岗位
  'judgment_correctness', // PASS/FAIL 判定是否正确
  'evidence_sufficiency', // 原模型证据是否充分、站得住
] as const;

export type RuleDimension = { key: string; score: number };

export type RuleOpinion = {
  rule_id: string;
  rule_name: string;
  // ── 筛选(纳入)二次判断 —— 硬编码过滤之外,LLM 独立判断该不该选这条 ──
  /** true = 第二模型认为这条规则确实该为此候选人×岗位筛选纳入。 */
  selection_ok: boolean;
  selection_reasoning: string;
  // ── 判定(PASS/FAIL)复核 ──
  second_verdict: SecondVerdict;
  /** true = second model agrees with the original audit's result on this rule. */
  agrees: boolean;
  /** Original audit result, filled in by the parser from the flag rows. */
  original_result: string;
  /** 一段自然语言:含候选人姓名 + 岗位 + 关键证据,说明为何 pass/fail/不适用。 */
  judgment_reasoning: string;
  // ── 本条多维度置信 ──
  /** 0-100 — 本条规则(选取 + 判定)整体可信度。 */
  confidence: number;
  dimensions: RuleDimension[];
};

export type RuleSelectionVerification = {
  overall_confidence: number; // 0-100
  verdict: VerifierVerdict;
  summary: string;
  dimensions: VerifierDimension[];
  rule_opinions: RuleOpinion[];
  missing_rules: Array<{ concern: string; rule_hint?: string }>;
  over_included_rules: Array<{ rule_id: string; reasoning: string }>;
  /** Factual: % of compared rules where the second model agrees with the
   *  original. Computed from rule_opinions vs original flag results. */
  agreement_rate: number;
  agreement_count: number;
  agreement_total: number;
};

export type VerifyFlag = {
  rule_id: string;
  rule_name_snapshot: string;
  severity: string;
  applicable: boolean;
  result: string;
  evidence: string;
  next_action: string;
};

export type VerifyPromptInput = {
  decision: string;
  failure_reasons: string[];
  client_name: string;
  business_group: string | null;
  /** The exact prompt the primary model saw — carries the FULL rule definitions
   *  (submissionCriteria / logic) keyed by the same rule_ids, plus graph context.
   *  When present we feed it so the verifier understands what each rule requires;
   *  resume/jr below are the fallback when it's missing. */
  user_prompt: string | null;
  resume: Record<string, unknown> | null;
  jr: Record<string, unknown> | null;
  flags: VerifyFlag[];
  rule_provenance: Array<{ rule_id: string; tier: string; included: boolean; reason: string }>;
  filtered_out_rules: Array<{
    rule_id: string;
    rule_name: string;
    applicable_client: string;
    applicable_department: string;
    executor: string;
    reason: string;
  }>;
  /** 被 client/department/executor 过滤掉的规则,补了名称/定义 —— 让第二模型
   *  对每条也给 selection_ok(该不该排除)。来自 buildExcludedRules(provenance)。 */
  excluded_rules: Array<{
    rule_id: string;
    rule_name: string;
    applicable_client: string;
    applicable_department: string;
    tier: string;
    reason: string;
    definition: string;
  }>;
};

/**
 * Pick a verifier model that DIFFERS from the model that produced the original
 * audit, so the cross-check is genuinely independent.
 *   - `RULE_CHECK_VERIFIER_MODEL` env override always wins.
 *   - Direct-OpenAI gateway (api.openai.com) only serves OpenAI models, so we
 *     stay in-family and just change tier.
 *   - Internal multi-vendor gateway → cross to a different family (Claude ⇄ GPT,
 *     gemini/deepseek/kimi/… → Claude Haiku). Model ids match the gateway's
 *     catalogue; set the env override for a gateway with a different roster.
 */
export function pickVerifierModel(primaryModel: string): string {
  const override = process.env.RULE_CHECK_VERIFIER_MODEL;
  if (override && override.trim()) return override.trim();
  const p = (primaryModel || '').toLowerCase();

  let baseURL = '';
  try {
    baseURL = pickGateway().baseURL;
  } catch {
    // gateway not configured — the route handles this before calling us.
  }
  if (baseURL.includes('api.openai.com')) {
    return p.includes('mini') || p.includes('nano') ? 'gpt-4o' : 'gpt-4o-mini';
  }

  // Verifier = a strong GPT-5 model on the New-api gateway (user asked for
  // gpt-5.5; the gateway tops out at gpt-5.4, so use that — flip the env var
  // RULE_CHECK_VERIFIER_MODEL to gpt-5.5 once the gateway serves it).
  if (p.includes('gpt') || p.includes('openai')) return 'anthropic/claude-opus-4.6';
  // gemini / deepseek / kimi / minimax / unknown → GPT-5.4 (different family
  // from the gemini default primary, and the strongest GPT-5 the gateway has).
  return 'openai/gpt-5.4';
}

export const VERIFY_SYSTEM_PROMPT = `你是一名独立的「规则筛选审计员」。另一个 AI 模型已经对一份简历 × 岗位做了 matchResume 规则预筛(从图引擎选取了一批规则,并逐条判定 PASS/FAIL)。你的任务是**独立复核**,不要盲信原模型的结论。

对**每一条**规则,你都要独立回答三件事:
A. 选取是否正确(selection_ok)—— 除了系统的硬编码过滤,你自己判断:这条规则真的该为这个候选人 × 岗位筛选纳入吗?(给 selection_reasoning)
B. 判定是否正确(second_verdict)—— 基于候选人简历与岗位信息,你独立判断这条规则对该候选人应是 PASS / FAIL / NOT_APPLICABLE,并写一段**自然语言** judgment_reasoning:必须点名**候选人姓名**和**岗位名称**,引用简历/岗位里的**具体证据**,说明为何通过/失败/不适用,同时评价原模型给的证据是否正确、充分。
C. 多维度置信(confidence + dimensions)—— 给这条规则 0-100 的整体置信,并拆成三个固定维度。

最后给一个整体复核(overall_confidence / verdict / summary),以及疑似遗漏 / 多余的规则。

严格约束:
- 只能引用提供的 候选人 / 岗位 / 规则定义 信息;缺字段就说证据不足,不要编造。
- 一律用中文。judgment_reasoning 写成连贯的一段话(60–180 字),其余 reasoning ≤ 120 字。
- second_verdict 只能是 PASS / FAIL / NOT_APPLICABLE / INSUFFICIENT_INFO / UNSURE;对原模型标 applicable=false / NOT_TRIGGERED 的规则,通常给 NOT_APPLICABLE。
- 评分政策(2026-06-01 fail-closed):强制规则(底线/需人工)若所需信息缺失或无法自动确认 → 应判**不通过**(原模型会标 INSUFFICIENT_INFO)。请认可这类「信息不足 → 不通过」为**正确**结论,**不要**因此判原模型错;若你也认为信息不足,second_verdict 用 INSUFFICIENT_INFO,judgment_reasoning 写明「因信息不足而不通过,建议人工复核」。
- **rule_opinions 覆盖两类规则,各恰好一条意见:① 原模型已评估的规则(给完整 selection_ok + second_verdict + judgment_reasoning + confidence + dimensions);② 被排除的规则(只判 selection_ok = 该不该为此候选人×岗位纳入,second_verdict 填 NOT_APPLICABLE,judgment_reasoning/dimensions 可省)。rule_id 必须原样照抄(形如 10-25),严禁自创 id、用规则名/英文 slug 当 id、拆分或合并规则。** 本该有却两类都没列的规则才放进 missing_rules,不要塞进 rule_opinions。
- 必须输出**合法 JSON**,不要在 JSON 外写任何文字(包括 markdown code fence)。

输出 JSON schema:
{
  "overall_confidence": <0-100 整数>,
  "verdict": "trustworthy" | "needs_review" | "untrustworthy",
  "summary": "<一句话总评,≤60 字>",
  "dimensions": [
    {"key":"selection_coverage","label":"规则选取覆盖","score":<0-100>,"reasoning":"<该拉的规则是否都拉了>"},
    {"key":"candidate_jr_fit","label":"候选人岗位贴合","score":<0-100>,"reasoning":"<规则集是否贴合此候选人×岗位>"},
    {"key":"evidence_sufficiency","label":"证据充分度","score":<0-100>,"reasoning":"<每条判定证据是否充分>"},
    {"key":"filter_soundness","label":"过滤链路合理","score":<0-100>,"reasoning":"<排除规则的理由是否站得住>"}
  ],
  "rule_opinions": [
    {
      "rule_id":"<原样复制,如 10-25>",
      "selection_ok": true|false,
      "selection_reasoning":"<这条规则该不该为此候选人×岗位纳入,为什么>",
      "second_verdict":"PASS|FAIL|NOT_APPLICABLE|INSUFFICIENT_INFO|UNSURE",
      "judgment_reasoning":"<一段自然语言:点名候选人姓名+岗位,引用具体证据,说明为何此结论,并评价原模型证据是否正确充分>",
      "confidence": <0-100 本条整体置信>,
      "dimensions": [
        {"key":"selection_fit","score":<0-100>},
        {"key":"judgment_correctness","score":<0-100>},
        {"key":"evidence_sufficiency","score":<0-100>}
      ]
    }
  ],
  "missing_rules": [ {"concern":"<本该适用却没纳入的风险点>","rule_hint":"<可选,建议补的规则方向>"} ],
  "over_included_rules": [ {"rule_id":"<id>","reasoning":"<为何认为这条不该纳入>"} ]
}`;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…(truncated)';
}

function pickField(obj: Record<string, unknown> | null, key: string): string {
  if (!obj) return '';
  const v = obj[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** Stable, bounded JSON dump of a resume/JR for the verifier context. */
function compactJson(obj: Record<string, unknown> | null, cap: number): string {
  if (!obj) return '(无)';
  try {
    return truncate(JSON.stringify(obj, null, 1), cap);
  } catch {
    return '(无法序列化)';
  }
}

/**
 * Pull each rule's definition out of the original user_prompt. The matchResume
 * prompt renders rules as `#### Rule <id>: <title> [attrs]` followed by
 * `- submissionCriteria: …` / `- logic: …`. We slice each rule's block so the
 * verifier sees what the rule actually requires (the primary saw the same text).
 */
export function extractRuleDefs(
  userPrompt: string | null,
): Map<string, { title: string; body: string }> {
  const out = new Map<string, { title: string; body: string }>();
  if (!userPrompt) return out;
  const headerRe = /#{2,5}\s*Rule\s+([0-9A-Za-z._-]+)\s*[:：]\s*([^\n]*)/g;
  const heads: Array<{ id: string; title: string; bodyStart: number; headStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(userPrompt)) !== null) {
    heads.push({
      id: m[1],
      title: m[2].replace(/\[[^\]]*\]/g, '').trim(),
      bodyStart: headerRe.lastIndex,
      headStart: m.index,
    });
  }
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].headStart : userPrompt.length;
    let body = userPrompt.slice(h.bodyStart, bodyEnd);
    // Stop at the next markdown header (e.g. a "### Set N" between rules).
    const cut = body.search(/\n#{2,4}\s/);
    if (cut >= 0) body = body.slice(0, cut);
    out.set(h.id, { title: h.title, body: truncate(body.trim(), 700) });
  }
  return out;
}

export function composeVerifyPrompt(input: VerifyPromptInput): string {
  const lines: string[] = [];
  const defs = extractRuleDefs(input.user_prompt);
  lines.push('# 复核任务:matchResume 规则筛选交叉验证');
  lines.push('');
  lines.push('## 原模型最终决策');
  lines.push(`decision = ${input.decision}`);
  if (input.failure_reasons.length > 0) {
    lines.push(`failure_reasons = ${input.failure_reasons.join('；')}`);
  }
  lines.push(`client = ${input.client_name || '?'}${input.business_group ? ` × ${input.business_group}` : ''}`);
  const candName = pickField(input.resume, 'name');
  const jobTitle = pickField(input.jr, 'client_job_title') || pickField(input.jr, 'job_title');
  lines.push(`候选人 = ${candName || '(简历未给姓名)'} | 岗位 = ${jobTitle || '(岗位未给名称)'}`);
  lines.push('judgment_reasoning 必须点名上面的候选人姓名与岗位名称。');
  lines.push('');

  lines.push('## 候选人简历(截断)');
  lines.push('```json');
  lines.push(compactJson(input.resume, 5000));
  lines.push('```');
  lines.push('');
  lines.push('## 岗位需求(截断)');
  lines.push('```json');
  lines.push(compactJson(input.jr, 5000));
  lines.push('```');
  lines.push('');

  lines.push(`## 原模型已评估的 ${input.flags.length} 条规则(逐条复核对象)`);
  lines.push('下面每条规则都已被原模型评估并给出判定 + 证据。请针对每条独立判断:原模型判定是否正确、证据是否充分。');
  lines.push('rule_opinions 必须恰好对应这些 rule_id,逐条原样照抄;不要新造 id、不要拆分、不要把它们当成"未评估"列进 missing_rules。');
  lines.push('');
  for (const f of input.flags) {
    const prov = input.rule_provenance.find((p) => p.rule_id === f.rule_id);
    const def = defs.get(f.rule_id);
    const title = f.rule_name_snapshot || def?.title || '';
    lines.push(`### 规则 ${f.rule_id}${title ? `:${title}` : ''}`);
    if (def?.body) lines.push(`- 规则定义(图引擎):${def.body}`);
    lines.push(`- severity=${f.severity} · applicable=${f.applicable}`);
    lines.push(`- 原模型判定:${f.result}`);
    if (f.evidence) lines.push(`- 原模型证据:${truncate(f.evidence, 300)}`);
    if (prov) lines.push(`- 纳入依据(${prov.tier}):${prov.reason}`);
    lines.push('');
  }

  // 被排除的规则 —— 也要逐条判断「该不该排除」(优先用补了名称/定义的 excluded_rules;
  // 退回旧 filtered_out_rules 仅作兼容,二者择一渲染)。
  if (input.excluded_rules.length > 0) {
    lines.push(`## 被排除的规则(${input.excluded_rules.length} 条 —— 也要逐条判断:该不该排除)`);
    lines.push('这些规则被系统的硬编码过滤(客户/部门/executor)排除,未进入 PASS/FAIL 评估。');
    lines.push('请对每条独立判断:**这条规则本该为此候选人×岗位纳入吗?**(给 selection_ok + selection_reasoning)');
    lines.push('排除规则不做 PASS/FAIL 判定:second_verdict 一律填 NOT_APPLICABLE。');
    lines.push('');
    for (const r of input.excluded_rules) {
      lines.push(`### 规则 ${r.rule_id}${r.rule_name ? `:${r.rule_name}` : ''}`);
      if (r.definition) lines.push(`- 规则定义:${truncate(r.definition, 500)}`);
      lines.push(
        `- 适用客户=${r.applicable_client || '?'} · 适用部门=${r.applicable_department || 'N/A'} · tier=${r.tier}`,
      );
      lines.push(`- 系统排除理由:${r.reason}`);
      lines.push('');
    }
  } else if (input.filtered_out_rules.length > 0) {
    lines.push('## FILTERED_OUT(被 client/department/executor 过滤掉、未进入评估的规则)');
    for (const r of input.filtered_out_rules) {
      lines.push(
        `- [${r.rule_id}] ${r.rule_name} | applicableClient=${r.applicable_client} | applicableDepartment=${r.applicable_department} | executor=${r.executor} | 排除理由=${r.reason}`,
      );
    }
    lines.push('');
  }

  lines.push('---');
  const opinionTotal = input.flags.length + input.excluded_rules.length;
  lines.push(
    `请按 system 指定的 JSON schema 输出。rule_opinions 必须恰好 ${opinionTotal} 条 = 已评估 ${input.flags.length} 条 + 被排除 ${input.excluded_rules.length} 条,rule_id 原样照抄(如 ${input.flags[0]?.rule_id ?? input.excluded_rules[0]?.rule_id ?? '10-25'});每条都要给 selection_ok / selection_reasoning;已评估规则另给 second_verdict / judgment_reasoning(点名候选人+岗位)/ confidence / dimensions,被排除规则 second_verdict=NOT_APPLICABLE。missing_rules 只放确实缺失且不在上述任何列表里的硬性规则。`,
  );
  return lines.join('\n');
}

// ── parsing ──────────────────────────────────────────────────────────────

function stripFences(s: string): string {
  let t = s.trim();
  // ```json ... ``` or ``` ... ```
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  // Some models prepend prose before the object — grab the first {...} block.
  if (!t.startsWith('{')) {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
  }
  return t;
}

function clampScore(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function normVerdict(v: unknown): VerifierVerdict {
  const s = asString(v).toLowerCase();
  if (s === 'trustworthy' || s === 'untrustworthy') return s;
  return 'needs_review';
}

function normSecondVerdict(v: unknown): SecondVerdict {
  const s = asString(v).toUpperCase().replace(/[^A-Z_]/g, '');
  if (s === 'PASS' || s === 'FAIL' || s === 'NOT_APPLICABLE' || s === 'INSUFFICIENT_INFO') return s;
  if (s === 'NA' || s === 'NOTAPPLICABLE') return 'NOT_APPLICABLE';
  if (s === 'INSUFFICIENTINFO' || s === 'INSUFFICIENT' || s === 'INSUFFICIENT_INFORMATION') {
    return 'INSUFFICIENT_INFO';
  }
  return 'UNSURE';
}

/**
 * Did the second model's verdict agree with the original audit result?
 * Compares on the PASS/FAIL/NOT_APPLICABLE/INSUFFICIENT_INFO axis; UNSURE never
 * counts as agreement. INSUFFICIENT_INFO agrees only with the original
 * INSUFFICIENT_INFO (both mean "信息不足 → 不通过" under the 2026-06-01 policy).
 */
function verdictsAgree(second: SecondVerdict, original: string): boolean {
  if (second === 'UNSURE') return false;
  const o = original.toUpperCase();
  if (second === 'NOT_APPLICABLE') return o === 'NOT_APPLICABLE' || o === 'NOT_TRIGGERED';
  if (second === 'INSUFFICIENT_INFO') return o === 'INSUFFICIENT_INFO';
  return o === second;
}

export class VerificationParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationParseError';
  }
}

/**
 * Tolerant parse of the verifier's JSON. Throws VerificationParseError if the
 * text can't be coerced into the schema. Fills in original_result + agreement
 * from the audit's flags (the factual cross-model agreement rate).
 */
export function parseVerification(
  rawText: string,
  flags: VerifyFlag[],
): RuleSelectionVerification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(rawText));
  } catch (e) {
    throw new VerificationParseError(`verifier returned non-JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new VerificationParseError('verifier JSON is not an object');
  }
  const o = parsed as Record<string, unknown>;

  const resultByRuleId = new Map(flags.map((f) => [f.rule_id, f.result]));
  const nameByRuleId = new Map(flags.map((f) => [f.rule_id, f.rule_name_snapshot]));

  const dimensionsRaw = Array.isArray(o.dimensions) ? o.dimensions : [];
  const dimensions: VerifierDimension[] = dimensionsRaw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => ({
      key: asString(d.key) || 'dimension',
      label: asString(d.label) || asString(d.key),
      score: clampScore(d.score),
      reasoning: asString(d.reasoning),
    }));

  const opinionsRaw = Array.isArray(o.rule_opinions) ? o.rule_opinions : [];
  let agreementCount = 0;
  let agreementTotal = 0;
  const rule_opinions: RuleOpinion[] = opinionsRaw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => {
      const rule_id = asString(r.rule_id);
      const second_verdict = normSecondVerdict(r.second_verdict);
      const original_result = resultByRuleId.get(rule_id) ?? 'UNKNOWN';
      const agrees = verdictsAgree(second_verdict, original_result);
      // Only count rules that exist in the audit (ignore hallucinated ids) and
      // skip NOT_APPLICABLE-vs-NOT_APPLICABLE noise toward the headline rate by
      // still counting them (they are genuine agreements). UNSURE counts as a
      // compared-but-disagreed row so it lowers confidence honestly.
      if (resultByRuleId.has(rule_id)) {
        agreementTotal += 1;
        if (agrees) agreementCount += 1;
      }
      const dimsRaw = Array.isArray(r.dimensions) ? r.dimensions : [];
      const dimensions: RuleDimension[] = dimsRaw
        .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
        .map((d) => ({ key: asString(d.key) || 'dimension', score: clampScore(d.score) }));
      // judgment_reasoning is the rich field; fall back to a legacy `reasoning`.
      const judgment_reasoning = asString(r.judgment_reasoning) || asString(r.reasoning);
      return {
        rule_id,
        rule_name: asString(r.rule_name) || nameByRuleId.get(rule_id) || rule_id,
        selection_ok: r.selection_ok === false ? false : true,
        selection_reasoning: asString(r.selection_reasoning),
        second_verdict,
        agrees,
        original_result,
        judgment_reasoning,
        confidence: clampScore(r.confidence),
        dimensions,
      };
    });

  const missingRaw = Array.isArray(o.missing_rules) ? o.missing_rules : [];
  const missing_rules = missingRaw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map((m) => ({ concern: asString(m.concern), rule_hint: asString(m.rule_hint) || undefined }))
    .filter((m) => m.concern);

  const overRaw = Array.isArray(o.over_included_rules) ? o.over_included_rules : [];
  const over_included_rules = overRaw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({ rule_id: asString(r.rule_id), reasoning: asString(r.reasoning) }))
    .filter((r) => r.rule_id);

  const agreement_rate = agreementTotal > 0 ? Math.round((agreementCount / agreementTotal) * 100) : 0;

  return {
    overall_confidence: clampScore(o.overall_confidence),
    verdict: normVerdict(o.verdict),
    summary: asString(o.summary),
    dimensions,
    rule_opinions,
    missing_rules,
    over_included_rules,
    agreement_rate,
    agreement_count: agreementCount,
    agreement_total: agreementTotal,
  };
}
