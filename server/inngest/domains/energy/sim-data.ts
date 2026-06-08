// Deterministic energy-dispatch dataset for the runnable demo.
//
// Replaces the generic placeholder tool results with a faithful, reproducible
// dataset that matches the use-case baseline (00-能源调度辅助测试用例集 §2):
// 6 stations (龙盘梯级四级水电 + 滇中风电 + 高原光伏), 96-point (15-min) output
// / gate-export / GZL curves, water level, ecological flow, section limit,
// forecast confidence and gate deviation. One dataset per scenario; the scenario
// dataset is threaded verbatim through every event so the rule-check agents
// judge against real numbers and the human-gate cards show real evidence.
//
// Everything is a pure function of the scenario string + the 96-point index —
// NO randomness, so a re-run reproduces the same numbers (and tests can assert
// exact values).

export type Scenario = "happy" | "manual-review" | "risk-redline" | "finalize-confirm";

export const SCENARIOS: Scenario[] = ["happy", "manual-review", "risk-redline", "finalize-confirm"];

export const N_POINTS = 96; // 一天 96 个 15 分钟时段;第48点=12:00,第72点=18:00

// ── station baseline (用例 §2.1) ────────────────────────────────────────────
export type Station = {
  id: string;
  name: string;
  type: "hydro" | "wind" | "solar";
  capacityMW: number;
  units: number;
  minTechMW: number; // 最小技术出力(约额定30%);水电进振动区下限
};

export const STATIONS: Station[] = [
  { id: "ST0101", name: "龙盘一级", type: "hydro", capacityMW: 600, units: 2, minTechMW: 90 },
  { id: "ST0102", name: "龙盘二级", type: "hydro", capacityMW: 450, units: 3, minTechMW: 45 },
  { id: "ST0103", name: "龙盘三级", type: "hydro", capacityMW: 400, units: 4, minTechMW: 30 },
  { id: "ST0104", name: "龙盘四级", type: "hydro", capacityMW: 240, units: 2, minTechMW: 36 },
  { id: "ST0201", name: "滇中风电场", type: "wind", capacityMW: 200, units: 100, minTechMW: 0 },
  { id: "ST0202", name: "高原光伏电站", type: "solar", capacityMW: 150, units: 1, minTechMW: 0 },
];

const HYDRO_CAP = 600 + 450 + 400 + 240; // 1690MW 梯级合计

// ── 限值基线(用例 §2.6;数值不在 ontology rule JSON 里,固化在此当判据)──────
export const LIMITS = {
  normalLevelM: 1620, // ST0101 正常蓄水位
  floodLimitM: 1612, // 汛限水位(CR-HYD-05 红线)
  deadLevelM: 1580, // 死水位
  ecoFlowMinM3s: 300, // 生态流量最小下泄(CR-HYD-03 红线)
  sectionLimitMW: 1300, // 送出断面稳定限额(CR-GRID-01 红线)
  gzlTolerancePct: 3, // 关口送出 vs GZL 偏差直通阈(分流条件1)
  confidenceFloor: 0.9, // P50 合格率直通阈(分流条件3)
} as const;

// ── 96-point curve shapes (deterministic) ───────────────────────────────────
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
const round1 = (x: number): number => Math.round(x * 10) / 10;

/** 省调关口计划曲线 GZL:夜低 ~500、午高峰(48点)~1100、晚峰(76点)~1050。 */
function gzlCurve(): number[] {
  return Array.from({ length: N_POINTS }, (_, i) => {
    const noon = 1100 * Math.exp(-(((i - 48) / 14) ** 2));
    const eve = 950 * Math.exp(-(((i - 76) / 8) ** 2));
    const base = 480;
    return round1(clamp(base + noon + eve, 420, 1150));
  });
}

/** 高原光伏 ST0202:夜里为0,日出(~24点/06:00)到日落(~80点/20:00)钟形,峰 ~140MW。 */
function solarCurve(peak: number): number[] {
  return Array.from({ length: N_POINTS }, (_, i) => {
    if (i < 24 || i > 80) return 0;
    const s = Math.sin((Math.PI * (i - 24)) / (80 - 24));
    return round1(clamp(peak * s, 0, 150));
  });
}

/** 滇中风电 ST0201:日间 6–9m/s、午后阵风走高;全程 ≤ 200MW。 */
function windCurve(): number[] {
  return Array.from({ length: N_POINTS }, (_, i) => {
    const diurnal = 70 + 35 * Math.sin((2 * Math.PI * (i - 8)) / N_POINTS);
    const gust = i >= 50 && i <= 78 ? 45 * Math.sin((Math.PI * (i - 50)) / 28) : 0;
    return round1(clamp(diurnal + gust, 8, 200));
  });
}

/** 水电梯级合计:调峰让路风光,跟随关口缺口;≤ 1690MW,≥ 各级最小技术出力之和。 */
function hydroCurve(gzl: number[], wind: number[], solar: number[]): number[] {
  return Array.from({ length: N_POINTS }, (_, i) => {
    // 水电填补「关口送出 - 风光」的缺口,夜里托底、白天让路。
    const need = gzl[i] - wind[i] - solar[i];
    return round1(clamp(need * 0.92 + 180, 201, HYDRO_CAP)); // 201 ≈ 各级最小技术出力和的安全上方
  });
}

