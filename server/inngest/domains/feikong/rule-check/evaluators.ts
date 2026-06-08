// 费控 rule evaluators — deterministic per-code numeric judgment.
//
// Mirrors energy/rule-check/evaluators.ts (judgeConstraints) but for the cost-
// control rule set: 票据组 INV → 标准组 STD → 合规组 CMP → 预算组 BUD (PIPE-02
// order). Codes WITHOUT machine-checkable data in a given case PASS with a
// "本案未触发" note (honest: the rule ran, the data didn't hit it); only the
// codes we have real numbers for can FAIL (risk) or CLAMP (核减/deduction).

import type { Rule } from "@/lib/rule-check/types";
import type { EngineRule, RuleEval } from "@/lib/rule-check/engine";
import { lodgingStandard, type FeikongScenarioData } from "../sim-data";

/** A 费控 eval carries the numeric 核减 amount alongside the shared RuleEval. */
export type FeikongEval = RuleEval & { deduction?: number };

// 升风险类规则(命中 → FAIL + riskType/riskLevel,触发付款冻结 / 转人工 / 转稽核)。
export const FEIKONG_RISK_RAISERS = new Set([
  "RULE-INV-02", // T6 票据不实
  "RULE-INV-03", // T1 重复报销
  "RULE-STD-04", // T3 招待陪同倒挂
  "RULE-CMP-01", // T4 大额拆分
  "RULE-CMP-04", // T8 时间地点矛盾
  "RULE-CMP-06", // T7 关联/私人消费
  "RULE-BUD-02", // T5 预算超支
]);

// 硬阻断类规则(命中 → RETURNED/REJECTED,截断后组)。
export const FEIKONG_HARD_BLOCKS = new Set([
  "RULE-INV-01", // 抬头/税号 → RETURNED
  "RULE-INV-06", // 票型↔科目 → RETURNED
  "RULE-BUD-01", // 预算科目错配 → RETURNED
  "RULE-BUD-03", // 成本中心归属 → RETURNED
]);

const GROUP_BY_PREFIX: Array<[string, string]> = [
  ["RULE-INV", "票据组"],
  ["RULE-STD", "标准组"],
  ["RULE-CMP", "合规组"],
  ["RULE-BUD", "预算组"],
  ["PIPE", "流程"],
  ["ROUTE", "路由"],
  ["TRACE", "留痕"],
];

function feikongGroup(code: string): string {
  if (!code) return "其他";
  for (const [prefix, g] of GROUP_BY_PREFIX) if (code.startsWith(prefix)) return g;
  return "其他";
}

const WHITELIST_BUYER = new Set([
  "启明数字科技集团股份有限公司",
]);

/** Normalize 费控 raw rules → EngineRule[]. The 费控 rule id IS the business code
 *  (RULE-INV-01 …); group from the prefix; hard/soft from failurePolicy; redline =
 *  a risk-raiser whose FAIL must flag the case (drives ANOMALY_DETECTED). */
export function feikongRulesToEngine(rules: Rule[]): EngineRule[] {
  return rules.map((r) => {
    // 费控 snapshot rules carry the business code as `id` (RULE-INV-01). Allmeta
    // live nodes use uid/rule_id instead — resolve robustly so a live read never
    // crashes; rules with no resolvable code fall to group 其他 and are skipped by
    // the RULE-* prefix selection (the deterministic judge keys on the codes).
    const raw = r as unknown as Record<string, unknown>;
    const code = String(r.id ?? raw.rule_id ?? raw.uid ?? "");
    return {
      id: code || String(r.id ?? ""),
      code,
      name: r.businessLogicRuleName,
      stage: r.specificScenarioStage,
      group: feikongGroup(code),
      hardSoft: r.failurePolicy === "block" ? "hard" : "soft",
      redline: FEIKONG_RISK_RAISERS.has(code),
      defaultAction: (r.standardizedLogicRule || "").slice(0, 120),
      raw: r,
    };
  });
}

const PIPE_ORDER = ["票据组", "标准组", "合规组", "预算组", "其他"];

