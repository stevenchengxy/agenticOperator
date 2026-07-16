import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the ontology source so we can drive the live-vs-snapshot divergence that
// causes the 费控 bug. normalizeOntologyRule + toEngineRules run for real (pure).
vi.mock("@/lib/ontology-generator/ontology-source", () => ({
  fetchDomainOntology: vi.fn(),
  hasSnapshot: vi.fn(),
  loadSnapshotOntology: vi.fn(),
}));
// loadAllRules = bundled rules.json fallback (when ALLMETA is unconfigured/down).
vi.mock("@/lib/rule-check/ontology", () => ({ loadAllRules: vi.fn(() => []) }));
vi.mock("@/lib/ontology-gen", () => ({
  fetchAction: vi.fn(),
  OntologyGenError: class OntologyGenError extends Error {},
}));

import { GET } from "./route";
import {
  fetchDomainOntology,
  hasSnapshot,
  loadSnapshotOntology,
} from "@/lib/ontology-generator/ontology-source";

type RawRule = Record<string, unknown>;

// Live Allmeta shape: numeric id, business code buried in the NAME, no rich body.
function liveRule(id: string, name: string): RawRule {
  return { id, businessLogicRuleName: name, standardizedLogicRule: "" };
}
// Snapshot shape: business-code id, full definition body.
function snapRule(id: string, name: string, logic: string): RawRule {
  return {
    id,
    businessLogicRuleName: name,
    standardizedLogicRule: logic,
    submissionCriteria: "提交报销单时",
    applicableDepartment: "财务",
  };
}

function ontology(source: "allmeta" | "snapshot", rules: RawRule[]) {
  return { domainId: "费控-v1", objects: [], rules, actions: [], events: [], workflow: [], source };
}

function get(ruleId: string, domain: string) {
  const req = new Request(
    `http://localhost/api/ontology/rules/${encodeURIComponent(ruleId)}?domain=${encodeURIComponent(domain)}`,
  );
  return GET(req, { params: Promise.resolve({ ruleId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/ontology/rules/[ruleId] — 费控 live/snapshot id divergence", () => {
  it("resolves a snapshot business-code id when live Allmeta serves numeric ids", async () => {
    // Live serves the rule under numeric id "6" with the code in the name;
    // the audit flag references the snapshot business code "RULE-INV-01".
    vi.mocked(fetchDomainOntology).mockResolvedValue(
      ontology("allmeta", [liveRule("6", "RULE-INV-01 发票抬头/税号校验")]),
    );
    vi.mocked(hasSnapshot).mockReturnValue(true);
    vi.mocked(loadSnapshotOntology).mockReturnValue(
      ontology("snapshot", [
        snapRule("RULE-INV-01", "发票抬头 / 税号校验", "系统取 OCR 的购买方名称与白名单比对…"),
      ]),
    );

    const res = await get("RULE-INV-01", "费控-v1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.source).toBe("snapshot");
    expect(body.rule.id).toBe("RULE-INV-01");
    expect(body.rule.standardizedLogicRule).toContain("OCR");
  });

  it("prefers live when the live lookup already matches (energy-style), without touching the snapshot", async () => {
    vi.mocked(fetchDomainOntology).mockResolvedValue(
      ontology("allmeta", [liveRule("CR-UNIT-01", "CR-UNIT-01 机组出力上限")]),
    );
    vi.mocked(hasSnapshot).mockReturnValue(true);

    const res = await get("CR-UNIT-01", "能源调度-v1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.source).toBe("ontology-api");
    expect(loadSnapshotOntology).not.toHaveBeenCalled();
  });

  it("404s when neither live nor snapshot has the id", async () => {
    vi.mocked(fetchDomainOntology).mockResolvedValue(
      ontology("allmeta", [liveRule("6", "RULE-INV-01 发票抬头/税号校验")]),
    );
    vi.mocked(hasSnapshot).mockReturnValue(true);
    vi.mocked(loadSnapshotOntology).mockReturnValue(
      ontology("snapshot", [snapRule("RULE-INV-01", "发票抬头", "…")]),
    );

    const res = await get("RULE-DOES-NOT-EXIST", "费控-v1");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_found");
  });
});

describe("GET /api/ontology/rules/[ruleId] — RAAS 招聘域全阶段 (非 matchResume 也能解析)", () => {
  beforeEach(() => {
    // ALLMETA 配置存在 → 走 live ontology(而非直接回退打包 JSON)。
    vi.stubEnv("ALLMETA_BASE_URL", "http://allmeta.test");
    vi.stubEnv("ALLMETA_API_KEY", "k");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves a non-matchResume (推荐包生成 阶段) recruitment rule from the full domain ontology", async () => {
    // 这条规则属于「推荐包生成」阶段,不在 matchResume action 里 —— 旧实现
    // (fetchActionRulesLive,只取 simplied 简历匹配 action) 抓不到、会 404。
    // 新实现走 fetchDomainOntology(整域全阶段,生 :Rule 节点)→ 跟总览同源,能解析。
    vi.mocked(fetchDomainOntology).mockResolvedValue(
      ontology("allmeta", [
        {
          id: "20-07",
          businessLogicRuleName: "推荐包封面信息完整性",
          standardizedLogicRule: "生成推荐包时校验封面必填字段是否齐全…",
          specificScenarioStage: "推荐包生成",
        },
      ]),
    );

    const res = await get("20-07", "RAAS-v1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.source).toBe("ontology-api");
    expect(body.rule.id).toBe("20-07");
    expect(body.rule.standardizedLogicRule).toContain("推荐包");
    // 用整域 ontology 解析,绝不碰 matchResume action 快照。
    expect(fetchDomainOntology).toHaveBeenCalledWith("RAAS-v1");
  });

  it("falls back to bundled rules.json when the live ontology lacks the id", async () => {
    const { loadAllRules } = await import("@/lib/rule-check/ontology");
    vi.mocked(loadAllRules).mockReturnValueOnce([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "10-42", businessLogicRuleName: "CDG永不回流", standardizedLogicRule: "CDG绝不回流。" } as any,
    ]);
    vi.mocked(fetchDomainOntology).mockResolvedValue(ontology("allmeta", []));

    const res = await get("10-42", "RAAS-v1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.source).toBe("json-fallback");
    expect(body.rule.id).toBe("10-42");
  });
});
