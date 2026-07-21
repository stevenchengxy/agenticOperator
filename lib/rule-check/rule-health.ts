// Rule-health aggregation — pure, testable core for the 规则检查 · 总览
// (rule-centric overview). Given each audit's outcome + which rules it
// assessed, decide per rule: how often it was evaluated, how often it actually
// blocked a candidate (失败), and a health label. Binary outcome model — there
// is no "判不了" here: a rule either let the candidate through (通过) or it was
// the/a reason they were rejected (失败).
//
// "失败 for a rule" is the TRUTHFUL "this rule rejected this candidate" count —
// read from the audit's failure_reasons (which already incorporates the
// fail-closed fold: 底线 rules whose data was insufficient end up blocking). It
// is NOT re-derived from raw flag results, so passed + failed === evaluated and
// the numbers match what the candidate actually experienced.
//
// Infra-parked audits (LLM 没钱/故障) carry no per-rule judgment and are skipped
// here entirely — they surface as a separate 校验-level signal, not on any rule.

import { isInfraFailure } from './infra-failure';

// 'unassessed' = 规则不在 rule-check(简历匹配)评估范围内(别的阶段,本 agent 不跑它)。
// 跟 'dead'(在范围内但从未发火)区分,避免把 30+ 个阶段的规则误算成「死规则」。
export type RuleHealth = 'blocking' | 'idle' | 'dead' | 'unassessed';

export type RuleHealthRow = {
  rule_id: string;
  name: string;
  severity: string;
  /** 规则所属阶段(specificScenarioStage)— 总览按阶段分类筛选用。 */
  stage: string;
  /** 规则逻辑正文(standardizedLogicRule,截断)— 总览搜索「内容」用。 */
  logic: string;
  /** Audits where this rule was assessed against the candidate. */
  evaluated: number;
  /** Audits this rule let through (evaluated − failed). */
  passed: number;
  /** Audits this rule rejected the candidate in (from failure_reasons). */
  failed: number;
  health: RuleHealth;
};

export type RuleHealthTotals = {
  rules_total: number;
  rules_fired: number;
  rules_dead: number;
  blocking_rules: number;
  /** 不在 rule-check 评估范围内(非简历匹配阶段)的规则数。 */
  rules_unassessed: number;
};

/** One audit's outcome, DB-agnostic so the aggregator stays pure/testable. */
export type AuditOutcome = {
  decision: string; // 'PASS' | 'FAIL'
  fail_reason: string | null; // infra marker — non-null = parked (skip)
  failure_reasons: string; // JSON array string (formatExplanation entries)
  /** rule_ids this audit actually assessed (from flags / recovered raw). */
  assessed_rule_ids: string[];
};

export type RuleMeta = { name: string; severity: string; stage?: string; logic?: string };

/**
 * Pull the rule_ids that actually blocked a candidate out of a FAIL audit's
 * failure_reasons. Each entry is `formatExplanation` output, e.g.
 * `[10-45] 腾讯正编转外包回流标记（信息不足·需人工复核）: …` → "10-45".
 */
export function extractBlockingRuleIds(failureReasonsJson: string | null | undefined): string[] {
  if (!failureReasonsJson) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(failureReasonsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const ids: string[] = [];
  for (const entry of arr) {
    if (typeof entry !== 'string') continue;
    const m = entry.match(/^\s*\[([^\]]+)\]/);
    if (m && m[1].trim()) ids.push(m[1].trim());
  }
  return ids;
}

/**
 * blocking = ever rejected someone; idle = fired but never rejects;
 * dead = in-scope(简历匹配)but never fired; unassessed = 不在 rule-check 评估范围内。
 * @param inScope 该规则是否在 rule-check(简历匹配)评估范围内。默认 true(向后兼容)。
 */
export function classifyRuleHealth(evaluated: number, failed: number, inScope = true): RuleHealth {
  if (evaluated > 0) return failed > 0 ? 'blocking' : 'idle';
  return inScope ? 'dead' : 'unassessed';
}

