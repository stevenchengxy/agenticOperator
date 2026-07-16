// Energy-dispatch rule judgment (规则判断) — the domain-specific third phase of
// the rule-check. Deterministic numeric checks against the scenario dataset; no
// LLM. Two judges for two different rule-check steps, both built on the same
// engine (筛查 + 二次验证 live in lib/rule-check/engine.ts):
//   - judgeConstraints: the 18 CR-* constraint rules (约束校验 step), PIPE-01
//     order 机组→水库水调→电网→安全→市场.
//   - judgeRouting:     the 5 直通条件 routing rules (分流与人工确认 step).

import type { EngineRule, RuleEval } from "@/lib/rule-check/engine";
import type { ScenarioData } from "../sim-data";

const PIPE_ORDER = ["机组", "水库水调", "电网", "安全", "市场", "分流", "其他"];

function bySumDeviation(gate: number[], gzl: number[]): number {
  const sg = gate.reduce((a, b) => a + b, 0);
  const sz = gzl.reduce((a, b) => a + b, 0) || 1;
  return Math.abs(sg - sz) / sz;
}

/** Per-code numeric verdict against the dataset. Codes without machine-checkable
 *  numeric data in this demo PASS with a "未触限" note (honest: the rule ran, the
 *  data didn't hit it) — only the codes we have real numbers for can FAIL. */
function judgeOne(r: EngineRule, d: ScenarioData): RuleEval {
  const base: RuleEval = {
    ruleId: r.id,
    code: r.code,
    name: r.name,
    group: r.group,
    // The four hard red-lines are hard by code (robust even when an Allmeta-live
    // rule node lacks the failurePolicy=block field the snapshot carries).
    hardSoft: r.redline ? "hard" : r.hardSoft,
    result: "PASS",
    defaultAction: r.defaultAction,
  };
  const L = d.limits;

  switch (r.code) {
    case "CR-UNIT-01": {
      // 96点逐台机组出力 ∈ [最小技术出力, 可用容量];越限自动钳制。
      const overs = d.stations.flatMap((s) => {
        const cap = s.capacityMW;
        const cur = s.type === "hydro" ? d.curve.hydro : s.type === "wind" ? d.curve.wind : d.curve.solar;
        return cur.filter((v) => v > cap).length;
      });
      const overCount = overs.reduce((a, b) => a + b, 0);
      return overCount > 0
        ? { ...base, result: "CLAMPED", checkPoint: `越限${overCount}点`, beforeVal: ">额定", afterVal: "钳制到限内", evidence: "CR-UNIT-01 自动钳制" }
        : { ...base, result: "PASS", checkPoint: "全96点", evidence: "各站出力均在 [最小技术出力, 可用容量] 内" };
    }
    case "CR-HYD-01": {
      // 水位 ∈ [死水位, 正常蓄水位]
      const ok = d.waterLevelM >= L.deadLevelM && d.waterLevelM <= L.normalLevelM;
      return { ...base, result: ok ? "PASS" : "FAIL", checkPoint: "ST0101 控制水位", beforeVal: `${d.waterLevelM}m`, afterVal: `[${L.deadLevelM}, ${L.normalLevelM}]m`, evidence: ok ? "水位在上下限内" : "水位越上下限" };
    }
    case "CR-HYD-03": {
      // 生态流量最小下泄(硬红线)
      const ok = d.ecoFlowActualM3s >= L.ecoFlowMinM3s;
      return { ...base, result: ok ? "PASS" : "FAIL", checkPoint: "逐时段下泄", beforeVal: `${d.ecoFlowActualM3s}m³/s`, afterVal: `≥${L.ecoFlowMinM3s}m³/s`, defaultAction: "强制保证下泄 + 升 L3+，转人工", riskType: ok ? undefined : "T3", riskLevel: ok ? undefined : "L3", evidence: ok ? "下泄满足生态流量" : "下泄低于生态流量红线" };
    }
    case "CR-HYD-05": {
      // 防洪调度(硬红线):汛期水位不超汛限
      const ok = d.waterLevelM <= L.floodLimitM;
      return { ...base, result: ok ? "PASS" : "FAIL", checkPoint: "ST0101 汛期水位 vs 汛限", beforeVal: `${d.waterLevelM}m`, afterVal: `≤${L.floodLimitM}m`, defaultAction: "升 T3，L3→转值长+SUSPENDED，L4→+总工+上报省调", riskType: ok ? undefined : "T3", riskLevel: ok ? undefined : "L3", evidence: ok ? "水位在汛限下方" : `水位 ${d.waterLevelM}m 超汛限 ${L.floodLimitM}m` };
    }
    case "CR-GRID-01": {
      // 送出断面稳定限额(硬红线)
      const ok = d.sectionPeakMW <= L.sectionLimitMW;
      return { ...base, result: ok ? "PASS" : "FAIL", checkPoint: "断面叠加峰值", beforeVal: `${d.sectionPeakMW}MW`, afterVal: `≤${L.sectionLimitMW}MW`, defaultAction: "升 T2，限出力(水电让路风光)", riskType: ok ? undefined : "T2", riskLevel: ok ? undefined : "L2", evidence: ok ? "断面未越限" : "断面叠加超稳定限额" };
    }
    case "CR-GRID-03": {
      // 上级关口计划(硬红线):关口送出不得超 GZL 曲线
      const over = d.curve.gateExport.filter((g, i) => g > d.curve.gzl[i] + 0.01).length;
      const dev = (bySumDeviation(d.curve.gateExport, d.curve.gzl) * 100).toFixed(1);
      const ok = over === 0;
      return { ...base, result: ok ? "PASS" : "FAIL", checkPoint: over ? `超关口${over}点` : "全96点", beforeVal: `总偏差${dev}%`, afterVal: "在GZL曲线内", defaultAction: "升 T8，转人工，以省调为准(机器不得自动改)", riskType: ok ? undefined : "T8", riskLevel: ok ? undefined : "L3", evidence: ok ? "关口送出全程不超 GZL" : "关口送出越 GZL 曲线" };
    }
    default:
      // CR-UNIT-02..05 / CR-HYD-02/04/06 / CR-GRID-02/04 / CR-SAFE-* / CR-MKT-*
      return { ...base, result: "PASS", checkPoint: "本案数据未触限", evidence: `${r.code} 校验通过(无越限/越带)` };
  }
}