export type ScenarioData = {
  scenario: Scenario;
  dsNo: string; // 调度辅助案件号
  dpNo: string; // 调度计划号
  fcNo: string; // 出力预测批次
  wxBatch: string[];
  hyBatch: string[];
  gzlNo: string;
  businessDate: string;
  planType: string;
  stations: Station[];
  limits: typeof LIMITS;

  // 96-point curves (MW)
  curve: { gzl: number[]; gateExport: number[]; hydro: number[]; wind: number[]; solar: number[] };

  // 水文 / 出力关键量
  inflowM3s: number;
  waterLevelM: number; // ST0101 控制水位
  ecoFlowActualM3s: number; // 实际下泄
  sectionPeakMW: number; // 送出断面叠加峰值
  forecastConfidence: number; // P50 合格率
  gzlDeviationPct: number; // 关口送出 vs GZL 总偏差%
  schemeDominant: boolean; // 比选最优方案是否明显占优(无需裁量)
  versionMismatch: boolean; // 封口三问:拟定版版本 ≠ 最终确认采纳版

  // 预期(供测试 / 看板对照,不参与运行判定)
  expect: { redline: boolean; routeToManual: boolean; gate: string | null };

  operators: { dispatcher: string; shiftLead: string; chiefDispatcher: string; hydro: string; renew: string };
};

const OPERATORS = {
  dispatcher: "老张(张力 E020110)",
  shiftLead: "王海涛(E020055)",
  chiefDispatcher: "韩总(总调度师)",
  hydro: "林涛(水调 E020320)",
  renew: "赵敏(新能源预测 E020330)",
};

/** Sum-deviation gate-export curve: scale GZL so total deviation ≈ devPct.
 *  Non-redline scenarios under-send (≤ GZL) so CR-GRID-03 (不得超关口) stays PASS;
 *  the deviation magnitude alone drives triage condition 1. */
function gateExportCurve(gzl: number[], devPct: number): number[] {
  const k = 1 - devPct / 100; // 欠送 devPct% → 不超关口
  return gzl.map((v) => round1(v * k));
}

export function buildScenarioData(scenario: Scenario): ScenarioData {
  const gzl = gzlCurve();
  const wind = windCurve();
  const solar = solarCurve(140);

  // per-scenario knobs
  const knobs: Record<Scenario, { water: number; conf: number; dev: number; dominant: boolean; versionMismatch: boolean; eco: number }> = {
    happy: { water: 1610.5, conf: 0.93, dev: 1.8, dominant: true, versionMismatch: false, eco: 360 },
    "manual-review": { water: 1610.5, conf: 0.86, dev: 2.6, dominant: true, versionMismatch: false, eco: 350 },
    "risk-redline": { water: 1613.2, conf: 0.93, dev: 1.8, dominant: true, versionMismatch: false, eco: 340 },
    "finalize-confirm": { water: 1610.5, conf: 0.91, dev: 2.4, dominant: true, versionMismatch: true, eco: 355 },
  };
  const k = knobs[scenario];

  const gateExport = gateExportCurve(gzl, k.dev);
  const hydro = hydroCurve(gzl, wind, solar);
  const sectionPeakMW = round1(Math.max(...hydro.map((h, i) => h + wind[i] + solar[i])));

  const redline = k.water > LIMITS.floodLimitM || k.eco < LIMITS.ecoFlowMinM3s || sectionPeakMW > LIMITS.sectionLimitMW;
  const routeToManual = !redline && (k.conf < LIMITS.confidenceFloor || k.dev > LIMITS.gzlTolerancePct || !k.dominant);
  const gate =
    scenario === "manual-review" ? "manualConfirm" : scenario === "risk-redline" ? "handleFloodControl" : scenario === "finalize-confirm" ? "finalizePlan" : null;

  return {
    scenario,
    dsNo: "DS2026053000123",
    dpNo: "DP20260530001",
    fcNo: "FC202605300012",
    wxBatch: ["WX20260530008", "WX20260530009"],
    hyBatch: ["HY20260530005", "HY20260530006"],
    gzlNo: "GZL20260530",
    businessDate: "2026-05-30",
    planType: "日前计划 D-1",
    stations: STATIONS,
    limits: LIMITS,
    curve: { gzl, gateExport, hydro, wind, solar },
    inflowM3s: 1200,
    waterLevelM: k.water,
    ecoFlowActualM3s: k.eco,
    sectionPeakMW,
    forecastConfidence: k.conf,
    gzlDeviationPct: k.dev,
    schemeDominant: k.dominant,
    versionMismatch: k.versionMismatch,
    expect: { redline, routeToManual, gate },
    operators: OPERATORS,
  };
}

/** Compact one-line evidence summary for logs / notification body. */
export function evidenceLine(d: ScenarioData): string {
  return (
    `案件${d.dsNo}｜水位${d.waterLevelM}m(汛限${d.limits.floodLimitM})｜` +
    `置信度${d.forecastConfidence}｜关口偏差${d.gzlDeviationPct}%｜` +
    `断面峰值${d.sectionPeakMW}MW(限额${d.limits.sectionLimitMW})｜生态下泄${d.ecoFlowActualM3s}m³/s(≥${d.limits.ecoFlowMinM3s})`
  );
}
