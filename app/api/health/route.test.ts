import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ queryRawUnsafe: vi.fn() }));

vi.mock("@/server/db", () => ({
  prisma: { $queryRawUnsafe: db.queryRawUnsafe },
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => db.queryRawUnsafe.mockReset());

  it("serves liveness without querying Postgres", async () => {
    const res = await GET(new Request("http://ao/api/health?check=live"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
    expect(db.queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("serves readiness when Postgres answers", async () => {
    db.queryRawUnsafe.mockResolvedValue([{
      RuleCheckAudit: '"RuleCheckAudit"',
      RuleCheckFlag: '"RuleCheckFlag"',
      OntologyRuleCheck: '"OntologyRuleCheck"',
      OntologyRuleCheckEval: '"OntologyRuleCheckEval"',
    }]);
    const res = await GET(new Request("http://ao/api/health?check=ready"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      dependencies: { postgres: "ok", ruleAuditSchema: "ok" },
    });
  });

  it("returns 503 when Postgres is reachable but a rule-audit table is missing", async () => {
    db.queryRawUnsafe.mockResolvedValue([{
      RuleCheckAudit: '"RuleCheckAudit"',
      RuleCheckFlag: '"RuleCheckFlag"',
      OntologyRuleCheck: null,
      OntologyRuleCheckEval: null,
    }]);

    const res = await GET(new Request("http://ao/api/health?check=ready"));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      dependencies: { postgres: "ok", ruleAuditSchema: "unavailable" },
    });
  });

  it("returns a redacted 503 when the database probe has no result", async () => {
    db.queryRawUnsafe.mockResolvedValue(null);
    const res = await GET(new Request("http://ao/api/health"));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("secret connection string");
  });
});
