import { describe, it, expect } from "vitest";
import type { Rule } from "@/lib/rule-check/types";
import { toEngineRules, selectRules, verifySelection, hasRedlineHit, HARD_REDLINES } from "@/lib/rule-check/engine";
import { judgeConstraints, judgeRouting, judgeForecast, judgeSuggestion } from "./evaluators";
import { buildScenarioData, SCENARIOS } from "../sim-data";

// minimal CR rule fixtures (snapshot shape: numeric id, CR code in name)
function cr(id: string, name: string, block: boolean): Rule {
  return {
    id,
    specificScenarioStage: "约束校验",
    businessLogicRuleName: name,
    applicableClient: "通用",
    applicableDepartment: "调度中心",
    submissionCriteria: "",
    standardizedLogicRule: `逻辑:${name}`,
    relatedEntities: [],
    businessBackgroundReason: "",
    ruleSource: "统一设定基线",
    executor: "Agent",
    enforcementLevel: "mandatory",
    failurePolicy: block ? "block" : "warn",
  };
}

const CONSTRAINT_RULES: Rule[] = [
  cr("16", "CR-UNIT-01 机组出力上下限", false),
  cr("21", "CR-HYD-01 水位上下限", true),
  cr("23", "CR-HYD-03 生态流量最小下泄", true),
  cr("25", "CR-HYD-05 防洪调度", true),
  cr("27", "CR-GRID-01 送出断面/通道稳定限额", true),
  cr("29", "CR-GRID-03 上级关口计划/调度指令", true),
  cr("34", "CR-MKT-02 偏差考核带", false),
];

function routeRule(id: string, name: string): Rule {
  return { ...cr(id, name, false), specificScenarioStage: "分流与人工确认" };
}
const ROUTING_RULES: Rule[] = [
  routeRule("41", "直通自动采纳五条件(AND)"),
  routeRule("42", "关口偏差超阈转人工"),
  routeRule("43", "高等级风险转人工"),
  routeRule("44", "低置信度预测转人工"),
  routeRule("45", "命中硬约束红线转人工"),
  routeRule("46", "需人工裁量场景转人工"),
];

describe("engine select + verify", () => {
  it("parses CR codes, groups, hard/soft and red-line flags", () => {
    const er = toEngineRules(CONSTRAINT_RULES);
    const hyd05 = er.find((r) => r.code === "CR-HYD-05")!;
    expect(hyd05.group).toBe("水库水调");
    expect(hyd05.hardSoft).toBe("hard");
    expect(hyd05.redline).toBe(true);
    const mkt = er.find((r) => r.code === "CR-MKT-02")!;
    expect(mkt.hardSoft).toBe("soft");
    expect(mkt.redline).toBe(false);
  });

  it("二次验证: flags a missing red-line", () => {
    const er = toEngineRules(CONSTRAINT_RULES.filter((r) => !r.businessLogicRuleName.includes("CR-HYD-05")));
    const v = verifySelection(er, HARD_REDLINES as unknown as string[]);
    expect(v.ok).toBe(false);
    expect(v.missing).toContain("CR-HYD-05");
  });

  it("二次验证: passes when all red-lines present", () => {
    const er = toEngineRules(CONSTRAINT_RULES);
    const v = verifySelection(er, HARD_REDLINES as unknown as string[]);
    expect(v.ok).toBe(true);
  });
});

describe("judgeConstraints", () => {
  it("happy: no red-line failures, PIPE-01 order", () => {
    const d = buildScenarioData("happy");
    const er = selectRules(toEngineRules(CONSTRAINT_RULES), { codePrefixes: ["CR-"] });
    const evals = judgeConstraints(er, d);
    expect(hasRedlineHit(evals)).toBe(false);
    // group order: 机组 before 水库水调 before 电网 before 市场
    const groups = evals.map((e) => e.group);
    expect(groups.indexOf("机组")).toBeLessThan(groups.indexOf("水库水调"));
    expect(groups.indexOf("水库水调")).toBeLessThan(groups.indexOf("电网"));
  });

  it("risk-redline: CR-HYD-05 防洪 FAILs (T3) → redline hit", () => {
    const d = buildScenarioData("risk-redline");
    const er = selectRules(toEngineRules(CONSTRAINT_RULES), { codePrefixes: ["CR-"] });
    const evals = judgeConstraints(er, d);
    const hyd05 = evals.find((e) => e.code === "CR-HYD-05")!;
    expect(hyd05.result).toBe("FAIL");
    expect(hyd05.riskType).toBe("T3");
    expect(hasRedlineHit(evals)).toBe(true);
  });
});

function stageRule(id: string, name: string, stage: string, block = true): Rule {
  return { ...cr(id, name, block), specificScenarioStage: stage };
}

describe("judgeForecast (出力预测)", () => {
  const rules = toEngineRules([
    stageRule("8", "出力预测置信区间生成", "出力预测"),
    stageRule("10", "模型版本切换不追溯重算", "出力预测"),
  ]);
  it("happy: P50/P90 present, stations within capacity → all PASS", () => {
    const evals = judgeForecast(rules, buildScenarioData("happy"));
    expect(evals.every((e) => e.result === "PASS")).toBe(true);
    expect(evals.find((e) => /置信区间/.test(e.name))?.beforeVal).toMatch(/0\.93/);
  });
  it("all scenarios keep wind ≤200 / solar ≤150 / hydro ≤1690 (no forecast FAIL)", () => {
    for (const s of SCENARIOS) {
      const evals = judgeForecast(rules, buildScenarioData(s));
      expect(evals.some((e) => e.result === "FAIL")).toBe(false);
    }
  });
});

describe("judgeSuggestion (调度建议生成)", () => {
  const rules = toEngineRules([
    stageRule("13", "建议关口送出曲线对齐 GZL", "调度建议生成"),
    stageRule("12", "三大目标优先级优化", "调度建议生成"),
  ]);
  it("non-redline scenarios: gate-export never over GZL → 关口对齐 PASS with deviation evidence", () => {
    for (const s of SCENARIOS) {
      const evals = judgeSuggestion(rules, buildScenarioData(s));
      const gzl = evals.find((e) => /关口|GZL/.test(e.name))!;
      expect(gzl.result).toBe("PASS");
      expect(gzl.beforeVal).toMatch(/总偏差/);
    }
  });
});

describe("judgeRouting", () => {
  const er = toEngineRules(ROUTING_RULES);

  it("happy: all 5 conditions pass → auto", () => {
    const d = buildScenarioData("happy");
    const r = judgeRouting(er, { gzlDeviationPct: d.gzlDeviationPct, forecastConfidence: d.forecastConfidence, schemeDominant: d.schemeDominant, redlineFlag: false });
    expect(r.route).toBe("auto");
    expect(r.failedConditions).toHaveLength(0);
  });

  it("manual-review: low confidence fails condition 3 → manual", () => {
    const d = buildScenarioData("manual-review");
    const r = judgeRouting(er, { gzlDeviationPct: d.gzlDeviationPct, forecastConfidence: d.forecastConfidence, schemeDominant: d.schemeDominant, redlineFlag: false });
    expect(r.route).toBe("manual");
    expect(r.failedConditions.join()).toMatch(/置信度/);
  });

  it("redline flag → risk-first", () => {
    const d = buildScenarioData("risk-redline");
    const r = judgeRouting(er, { gzlDeviationPct: d.gzlDeviationPct, forecastConfidence: d.forecastConfidence, schemeDominant: d.schemeDominant, redlineFlag: true });
    expect(r.route).toBe("risk-first");
  });
});
