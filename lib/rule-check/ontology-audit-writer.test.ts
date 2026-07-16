import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.hoisted(() => vi.fn());
vi.mock("@/server/db", () => ({
  prisma: { ontologyRuleCheck: { upsert } },
}));

import {
  ontologyRuleCheckAuditId,
  persistOntologyRuleCheckAudit,
  type PersistentOntologyRuleCheck,
} from "./ontology-audit-writer";

const input: PersistentOntologyRuleCheck = {
  domain: "能源调度-v1",
  agentSlug: "energy-validate",
  agentName: "ValidateAgent",
  stage: "约束校验",
  caseId: "case-1",
  runId: "run-1",
  decision: "VALIDATED",
  redlineFlag: false,
  rulesTotal: 2,
  rulesSelected: 2,
  rulesExpected: 2,
  selectionOk: true,
  selectionNote: "{}",
  rulesEvaluated: 2,
  ruleSource: "ontology-api",
  evals: [
    { ruleId: "R1", ruleName: "规则1", ruleGroup: "安全", hardSoft: "hard", result: "PASS" },
    { ruleId: "R2", ruleName: "规则2", ruleGroup: "安全", hardSoft: "soft", result: "FAIL", evidence: "超限" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({});
});

describe("persistOntologyRuleCheckAudit", () => {
  it("upserts one deterministic audit and atomically refreshes all eval rows", async () => {
    const id = await persistOntologyRuleCheckAudit(input);
    expect(id).toBe(ontologyRuleCheckAuditId(input));
    expect(upsert).toHaveBeenCalledWith({
      where: { id },
      create: expect.objectContaining({ id, domain: input.domain, evals: { create: expect.any(Array) } }),
      update: expect.objectContaining({
        domain: input.domain,
        evals: { deleteMany: {}, create: expect.arrayContaining([expect.objectContaining({ ruleId: "R2", evidence: "超限" })]) },
      }),
    });
  });

  it("propagates database failures so the Inngest step retries", async () => {
    upsert.mockRejectedValueOnce(new Error("postgres unavailable"));
    await expect(persistOntologyRuleCheckAudit(input)).rejects.toThrow("postgres unavailable");
  });

  it("keeps technical retries idempotent but preserves a later execution", () => {
    const first = { ...input, runId: "run-1" };
    expect(ontologyRuleCheckAuditId(first)).toBe(ontologyRuleCheckAuditId(first));
    expect(ontologyRuleCheckAuditId({ ...first, runId: "run-2" })).not.toBe(
      ontologyRuleCheckAuditId(first),
    );
  });
});