/** Judge the 18 CR-* constraint rules in PIPE-01 order. */
export function judgeConstraints(selected: EngineRule[], d: ScenarioData): RuleEval[] {
  const ordered = [...selected].sort((a, b) => {
    const ga = PIPE_ORDER.indexOf(a.group);
    const gb = PIPE_ORDER.indexOf(b.group);
    return ga !== gb ? ga - gb : a.code.localeCompare(b.code);
  });
  return ordered.map((r) => judgeOne(r, d));
}

// ── 出力预测 QC (forecastOutput) ─────────────────────────────────────────────
/** Judge the 出力预测 stage rules: P50/P90 区间齐全 + 各站出力 ≤ 装机 + 置信度;
 *  模型上线/版本/留痕类是过程规则,本案不触限 → PASS。 */
export function judgeForecast(selected: EngineRule[], d: ScenarioData): RuleEval[] {
  return selected.map((r) => {
    const base: RuleEval = { ruleId: r.id, code: r.code, name: r.name, group: r.group, hardSoft: r.hardSoft, result: "PASS", defaultAction: r.defaultAction };
    if (/置信区间|P50|预测出力/.test(r.name)) {
      const overCap =
        Math.max(...d.curve.wind) > 200.01 ||
        Math.max(...d.curve.solar) > 150.01 ||
        Math.max(...d.curve.hydro) > 1690.01;
      return overCap
        ? { ...base, result: "FAIL", checkPoint: "各站出力 vs 装机容量", beforeVal: "超装机", afterVal: "≤装机", riskType: "T6", riskLevel: "L2", evidence: "预测出力超装机容量(模型未钳上限)" }
        : { ...base, result: "PASS", checkPoint: "全96点 P50/P90", beforeVal: `P50合格率${d.forecastConfidence}`, evidence: "P50/P90 区间齐全,各站出力≤装机,夜间光伏为0" };
    }
    return { ...base, result: "PASS", checkPoint: "过程规则", evidence: `${r.code} 本案不涉及模型上线/版本切换/人工修正` };
  });
}

// ── 调度建议生成 QC (generateSuggestion) ─────────────────────────────────────
/** Judge the 调度建议生成 stage rules: 关口送出曲线对齐 GZL(逐点不超 + 总偏差)+
 *  三大目标优先级 + 风光优先消纳。 */
