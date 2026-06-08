// 读时把 rule_provenance 用打包规则目录(loadAllRules)按 id 补全名称/定义。
// provenance 只存 {rule_id,tier,included,reason} — 排除规则的可读名称/逻辑
// 定义不落库,这里按 id 现查目录补回,供详情 UI 展示 + verify 喂给第二模型。
import { loadAllRules } from './ontology';
import type { RuleProvenance } from './types';

export type EnrichedProvenance = RuleProvenance & { rule_name?: string };

export type ExcludedRule = {
  rule_id: string;
  rule_name: string;
  applicable_client: string;
  applicable_department: string;
  tier: string;
  reason: string;
  definition: string;
};

function catalogById() {
  return new Map(loadAllRules().map((r) => [r.id, r]));
}

export function enrichProvenanceWithNames(prov: RuleProvenance[]): EnrichedProvenance[] {
  const byId = catalogById();
  return prov.map((p) => {
    const r = byId.get(p.rule_id);
    return r ? { ...p, rule_name: r.businessLogicRuleName } : { ...p };
  });
}

// 入参用结构化最小类型(而非 RuleProvenance),好让 route 那边 parseArray 出来的
// `tier: string` 宽类型直接传入,无需 as 桥接。RuleProvenance[] 也兼容。
export function buildExcludedRules(
  prov: Array<{ rule_id: string; tier: string; included: boolean; reason: string }>,
): ExcludedRule[] {
  const byId = catalogById();
  return prov
    .filter((p) => !p.included)
    .map((p) => {
      const r = byId.get(p.rule_id);
      return {
        rule_id: p.rule_id,
        rule_name: r?.businessLogicRuleName ?? '',
        applicable_client: r?.applicableClient ?? '',
        applicable_department: r?.applicableDepartment ?? '',
        tier: p.tier,
        reason: p.reason,
        definition: r?.standardizedLogicRule ?? '',
      };
    });
}
