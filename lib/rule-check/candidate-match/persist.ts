// Persist a candidate identity / ownership rule-check into the generic
// OntologyRuleCheck store under the recruitment domain. agentSlug =
// 'rule-check-candidate-identity' | 'rule-check-candidate-ownership' is what the
// /rule-check facet page filters on (the route
// merges ontologyAuditList(RECRUITMENT_DOMAIN_ID) for recruitment). Mirrors the energy
// persistRuleCheck writer (server/inngest/domains/energy/rule-check/run-rule-check.ts).

import { prisma } from '@/server/db';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import type { CandidateOntologyCheck } from './to-ontology-check';

export interface PersistCandidateCheckArgs {
  agentSlug: string;
  agentName: string;
  stage: string;
  caseId: string;
  runId?: string | null;
  traceId?: string | null;
  dsNo?: string | null;
  ruleSource: string;
  selectionNote?: unknown;
  check: CandidateOntologyCheck;
}

export async function persistCandidateRuleCheck(
  a: PersistCandidateCheckArgs,
): Promise<{ id: string }> {
  const { check } = a;
  // Deterministic id (caseId + agentSlug) → idempotent upsert. A step retry / replay
  // re-runs with the same caseId and updates the row in place instead of writing a
  // duplicate audit. Mirrors rule-check-agent's stable parked-audit id pattern.
  const id = `cm_${a.agentSlug}_${a.caseId}`;
  const evalsCreate = check.evals.map((e) => ({
    ruleId: e.ruleId,
    ruleName: e.ruleName,
    ruleGroup: e.ruleGroup,
    hardSoft: e.hardSoft,
    result: e.result,
    checkPoint: e.checkPoint ?? null,
    evidence: e.evidence ?? null,
  }));
  const selectionNote = a.selectionNote != null ? JSON.stringify(a.selectionNote) : null;
  const verdict = {
    decision: check.decision,
    redlineFlag: check.redlineFlag,
    rulesTotal: check.rulesTotal,
    rulesSelected: check.rulesSelected,
    rulesExpected: check.rulesExpected,
    selectionOk: check.selectionOk,
    selectionNote,
    rulesEvaluated: check.rulesEvaluated,
    ruleSource: a.ruleSource,
  };
  const row = await prisma.ontologyRuleCheck.upsert({
    where: { id },
    create: {
      id,
      domain: RECRUITMENT_DOMAIN_ID,
      agentSlug: a.agentSlug,
      agentName: a.agentName,
      stage: a.stage,
      caseId: a.caseId,
      runId: a.runId ?? a.caseId,
      traceId: a.traceId ?? null,
      dsNo: a.dsNo ?? null,
      ...verdict,
      evals: { create: evalsCreate },
    },
    update: {
      ...verdict,
      // refresh evals on replay so the row reflects the latest evaluation
      evals: { deleteMany: {}, create: evalsCreate },
    },
  });
  return { id: row.id };
}