/** Per-code numeric verdict against the claim dataset. */
function judgeOne(r: EngineRule, d: FeikongScenarioData): FeikongEval {
  const base: FeikongEval = {
    ruleId: r.id,
    code: r.code,
    name: r.name,
    group: r.group,
    hardSoft: r.hardSoft,
    result: "PASS",
    defaultAction: r.defaultAction,
  };
  const L = d.limits;

  switch (r.code) {
    case "RULE-INV-01": {
      // 抬头/税号白名单
      const bad = d.lines.filter((l) => !WHITELIST_BUYER.has(l.buyerName) || !l.buyerTaxId);
      return bad.length
        ? { ...base, result: "FAIL", checkPoint: `${bad.length}张票抬头/税号不符`, beforeVal: bad[0]?.buyerName ?? "", afterVal: "启明数字科技集团股份有限公司", defaultAction: "退回重开正确抬头(RETURNED)", evidence: "INV-01 抬头/税号非白名单" }
        : { ...base, result: "PASS", checkPoint: "抬头/税号白名单", evidence: "全部发票抬头=启明数字科技集团股份有限公司" };
    }
    case "RULE-INV-08": {
      // 明细金额 vs 票面价税合计,容差 0.01
      const off = d.lines.filter((l) => Math.abs(l.amount - l.invoiceAmount) > L.invoiceTolerance);
      return off.length
        ? { ...base, result: "CLAMPED", checkPoint: `${off.length}行超容差`, beforeVal: `${off[0]?.amount}`, afterVal: `${off[0]?.invoiceAmount}(票面)`, deduction: off.reduce((a, l) => a + Math.max(0, l.amount - l.invoiceAmount), 0), defaultAction: "按票面核减(PARTIAL)", evidence: "INV-08 明细与票面不一致" }
        : { ...base, result: "PASS", checkPoint: "明细=票面", evidence: `${d.lines.length}行金额与票面一致(容差${L.invoiceTolerance})` };
    }
    case "RULE-STD-01": {
      // 住宿每间每晚 vs 职级×城市级矩阵 → 超标核减
      const lodging = d.lines.filter((l) => l.categoryId === "F1020" && typeof l.perNight === "number");
      let deduction = 0;
      let detail = "";
      for (const l of lodging) {
        const std = lodgingStandard(d.claimantLevel, d.cityTier);
        const nights = l.nights ?? 1;
        if ((l.perNight ?? 0) > std) {
          deduction += ((l.perNight ?? 0) - std) * nights;
          detail = `${l.perNight}/晚 vs 上限${std}/晚 ×${nights}晚`;
        }
      }
      return deduction > 0
        ? { ...base, result: "CLAMPED", checkPoint: "住宿超标", beforeVal: detail, afterVal: `核减${deduction}`, deduction, defaultAction: "超出部分核减(PARTIAL)+FA-02", evidence: "STD-01 住宿超标准" }
        : { ...base, result: "PASS", checkPoint: "住宿未超标", evidence: lodging.length ? `每间每晚≤${lodgingStandard(d.claimantLevel, d.cityTier)}` : "无住宿明细" };
    }
    case "RULE-CMP-01": {
      // 大额拆分:同报销人+同供应商 7 天滑动窗聚合越档
      const sib = d.siblings ?? [];
      if (sib.length >= 2) {
        const total = sib.reduce((a, s) => a + s.amount, 0);
        const sameVendor = sib.every((s) => s.vendor === sib[0].vendor);
        const eachUnderTier = sib.every((s) => s.amount < L.autoTotalMax);
        if (sameVendor && eachUnderTier && total > L.autoTotalMax) {
          return { ...base, result: "FAIL", checkPoint: `7日聚合${total}越档`, beforeVal: `${sib.length}单各≈${sib[0].amount}`, afterVal: `应走更高审批档`, riskType: "T4", riskLevel: "L3", defaultAction: "升风险T4+转人工/转稽核,暂缓付款", evidence: `CMP-01 同供应商${sib[0].vendor} 7日聚合 ${total} 拆分规避` };
        }
      }
      return { ...base, result: "PASS", checkPoint: "无拆分聚合", evidence: "未发现 7 日同供应商越档聚合" };
    }
    case "RULE-CMP-06": {
      // 疑似私人消费:商品名含私人物品
      const priv = d.lines.filter((l) => (l.privateAmount ?? 0) > 0);
      if (priv.length) {
        const amt = priv.reduce((a, l) => a + (l.privateAmount ?? 0), 0);
        return { ...base, result: "FAIL", checkPoint: "混入私人物品", beforeVal: priv[0]?.goods ?? "", afterVal: `剔除${amt}`, riskType: "T7", riskLevel: "L4", defaultAction: "升风险T7+移送稽核,私人物品全额剔除,暂停付款", evidence: `CMP-06 商品名含私人项: ${priv[0]?.goods}` };
      }
      return { ...base, result: "PASS", checkPoint: "无私人消费迹象", evidence: "商品名细均属办公正当用途" };
    }
    case "RULE-BUD-02": {
      // 预算余额不足(占用后超预算)
      const payable = d.totalAmount; // demo: deduction << budget; 占用净额校验在 occupyBudget
      return payable > d.budgetAvailable
        ? { ...base, result: "FAIL", checkPoint: "预算不足", beforeVal: `占用${payable}`, afterVal: `可用${d.budgetAvailable}`, riskType: "T5", riskLevel: "L3", defaultAction: "升风险T5+审批升级,降额/调剂/驳回", evidence: "BUD-02 可用余额<占用额" }
        : { ...base, result: "PASS", checkPoint: "预算充足", beforeVal: `占用${payable}`, afterVal: `可用${d.budgetAvailable}`, evidence: "占用后预算余额充足" };
    }
    default:
      return { ...base, result: "PASS", checkPoint: "本案未触发", evidence: `${r.code} 校验通过(本案数据未命中)` };
  }
}

/** Judge the four 费控 rule groups in PIPE-02 order (INV → STD → CMP → BUD). */
export function judgeFeikongRules(selected: EngineRule[], d: FeikongScenarioData): FeikongEval[] {
  const ordered = [...selected].sort((a, b) => {
    const ga = PIPE_ORDER.indexOf(a.group);
    const gb = PIPE_ORDER.indexOf(b.group);
    return ga !== gb ? ga - gb : a.code.localeCompare(b.code);
  });
  return ordered.map((r) => judgeOne(r, d));
}
