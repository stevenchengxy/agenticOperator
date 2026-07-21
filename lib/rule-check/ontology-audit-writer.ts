import { createHash } from "node:crypto";
import { prisma } from "@/server/db";

export const RULE_AUDIT_PERSISTENCE_CODE = "RULE_AUDIT_PERSISTENCE_FAILED";

export class RuleAuditPersistenceError extends Error {
  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`[${RULE_AUDIT_PERSISTENCE_CODE}] ${message}`, { cause });
    this.name = "RuleAuditPersistenceError";
  }
}

export function asRuleAuditPersistenceError(cause: unknown): RuleAuditPersistenceError {
  return cause instanceof RuleAuditPersistenceError ? cause : new RuleAuditPersistenceError(cause);
}

export function isRuleAuditPersistenceFailure(cause: unknown): boolean {
  return cause instanceof RuleAuditPersistenceError ||
    (cause instanceof Error && cause.message.includes(RULE_AUDIT_PERSISTENCE_CODE));
}

export type PersistentOntologyRuleEval = {
  ruleId: string;
  ruleName: string;
  ruleGroup: string;
  hardSoft: string;
  result: string;
  checkPoint?: string | null;
  beforeVal?: string | null;
  afterVal?: string | null;
  defaultAction?: string | null;
  riskType?: string | null;
  riskLevel?: string | null;
  evidence?: string | null;
};

export type PersistentOntologyRuleCheck = {
  domain: string;
  agentSlug: string;
  agentName: string;
  stage: string;
  caseId: string;
  /** Stable Inngest function execution id. Technical retries reuse it; a
   * business re-run must provide a new one so history remains append-only. */
  runId: string;
  traceId?: string | null;
  dsNo?: string | null;
  decision: string;
  redlineFlag: boolean;
  rulesTotal: number;
  rulesSelected: number;
  rulesExpected: number;
  selectionOk: boolean;
  selectionNote?: string | null;
  rulesEvaluated: number;
  ruleSource: string;
  evals: PersistentOntologyRuleEval[];
};

/** Stable across a retried step, distinct across domain/agent/case/stage. */
export function ontologyRuleCheckAuditId(
  input: Pick<PersistentOntologyRuleCheck, "domain" | "agentSlug" | "caseId" | "runId" | "stage">,
): string {
  const executionId = input.runId.trim();
  if (!executionId) throw new Error("rule audit runId is required");
  const digest = createHash("sha256")
    .update([input.domain, input.agentSlug, executionId, input.caseId, input.stage].join("\u0000"))
    .digest("hex")
    .slice(0, 40);
  return `orc_${digest}`;
}

/**
 * Durable, idempotent writer for deterministic rule-check audits.
 *
 * Do not catch database failures here: callers run this inside an Inngest step,
 * so throwing is what retries the write and prevents downstream events from
 * advancing without their authoritative audit record.
 */
export async function persistOntologyRuleCheckAudit(
  input: PersistentOntologyRuleCheck,
): Promise<string> {
  const id = ontologyRuleCheckAuditId(input);
  const evals = input.evals.map((e) => ({
    ruleId: e.ruleId,
    ruleName: e.ruleName,
    ruleGroup: e.ruleGroup,
    hardSoft: e.hardSoft,
    result: e.result,
    checkPoint: e.checkPoint ?? null,
    beforeVal: e.beforeVal ?? null,
    afterVal: e.afterVal ?? null,
    defaultAction: e.defaultAction ?? null,
    riskType: e.riskType ?? null,
    riskLevel: e.riskLevel ?? null,
    evidence: e.evidence ?? null,
  }));
  const data = {
    domain: input.domain,
    agentSlug: input.agentSlug,
    agentName: input.agentName,
    stage: input.stage,
    caseId: input.caseId,
    runId: input.runId,
    traceId: input.traceId ?? null,
    dsNo: input.dsNo ?? null,
    decision: input.decision,
    redlineFlag: input.redlineFlag,
    rulesTotal: input.rulesTotal,
    rulesSelected: input.rulesSelected,
    rulesExpected: input.rulesExpected,
    selectionOk: input.selectionOk,
    selectionNote: input.selectionNote ?? null,
    rulesEvaluated: input.rulesEvaluated,
    ruleSource: input.ruleSource,
  };

  try {
    await prisma.ontologyRuleCheck.upsert({
      where: { id },
      create: { id, ...data, evals: { create: evals } },
      update: { ...data, evals: { deleteMany: {}, create: evals } },
    });
  } catch (error) {
    throw asRuleAuditPersistenceError(error);
  }
  return id;
}
