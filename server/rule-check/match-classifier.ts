import type { MatchResumeCheckResult, RuleStatus } from '@/lib/rule-check/types';

export type MatchKind =
  | 'pass'
  | 'fail-decision'
  | 'fail-rule'
  | 'fail-missing-rule'
  | 'fail-parse'
  | 'fail-runtime';

export type ExpectedOutcome = {
  decision: 'PASS' | 'FAIL' | 'REVIEW';
  rule_status: Partial<Record<string, RuleStatus>>;
};

export type ClassifyResult = { kind: MatchKind; failures: string[] };

export function classifyMatch(
  expected: ExpectedOutcome,
  actual: MatchResumeCheckResult,
): ClassifyResult {
  const failures: string[] = [];

  const failReason = actual.audit.fail_reason;
  if (failReason === 'parse-error') {
    failures.push('parse-error from LLM (raw output may be truncated)');
    return { kind: 'fail-parse', failures };
  }
  if (failReason === 'ontology-graph-unavailable' || failReason === 'llm-call-error' || failReason === 'tool-use-loop-exceeded') {
    failures.push(`runtime error: ${failReason}`);
    return { kind: 'fail-runtime', failures };
  }

  if (actual.decision !== expected.decision) {
    failures.push(`decision mismatch — expected ${expected.decision}, got ${actual.decision}`);
  }

  const ruleMap = new Map(actual.rule_results.map((r) => [r.rule_id, r]));
  let missingPinned = false;
  let differingPinned = false;
  for (const [ruleId, expectedStatus] of Object.entries(expected.rule_status)) {
    const got = ruleMap.get(ruleId);
    if (!got) {
      failures.push(`rule ${ruleId} missing from rule_results — expected status='${expectedStatus}'`);
      missingPinned = true;
      continue;
    }
    if (got.status !== expectedStatus) {
      failures.push(`rule ${ruleId}: expected '${expectedStatus}', got '${got.status}' (reason: ${got.reason ?? ''})`);
      differingPinned = true;
    }
  }

  if (failures.length === 0) return { kind: 'pass', failures: [] };
  if (missingPinned) return { kind: 'fail-missing-rule', failures };
  if (differingPinned) return { kind: 'fail-rule', failures };
  return { kind: 'fail-decision', failures };
}
