// Deterministic cost-control (费控) instance data for the runnable demo.
//
// One self-consistent expense-claim dataset per scenario, drawn from the use-case
// corpus (00-费用管控测试用例集) + the standards matrix (02-费用政策与报销标准手册)
// + the risk classification (03-费控规则与异常风险识别手册). Threaded verbatim
// through every event so the rule-check agent judges real numbers and the human
// gates show real evidence. Pure functions of the scenario string — NO randomness,
// so a re-run reproduces the same numbers (and tests can assert exact values).

export type FeikongScenario = "happy" | "deduction" | "risk-split" | "risk-private";

export const FEIKONG_SCENARIOS: FeikongScenario[] = ["happy", "deduction", "risk-split", "risk-private"];

// ── thresholds (CFO-locked 硬阈值;固化在此当判据,TRACE-02 管控)──────────────
export const FEIKONG_LIMITS = {
  autoTotalMax: 20000, // PIPE-01 ① 合计可报 ≤ 20,000 直通
  autoInvoiceMax: 5000, // PIPE-01 ② 单张发票价税合计 ≤ 5,000 直通
  ocrFloor: 0.95, // PIPE-01 ③④ OCR 关键字段置信度 ≥ 0.95 + 验真
  invoiceTolerance: 0.01, // INV-08 明细 vs 票面金额容差
  splitWindowDays: 7, // CMP-01 大额拆分 7 天滑动窗
  localTransportDailyMax: 200, // STD-06 市内交通单日上限
} as const;

// 住宿每间每晚上限矩阵(职级 × 城市级)— 02 政策手册 §3.2。index by cityTier 1/2/3。
const LODGING_STD: Record<string, number[]> = {
  员工: [0, 500, 400, 300],
  主管: [0, 500, 400, 300],
  经理: [0, 600, 500, 350],
  总监: [0, 800, 600, 450],
  VP: [0, 99999, 99999, 99999], // 据实(需书面)
  C级: [0, 99999, 99999, 99999],
};

export function lodgingStandard(level: string, cityTier: number): number {
  const row = LODGING_STD[level] ?? LODGING_STD["员工"];
  return row[cityTier] ?? row[2];
}

export type InvoiceLine = {
  lineNo: number;
  categoryId: string; // F1020
  categoryName: string; // 住宿服务
  invoiceId: string;
  invoiceType: string; // 专票 / 机票行程单 / 高铁 / 定额票 …
  invoiceNumber: string;
  vendor: string;
  vendorTaxId?: string;
  buyerName: string; // 抬头(INV-01 白名单校验)
  buyerTaxId: string;
  amount: number; // 明细行金额(= 票面价税合计)
  invoiceAmount: number; // 票面价税合计(INV-08 一致性比对)
  issueDate: string;
  expenseDate: string;
  ocrConfidence: number; // 四关键字段最低置信度
  verification: "已验真" | "存疑" | "未查";
  nights?: number; // 住宿 STD-01
  perNight?: number; // 住宿每间每晚单价
  goods?: string; // 商品名(CMP-06 私人消费识别)
  privateAmount?: number; // 混入的私人物品金额(CMP-06)
};

export type FeikongSibling = { claimId: string; amount: number; date: string; vendor: string };

export type FeikongScenarioData = {
  scenario: FeikongScenario;
  dsNo: string; // 费控案件号 FK…(工厂用作案件标签)
  claimId: string; // 报销单号 ECA/OEP…
  claimType: "ECA" | "OEP";
  claimantName: string;
  claimantId: string;
  claimantLevel: string; // 员工/主管/经理/总监/VP/C级
  costCenterId: string;
  cityTier: number; // 1/2/3 城市级
  businessTripNo?: string;
  lines: InvoiceLine[];
  totalAmount: number; // Σ line.amount
  budgetAvailable: number; // 占用前可用余额
  siblings?: FeikongSibling[]; // CMP-01 拆分聚合证据
  limits: typeof FEIKONG_LIMITS;
  expect: { autoApprove: boolean; deduction: number; risk: string | null; gate: string | null };
  operators: { reviewer: string; manager: string; auditor: string };
};

const OPERATORS = {
  reviewer: "老陈(费控审核员 E200110)",
  manager: "王建国(直接主管 E100012)",
  auditor: "孙强(内审稽核 E200055)",
};

function sum(lines: InvoiceLine[]): number {
  return Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
}