/**
 * Aggregate per-rule health from audit outcomes.
 *
 * @param audits        outcomes in the window (infra-parked ones are skipped)
 * @param ruleMeta      rule_id → {name, severity} from the ontology rule set
 * @param ontologyIds   the full ontology rule id set (drives rules_total / Dead)
 */
export function aggregateRuleHealth(
  audits: AuditOutcome[],
  ruleMeta: Map<string, RuleMeta>,
  ontologyIds: string[],
): { rules: RuleHealthRow[]; dead_rules: Array<{ rule_id: string; name: string }>; totals: RuleHealthTotals } {
  const evaluated = new Map<string, number>();
  const failed = new Map<string, number>();

  for (const a of audits) {
    if (isInfraFailure(a.fail_reason)) continue;
    const blocked =
      a.decision === 'FAIL' ? new Set(extractBlockingRuleIds(a.failure_reasons)) : new Set<string>();
    // A rule counts as evaluated if it was assessed OR it blocked (defensive:
    // a blocker should always have been assessed, but failure_reasons is the
    // authority on blocking, so union the two).
    const seen = new Set<string>(a.assessed_rule_ids);
    for (const rid of blocked) seen.add(rid);
    for (const rid of seen) {
      evaluated.set(rid, (evaluated.get(rid) ?? 0) + 1);
      if (blocked.has(rid)) failed.set(rid, (failed.get(rid) ?? 0) + 1);
    }
  }

  // rule-check(matchResume)只评估「简历匹配」阶段的规则 → 这一阶段算「在评估范围内」,
  // 其它阶段的规则即使从未发火也只是「未评估(unassessed)」,不算「死规则」。
  const STAGE_IN_SCOPE = '简历匹配';

  // 全量目录:只列**当前 live 本体里存在的规则**(ontologyIds)。已从 Neo4j 删除/改号
  // 的「孤儿规则」(发过火但本体里已没有)不再提取 —— 总览只反映当前本体。
  // 例外:本体不可用(ontologyIds 空,ontology API 宕)时降级为「列发过火的」,避免总览空白。
  const allIds =
    ontologyIds.length > 0 ? new Set<string>(ontologyIds) : new Set<string>(evaluated.keys());
  const rules: RuleHealthRow[] = [];
  for (const rule_id of allIds) {
    const ev = evaluated.get(rule_id) ?? 0;
    const fl = failed.get(rule_id) ?? 0;
    const meta = ruleMeta.get(rule_id);
    const stage = meta?.stage ?? '';
    const inScope = stage === STAGE_IN_SCOPE;
    rules.push({
      rule_id,
      name: meta?.name || rule_id,
      severity: meta?.severity || '',
      stage,
      logic: meta?.logic ?? '',
      evaluated: ev,
      passed: ev - fl,
      failed: fl,
      health: classifyRuleHealth(ev, fl, inScope),
    });
  }
  // Most-impactful first: rules that reject people, then by volume, then id.
  rules.sort((a, b) => b.failed - a.failed || b.evaluated - a.evaluated || a.rule_id.localeCompare(b.rule_id));

  // dead_rules 保留为「在评估范围内但从未发火」的 in-scope 死规则(侧栏 Dead 列表用)。
  const dead_rules = rules
    .filter((r) => r.health === 'dead')
    .map((r) => ({ rule_id: r.rule_id, name: r.name }))
    .sort((a, b) => a.rule_id.localeCompare(b.rule_id));

  const rules_total = ontologyIds.length;
  return {
    rules,
    dead_rules,
    totals: {
      rules_total,
      rules_fired: rules.filter((r) => r.evaluated > 0).length,
      rules_dead: rules.filter((r) => r.health === 'dead').length,
      blocking_rules: rules.filter((r) => r.health === 'blocking').length,
      rules_unassessed: rules.filter((r) => r.health === 'unassessed').length,
    },
  };
}
