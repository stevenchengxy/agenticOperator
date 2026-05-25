// Ground truth for rule-check-agent.
//
// Lifted from server/inngest/agents/rule-check-agent.ts (649 lines —
// the largest production agent). Production has hand-rolled per-JR fan-out
// + multi-step audit writes that codegen v2 won't reproduce 1:1; the
// expected step list below describes the SINGLE-JR happy path which is
// what the spec models.
//
// expected: low PARTIAL or DRAFT verdict; this is the upper bound of
// codegen v2 difficulty.

import type { GroundTruth } from './types';

export const RULE_CHECK_GROUND_TRUTH: GroundTruth = {
  fixtureName: 'rule-check-agent',
  productionPath: 'server/inngest/agents/rule-check-agent.ts',
  expectedSteps: [
    { id: 'list-requirements', tool: 'partner-pg.getRecruitingJobs' },
    { id: 'fetch-parsed-resume', tool: 'partner-pg.getParsedResume' },
    // The next four are inside the per-JR loop in production. Codegen
    // produces them flat (single iteration) — that's expected, fan-out
    // is hand-added afterward.
    { id: 'write-jr-neo4j', tool: 'allmeta.writeJobRequisition' },
    { id: 'rule-check', tool: 'rule-check.run' },
    { id: 'write-audit', optional: true }, // partner-pg audit table — no dedicated tool registry id
    { id: 'write-cmr', tool: 'allmeta.writeCandidateMatchResult' },
  ],
  expectedEmits: [
    { name: 'MATCH_RULE_CHECK_PASSED' },
    {
      name: 'MATCH_RULE_CHECK_FAILED',
      alternativeOf: 'MATCH_RULE_CHECK_PASSED',
    },
  ],
  conventions: {
    nonRetriableUsed: true,
    tryCatchUsed: true,
    minLoggerCalls: 4,
  },
  replacementVerdict:
    "Most demanding fixture. Production's per-JR fan-out + buildRuleCheckInput shape are NOT in the spec model — codegen produces single-JR flow. Realistic verdict: DRAFT, expect 30-60min hand-finish (add the for-loop, refine buildRuleCheckInput call). Worth using codegen here mostly as a skeleton primer.",
};
