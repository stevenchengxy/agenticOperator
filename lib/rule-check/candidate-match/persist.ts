// Persist a candidate identity / ownership rule-check into the generic
// OntologyRuleCheck store under the recruitment domain. agentSlug =
// 'rule-check-candidate-identity' | 'rule-check-candidate-ownership' is what the
// /rule-check facet page filters on (the route
// merges ontologyAuditList(RECRUITMENT_DOMAIN_ID) for recruitment). Mirrors the energy
// persistRuleCheck writer (server/inngest/domains/energy/rule-check/run-rule-check.ts).

import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import { persistOntologyRuleCheckAudit } from '@/lib/rule-check/ontology-audit-writer';
import type { CandidateOntologyCheck } from './to-ontology-check';

export interface PersistCandidateCheckArgs {
  agentSlug: string;
  agentName: string;
  stage: string;
  caseId: string;
  runId: string;
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
  const id = await persistOntologyRuleCheckAudit({
    domain: RECRUITMENT_DOMAIN_ID,
    agentSlug: a.agentSlug,
    agentName: a.agentName,
    stage: a.stage,
    caseId: a.caseId,
    runId: a.runId,
    traceId: a.traceId ?? null,
    dsNo: a.dsNo ?? null,
    decision: check.decision,
    redlineFlag: check.redlineFlag,
    rulesTotal: check.rulesTotal,
    rulesSelected: check.rulesSelected,
    rulesExpected: check.rulesExpected,
    selectionOk: check.selectionOk,
    selectionNote: a.selectionNote != null ? JSON.stringify(a.selectionNote) : null,
    rulesEvaluated: check.rulesEvaluated,
    ruleSource: a.ruleSource,
    evals: check.evals.map((e) => ({
      ruleId: e.ruleId,
      ruleName: e.ruleName,
      ruleGroup: e.ruleGroup,
      hardSoft: e.hardSoft,
      result: e.result,
      checkPoint: e.checkPoint ?? null,
      evidence: e.evidence ?? null,
    })),
  });
  return { id };
}