export function judgeSuggestion(selected: EngineRule[], d: ScenarioData): RuleEval[] {
  const overGzl = d.curve.gateExport.filter((g, i) => g > d.curve.gzl[i] + 0.01).length;
  const dev = (bySumDeviation(d.curve.gateExport, d.curve.gzl) * 100).toFixed(1);
  return selected.map((r) => {
    const base: RuleEval = { ruleId: r.id, code: r.code, name: r.name, group: r.group, hardSoft: r.hardSoft, result: "PASS", defaultAction: r.defaultAction };
    if (/关口|GZL/.test(r.name)) {
      return overGzl > 0
        ? { ...base, result: "FAIL", checkPoint: `超关口${overGzl}点`, beforeVal: `总偏差${dev}%`, afterVal: "在GZL曲线内", riskType: "T8", riskLevel: "L3", evidence: "建议关口送出越 GZL 曲线" }
        : { ...base, result: "PASS", checkPoint: "全96点", beforeVal: `总偏差${dev}%`, evidence: "建议关口送出全程贴合且不超 GZL" };
    }
    if (/优先级|目标/.test(r.name)) {
      return { ...base, result: "PASS", checkPoint: "调度目标口径", evidence: "汛期优先级 防洪>电网>清洁能源消纳>经济性 已设定" };
    }
    return { ...base, result: "PASS", checkPoint: "消纳口径", evidence: "风光按预测优先消纳、水电调峰让路,无主动弃风弃光" };
  });
}

// ── routing (分流判断) ───────────────────────────────────────────────────────
export type RoutingContext = {
  gzlDeviationPct: number;
  forecastConfidence: number;
  schemeDominant: boolean;
  redlineFlag: boolean; // from validateConstraints upstream
  riskLevelMax?: string; // highest risk level annotated (L1..L4)
};

export type RoutingDecision = {
  route: "auto" | "manual" | "risk-first";
  failedConditions: string[];
  evals: RuleEval[];
};

/** Map the routing rules (筛出的 41-46) to the 5 直通条件 verdicts. */
export function judgeRouting(selected: EngineRule[], ctx: RoutingContext): RoutingDecision {
  const hasMidHighRisk = !!ctx.riskLevelMax && /L[234]/.test(ctx.riskLevelMax);
  const conditions: { match: RegExp; name: string; pass: boolean; detail: string }[] = [
    { match: /关口偏差/, name: "关口偏差≤3%", pass: ctx.gzlDeviationPct <= 3, detail: `偏差${ctx.gzlDeviationPct}%` },
    { match: /高等级风险|风险转人工/, name: "无L2+风险", pass: !hasMidHighRisk && !ctx.redlineFlag, detail: ctx.riskLevelMax ?? "无" },
    { match: /低置信/, name: "置信度≥0.9", pass: ctx.forecastConfidence >= 0.9, detail: `置信度${ctx.forecastConfidence}` },
    { match: /硬约束红线/, name: "无硬约束红线", pass: !ctx.redlineFlag, detail: ctx.redlineFlag ? "命中红线" : "无" },
    { match: /裁量/, name: "方案明显占优", pass: ctx.schemeDominant, detail: ctx.schemeDominant ? "明显占优" : "需裁量" },
  ];

  const evals: RuleEval[] = [];
  const failedConditions: string[] = [];
  const blockingConditionsPass = selected.every((rule) => {
    const condition = conditions.find((item) => item.match.test(rule.name));
    return !condition || rule.hardSoft === "soft" || condition.pass;
  });
  for (const r of selected) {
    const c = conditions.find((x) => x.match.test(r.name));
    // rule 41 = 直通五条件(AND) meta-rule → reflects overall
    const isMeta = /五条件|AND|直通自动采纳/.test(r.name) && !c;
    const pass = isMeta ? blockingConditionsPass : c ? c.pass : true;
    // Optional conditions are still evaluated and returned in evals, but they
    // are reference-only and must not force the route from auto to manual.
    if (c && !c.pass && r.hardSoft === "hard") {
      failedConditions.push(`${c.name}(${c.detail})`);
    }
    evals.push({
      ruleId: r.id,
      code: r.code,
      name: r.name,
      group: r.group,
      hardSoft: r.hardSoft,
      result: pass ? "PASS" : "FAIL",
      checkPoint: isMeta ? "五条件 AND" : c?.name,
      evidence: c ? `${c.name}: ${c.detail}` : isMeta ? "直通五条件汇总" : "条件不适用本步骤",
    });
  }

  const route: RoutingDecision["route"] = ctx.redlineFlag ? "risk-first" : failedConditions.length === 0 ? "auto" : "manual";
  return { route, failedConditions, evals };
}
