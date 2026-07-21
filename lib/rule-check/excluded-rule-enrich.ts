// 读时把 rule_provenance 用**live 规则目录**(getLiveRuleCatalog,优先 Neo4j、
// 打包兜底)按 id 补全名称/定义。provenance 只存 {rule_id,tier,included,reason}
// —— 排除规则的可读名称/逻辑定义不落库,这里按 id 现查 live 目录补回,供详情 UI
// 展示 + verify 喂给第二模型。改 Neo4j 立即对齐,不再硬编码读打包文件。
import { getLiveRuleCatalog } from './live-rule-catalog';
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

export async function enrichProvenanceWithNames(
  prov: RuleProvenance[],
): Promise<EnrichedProvenance[]> {
  const byId = await getLiveRuleCatalog();
  return prov.map((p) => {
    const r = byId.get(p.rule_id);
    return r ? { ...p, rule_name: r.businessLogicRuleName } : { ...p };
  });
}

export async function buildExcludedRules(
  prov: Array<{ rule_id: string; tier: string; included: boolean; reason: string }>,
): Promise<ExcludedRule[]> {
  const byId = await getLiveRuleCatalog();
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
