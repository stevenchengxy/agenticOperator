// Per-run convergence controls for the ontology agent chain.
//
// The ontology event graph has human-review re-entry edges and back-edges
// (EXECUTION_FEEDBACK → rollingRevision → … → EXECUTION_FEEDBACK). To make a
// demo run converge cleanly to "each agent fires once" and always terminate,
// two backstops:
//   1. claimOnce(caseId:action) — an agent processes a given case at most once.
//   2. MAX_CHAIN_DEPTH — a hard depth cap threaded through event payloads.
// Branch actions (loops) are additionally gated behind `enableBranches`.

const claimed = new Set<string>();

/** Returns true the first time this (case, action) pair is seen; false after. */
export function claimOnce(key: string): boolean {
  if (claimed.has(key)) return false;
  // Bound memory across a long-lived dev process.
  if (claimed.size > 5000) claimed.clear();
  claimed.add(key);
  return true;
}

/** Release a single (case, action) claim so it can run again — used by the
 *  human-gate 退回/否决 path to re-enter generateSuggestion for a fresh attempt. */
export function releaseClaim(key: string): void {
  claimed.delete(key);
}

/** Test/seed hook. */
export function resetClaims(): void {
  claimed.clear();
}

export const MAX_CHAIN_DEPTH = 30;