// ── HAPPY — TC-E2E-001 金标准直通 ─────────────────────────────────────────────
function happyData(): FeikongScenarioData {
  const lines: InvoiceLine[] = [
    { lineNo: 1, categoryId: "F1020", categoryName: "住宿服务", invoiceId: "PIAO100000000087", invoiceType: "专票", invoiceNumber: "08827451", vendor: "上海锦江之星", vendorTaxId: "91310000MA1FL00X", buyerName: "启明数字科技集团股份有限公司", buyerTaxId: "91110000MA0000001", amount: 1696.0, invoiceAmount: 1696.0, issueDate: "2026-05-27", expenseDate: "2026-05-27", ocrConfidence: 0.985, verification: "已验真", nights: 4, perNight: 424 },
    { lineNo: 2, categoryId: "F1010", categoryName: "城市间交通·机票", invoiceType: "机票行程单", invoiceId: "PIAO100000000088", invoiceNumber: "8801558299", vendor: "北京同程商旅", buyerName: "启明数字科技集团股份有限公司", buyerTaxId: "91110000MA0000001", amount: 1240.0, invoiceAmount: 1240.0, issueDate: "2026-05-26", expenseDate: "2026-05-26", ocrConfidence: 0.972, verification: "已验真" },
    { lineNo: 3, categoryId: "F1010", categoryName: "城市间交通·高铁", invoiceType: "铁路电子客票", invoiceId: "PIAO100000000089", invoiceNumber: "24G125883041", vendor: "中国铁路", buyerName: "启明数字科技集团股份有限公司", buyerTaxId: "91110000MA0000001", amount: 553.0, invoiceAmount: 553.0, issueDate: "2026-05-28", expenseDate: "2026-05-28", ocrConfidence: 0.991, verification: "已验真" },
  ];
  return {
    scenario: "happy",
    dsNo: "FK2026052900123",
    claimId: "ECA20260529000128",
    claimType: "ECA",
    claimantName: "张伟",
    claimantId: "E100245",
    claimantLevel: "主管",
    costCenterId: "CC100210",
    cityTier: 1, // 上海一类
    businessTripNo: "BTA2026052500066",
    lines,
    totalAmount: sum(lines), // 3489.00
    budgetAvailable: 94200,
    limits: FEIKONG_LIMITS,
    expect: { autoApprove: true, deduction: 0, risk: null, gate: null },
    operators: OPERATORS,
  };
}

// ── DEDUCTION — STD-01 住宿超标 → 核减 → 人工确认核减额 ───────────────────────
function deductionData(): FeikongScenarioData {
  const lines: InvoiceLine[] = [
    // 成都(二类)主管上限 400/晚,实际 480/晚 × 2 晚 → 超 160
    { lineNo: 1, categoryId: "F1020", categoryName: "住宿服务", invoiceId: "PIAO100000000211", invoiceType: "专票", invoiceNumber: "MA62K0099", vendor: "成都天府国际酒店", vendorTaxId: "91510100MA62K", buyerName: "启明数字科技集团股份有限公司", buyerTaxId: "91110000MA0000001", amount: 960.0, invoiceAmount: 960.0, issueDate: "2026-05-30", expenseDate: "2026-05-30", ocrConfidence: 0.981, verification: "已验真", nights: 2, perNight: 480 },
    { lineNo: 2, categoryId: "F1010", categoryName: "城市间交通·高铁", invoiceType: "铁路电子客票", invoiceId: "PIAO100000000212", invoiceNumber: "24G135990012", vendor: "中国铁路", buyerName: "启明数字科技集团股份有限公司", buyerTaxId: "91110000MA0000001", amount: 553.0, invoiceAmount: 553.0, issueDate: "2026-05-28", expenseDate: "2026-05-28", ocrConfidence: 0.991, verification: "已验真" },
  ];
  return {
    scenario: "deduction",
    dsNo: "FK2026053000131",
    claimId: "ECA20260530000142",
    claimType: "ECA",
    claimantName: "张伟",
    claimantId: "E100245",
    claimantLevel: "主管",
    costCenterId: "CC100210",
    cityTier: 2, // 成都二类
    businessTripNo: "BTA2026052800079",
    lines,
    totalAmount: sum(lines), // 1513.00
    budgetAvailable: 88000,
    limits: FEIKONG_LIMITS,
    expect: { autoApprove: false, deduction: 160, risk: null, gate: "manualReview" },
    operators: OPERATORS,
  };
}

