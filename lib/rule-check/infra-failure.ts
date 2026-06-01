// Distinguishes a rule-check `decision: 'FAIL'` that is an *infrastructure*
// failure (evaluation could not complete) from a *real* rule violation.
//
// failSafe() in runner.ts sets audit.fail_reason to one of these whenever the
// evaluation itself broke (LLM gateway down/401, graph unavailable, tool loop
// exhausted, unparseable LLM output). Those are NOT candidate rejections — the
// agent must retry/park + alert, never write 未通过 to the partner main table
// or emit MATCH_RULE_CHECK_FAILED. A real violation comes through the normal
// path with audit.fail_reason left undefined.

export const INFRA_FAIL_REASONS = [
  'llm-call-error',
  'gateway-unavailable',
  'ontology-graph-unavailable',
  'tool-use-loop-exceeded',
  'parse-error',
] as const;

export function isInfraFailure(reason: string | undefined | null): boolean {
  if (!reason) return false;
  return (INFRA_FAIL_REASONS as readonly string[]).includes(reason);
}
