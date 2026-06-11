// Pure facet helpers for the /rule-check audit list. The page is a unified
// surface across multiple rule-check agents/stages; these functions fold a raw
// audit decision into a display verdict and filter normalized rows by the
// agent / stage / verdict facets the UI exposes.

import { isInfraFailure } from './infra-failure';

/** Display verdict: a real pass/fail, or an infra "parked" run (FAIL on paper
 *  but the candidate was NOT rejected — evaluation just couldn't complete). */
export type Verdict = 'pass' | 'fail' | 'parked';

/** Fold an audit's raw decision + fail_reason into one display verdict.
 *  An infra fail_reason (没钱/故障/解析失败…) → 'parked'; everything else maps
 *  PASS→pass, FAIL→fail. Mirrors the badge logic the card already uses. */
export function foldVerdict(decision: string, failReason?: string | null): Verdict {
  if (isInfraFailure(failReason)) return 'parked';
  return decision === 'PASS' ? 'pass' : 'fail';
}

/** Minimal shape a row needs to be facet-filtered. */
export interface FacetableRow {
  agent_id: string;
  stage: string | null;
  verdict: Verdict;
}

/** Selected facet values. Empty string / undefined means "all" for that facet. */
export interface AuditFacetSelection {
  agent?: string;
  stage?: string;
  verdict?: Verdict | '';
}

/** Filter rows by the selected facets (AND across facets; empty = no constraint). */
export function applyAuditFacets<T extends FacetableRow>(
  rows: T[],
  sel: AuditFacetSelection,
): T[] {
  return rows.filter(
    (r) =>
      (!sel.agent || r.agent_id === sel.agent) &&
      (!sel.stage || r.stage === sel.stage) &&
      (!sel.verdict || r.verdict === sel.verdict),
  );
}