// ── RISK-SPLIT — CMP-01 大额拆分 → T4 / L3 → SUSPENDED ───────────────────────
function riskSplitData(): FeikongScenarioData {
  const lines: InvoiceLine[] = [
    { lineNo: 1, categoryId: "F3010", categoryName: "办公费", invoiceId: "PIAO100000000327", invoiceType: "专票", invoiceNumber: "DL0000327", vendor: "得力办公", vendorTaxId: "V100733", buyerName: "启明数字科技集团股份有限公司", buyerTaxId: "91110000MA0000001", amount: 18500.0, invoiceAmount: 18500.0, issueDate: "2026-05-30", expenseDate: "2026-05-30", ocrConfidence: 0.972, verification: "已验真" },
  ];
  return {
    scenario: "risk-split",
    dsNo: "FK2026053000305",
    claimId: "OEP20260530000327",
    claimType: "OEP",
    claimantName: "张伟",
    claimantId: "E100245",
    claimantLevel: "主管",
    costCenterId: "CC100210",
    cityTier: 2,
    lines,
    totalAmount: sum(lines), // 18500.00
    budgetAvailable: 120000,
    // 同报销人 + 同供应商 V100733, 7 天内三单各 ~18,500 → 聚合 55,500 越档
    siblings: [
      { claimId: "OEP20260525000301", amount: 18500, date: "2026-05-25", vendor: "得力办公" },
      { claimId: "OEP20260527000314", amount: 18500, date: "2026-05-27", vendor: "得力办公" },
      { claimId: "OEP20260530000327", amount: 18500, date: "2026-05-30", vendor: "得力办公" },
    ],
    limits: FEIKONG_LIMITS,
    expect: { autoApprove: false, deduction: 0, risk: "T4/L3", gate: "disposeRiskEvent" },
    operators: OPERATORS,
  };
}

// ── RISK-PRIVATE — CMP-06 疑似私人消费 → T7 / L4 → SUSPENDED + 移送稽核 ────────
function riskPrivateData(): FeikongScenarioData {
  const lines: InvoiceLine[] = [
    { lineNo: 1, categoryId: "F3010", categoryName: "办公费", invoiceId: "PIAO100000000412", invoiceType: "专票", invoiceNumber: "JD0000412", vendor: "得力办公(京东)", vendorTaxId: "V100733", buyerName: "启明数字科技集团股份有限公司", buyerTaxId: "91110000MA0000001", amount: 4860.0, invoiceAmount: 4860.0, issueDate: "2026-05-31", expenseDate: "2026-05-31", ocrConfidence: 0.969, verification: "已验真", goods: "键盘×2/鼠标×3/A4纸×10 + 游戏手柄 + 儿童奶粉 + 智能手表", privateAmount: 2518.0 },
  ];
  return {
    scenario: "risk-private",
    dsNo: "FK2026053100398",
    claimId: "OEP20260531000412",
    claimType: "OEP",
    claimantName: "李娜",
    claimantId: "E100662",
    claimantLevel: "员工",
    costCenterId: "CC300110",
    cityTier: 2,
    lines,
    totalAmount: sum(lines), // 4860.00
    budgetAvailable: 60000,
    limits: FEIKONG_LIMITS,
    expect: { autoApprove: false, deduction: 0, risk: "T7/L4", gate: "disposeRiskEvent" },
    operators: OPERATORS,
  };
}

export function buildFeikongScenario(scenario: FeikongScenario): FeikongScenarioData {
  switch (scenario) {
    case "deduction":
      return deductionData();
    case "risk-split":
      return riskSplitData();
    case "risk-private":
      return riskPrivateData();
    case "happy":
    default:
      return happyData();
  }
}

/** Compact one-line evidence summary for logs / notification body. */
export function evidenceLine(d: FeikongScenarioData): string {
  return (
    `案件${d.dsNo}｜报销单${d.claimId}｜${d.claimantName}(${d.claimantLevel})｜` +
    `合计${d.totalAmount}元(${d.lines.length}张票,各≤${d.limits.autoInvoiceMax})｜` +
    `成本中心${d.costCenterId}｜预算可用${d.budgetAvailable}`
  );
}

/** Compact dataset summary for the LLM prompt. */
export function feikongDatasetBrief(d: FeikongScenarioData | null): string {
  if (!d) return "";
  return (
    `报销单 ${d.claimId}｜${d.claimType}｜${d.claimantName}(${d.claimantLevel})｜CC ${d.costCenterId}｜` +
    `合计 ${d.totalAmount}元｜${d.lines.length}张发票｜城市${d.cityTier}类｜预算可用 ${d.budgetAvailable}`
  );
}
