import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  recruitmentCount: vi.fn(),
  recruitmentFindMany: vi.fn(),
  hasOntology: vi.fn(),
  ontologyCount: vi.fn(),
  ontologyRows: vi.fn(),
  ontologyFacets: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    ruleCheckAudit: {
      count: m.recruitmentCount,
      findMany: m.recruitmentFindMany,
    },
  },
}));

vi.mock("@/lib/rule-check/ontology-audit-source", () => ({
  hasOntologyRuleChecks: m.hasOntology,
  ontologyAuditCount: m.ontologyCount,
  ontologyAuditRows: m.ontologyRows,
  ontologyAuditFacets: m.ontologyFacets,
}));

import { GET, type RuleCheckAuditRow } from "./route";

function ontologyRow(id: string, createdAt: string): RuleCheckAuditRow {
  return {
    audit_id: id,
    created_at: createdAt,
    decision: "PASS",
    agent_id: "identity",
    agent_label: "Identity",
    stage: "身份校验",
    verdict: "pass",
    llm_decision: "AUTO",
    candidate_id: "c",
    resume_id: "r",
    job_requisition_id: "j",
    client_name: "身份校验",
    business_group: null,
    studio: null,
    candidate_name: null,
    jr_title: null,
    dept_label: null,
    llm_model: "deterministic",
    llm_duration_ms: 0,
    llm_prompt_tokens: null,
    llm_completion_tokens: null,
    rules_evaluated: 1,
    rule_source: "ontology-api",
    n_flags: 1,
    trace_id: null,
    failure_reasons: [],
  };
}

function recruitmentRow(id: string, createdAt: string) {
  return {
    audit_id: id,
    created_at: new Date(createdAt),
    decision: "PASS",
    fail_reason: null,
    llm_decision: "PASS",
    candidate_id: "c",
    resume_id: "r",
    job_requisition_id: "j",
    client_name: "client",
    business_group: null,
    studio: null,
    parsed_resume_json: null,
    job_requisition_json: null,
    llm_model: "model",
    llm_duration_ms: 1,
    llm_prompt_tokens: null,
    llm_completion_tokens: null,
    rules_evaluated: 1,
    rule_source: "ontology-api",
    trace_id: null,
    failure_reasons: "[]",
    _count: { flags: 1 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.hasOntology.mockResolvedValue(true);
  m.ontologyFacets.mockResolvedValue({ agents: [], stages: [] });
});

describe("GET /api/rule-check-audits", () => {
  it("returns an exact stable page across both persistent recruitment stores", async () => {
    m.recruitmentCount.mockResolvedValue(3);
    m.ontologyCount.mockResolvedValue(2);
    m.recruitmentFindMany.mockResolvedValue([
      recruitmentRow("a5", "2026-07-10T05:00:00.000Z"),
      recruitmentRow("a3", "2026-07-10T03:00:00.000Z"),
      recruitmentRow("a1", "2026-07-10T01:00:00.000Z"),
    ]);
    m.ontologyRows.mockResolvedValue([
      ontologyRow("o4", "2026-07-10T04:00:00.000Z"),
      ontologyRow("o2", "2026-07-10T02:00:00.000Z"),
    ]);

    const response = await GET(new Request("http://test/api/rule-check-audits?domain=RAAS-v1&page=2&pageSize=2"));
    const body = await response.json();

    expect(body).toMatchObject({ total: 5, page: 2, pageSize: 2, totalPages: 3 });
    expect(body.rows.map((row: RuleCheckAuditRow) => row.audit_id)).toEqual(["a3", "o2"]);
    expect(m.recruitmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 4,
      orderBy: [{ created_at: "desc" }, { audit_id: "desc" }],
    }));
    expect(m.ontologyRows).toHaveBeenCalledWith("RAAS-v1", expect.objectContaining({ take: 4 }));
  });

  it("pushes filters and numbered pagination into the ontology store", async () => {
    m.ontologyCount.mockResolvedValue(7);
    m.ontologyRows.mockResolvedValue([ontologyRow("o3", "2026-07-10T03:00:00.000Z")]);

    const response = await GET(new Request(
      "http://test/api/rule-check-audits?domain=energy-v1&page=2&pageSize=3&agent=validator&ruleId=R1&verdict=fail",
    ));
    const body = await response.json();

    expect(body).toMatchObject({ total: 7, page: 2, pageSize: 3, totalPages: 3 });
    expect(m.ontologyRows).toHaveBeenCalledWith("energy-v1", {
      skip: 3,
      take: 3,
      filters: expect.objectContaining({ agent: "validator", ruleId: "R1", verdict: "fail" }),
    });
  });

  it("does not materialize a prefix when the requested page is past total", async () => {
    m.recruitmentCount.mockResolvedValue(1);
    m.ontologyCount.mockResolvedValue(0);

    const response = await GET(new Request("http://test/api/rule-check-audits?domain=RAAS-v1&page=9&pageSize=20"));
    const body = await response.json();

    expect(body.rows).toEqual([]);
    expect(body.total).toBe(1);
    expect(m.recruitmentFindMany).not.toHaveBeenCalled();
    expect(m.ontologyRows).not.toHaveBeenCalled();
  });

  it("returns 500 instead of silently hiding one recruitment audit store", async () => {
    m.recruitmentCount.mockResolvedValue(3);
    m.ontologyCount.mockRejectedValue(new Error("ontology audit table unavailable"));

    const response = await GET(new Request(
      "http://test/api/rule-check-audits?domain=RAAS-v1&page=1&pageSize=20",
    ));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.rows).toEqual([]);
    expect(body.meta.error).toContain("ontology audit table unavailable");
  });

  it("returns 500 instead of treating a non-recruitment query failure as empty history", async () => {
    m.hasOntology.mockRejectedValue(new Error("postgres unavailable"));

    const response = await GET(new Request(
      "http://test/api/rule-check-audits?domain=energy-v1&page=1&pageSize=20",
    ));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.meta.error).toContain("postgres unavailable");
  });
});
