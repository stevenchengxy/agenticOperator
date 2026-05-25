// Ground truth for match-resume-agent.
//
// Lifted from server/inngest/agents/match-resume-agent.ts (336 lines).
// Three possible emits (NEED_INTERVIEW / NO_INTERVIEW / FAILED) chosen by
// score — `alternativeOf` chains so any one wired branch earns full credit
// for that decision.

import type { GroundTruth } from './types';

export const MATCH_RESUME_GROUND_TRUTH: GroundTruth = {
  fixtureName: 'match-resume-agent',
  productionPath: 'server/inngest/agents/match-resume-agent.ts',
  expectedSteps: [
    // Production fetches requirement detail before scoring (jd text input).
    { id: 'fetch-requirement', tool: 'partner-pg.getRequirement', optional: true },
    { id: 'match', tool: 'robohire.matchResume' },
    { id: 'save-match', tool: 'partner-pg.saveMatchResults' },
    { id: 'write-cmr-neo4j', tool: 'allmeta.writeCandidateMatchResult' },
  ],
  expectedEmits: [
    { name: 'MATCH_PASSED_NEED_INTERVIEW' },
    {
      name: 'MATCH_PASSED_NO_INTERVIEW',
      alternativeOf: 'MATCH_PASSED_NEED_INTERVIEW',
    },
    { name: 'MATCH_FAILED', alternativeOf: 'MATCH_PASSED_NEED_INTERVIEW' },
  ],
  conventions: {
    nonRetriableUsed: false, // matchResume soft-fails instead of throwing
    tryCatchUsed: true,
    minLoggerCalls: 3,
  },
  replacementVerdict:
    'Codegen v2 reproduces match() body well (few-shot entry #6 is verbatim) and the cmr_<candidate>_<jr> PK pattern (entry #14 D2). The branched decision-emit is the risk area: LLM may emit all three or pick wrong threshold. PARTIAL replace: review the score-decision block before merge.',
};
