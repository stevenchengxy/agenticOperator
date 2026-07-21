// 把全量 rule_provenance(已补 rule_name)+ 第二模型 selection 意见,折成
// UI 直接渲染的「选中 / 排除」两组 + 计数 + 每行的筛选 verdict。
// selection_ok 语义 = 「该不该为此候选人×岗位纳入」,与是否实际纳入交叉 → 四象限。
import type { EnrichedProvenance } from './excluded-rule-enrich';

export type FilterVerdict =
  | 'correct_included' // 纳入且 AI 认同应纳入
  | 'suspect_over' // 纳入但 AI 认为不该纳入(疑似多纳入)
  | 'correct_excluded' // 排除且 AI 认同不该纳入
  | 'suspect_missed' // 排除但 AI 认为应纳入(疑似漏选)
  | 'unknown'; // 尚无 AI 意见

export function filterVerdict(included: boolean, selectionOk: boolean | null): FilterVerdict {
  if (selectionOk === null) return 'unknown';
  if (included) return selectionOk ? 'correct_included' : 'suspect_over';
  return selectionOk ? 'suspect_missed' : 'correct_excluded';
}

export type RuleDisplayRow = {
  rule_id: string;
  rule_name: string;
  tier: string;
  included: boolean;
  reason: string;
  selection_ok: boolean | null;
  filter_verdict: FilterVerdict;
};

export function buildRuleDisplayModel(args: {
  provenance: EnrichedProvenance[];
  opinions: Array<{ rule_id: string; selection_ok: boolean }>;
}): {
  selected: RuleDisplayRow[];
  excluded: RuleDisplayRow[];
  counts: { total: number; selected: number; excluded: number };
} {
  const okById = new Map(args.opinions.map((o) => [o.rule_id, o.selection_ok]));
  const rows: RuleDisplayRow[] = args.provenance.map((p) => {
    const selection_ok = okById.has(p.rule_id) ? (okById.get(p.rule_id) as boolean) : null;
    return {
      rule_id: p.rule_id,
      rule_name: p.rule_name ?? '',
      tier: p.tier,
      included: p.included,
      reason: p.reason,
      selection_ok,
      filter_verdict: filterVerdict(p.included, selection_ok),
    };
  });
  const selected = rows.filter((r) => r.included);
  const excluded = rows.filter((r) => !r.included);
  return {
    selected,
    excluded,
    counts: { total: rows.length, selected: selected.length, excluded: excluded.length },
  };
}
