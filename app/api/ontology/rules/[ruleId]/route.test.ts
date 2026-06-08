import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the ontology source so we can drive the live-vs-snapshot divergence that
// causes the 费控 bug. normalizeOntologyRule + toEngineRules run for real (pure).
vi.mock("@/lib/ontology-generator/ontology-source", () => ({
  fetchDomainOntology: vi.fn(),
  hasSnapshot: vi.fn(),
  loadSnapshotOntology: vi.fn(),
}));
// The recruitment branch isn't exercised here; keep its deps cheap + side-effect free.
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
