// Ground truth for interview-inviter-agent.
//
// Lifted from server/inngest/agents/interview-inviter-agent.ts (527 lines).
// The corner case the production agent solves — RoboHire returns HTTP 2xx
// AND body.success === false (GoHire rejected the candidate downstream)
// must result in NonRetriableError; codegen v2 has this in the few-shot
// index (entry #9), so the replacementVerdict reflects high confidence.

import type { GroundTruth } from './types';

export const INTERVIEW_INVITER_GROUND_TRUTH: GroundTruth = {
  fixtureName: 'interview-inviter-agent',
  productionPath: 'server/inngest/agents/interview-inviter-agent.ts',
  expectedSteps: [
    // Two conditional backfills — marked optional because spec doesn't model
    // conditionals well; LLM may decide to always fetch instead of guard.
    { id: 'backfill-resume', tool: 'partner-pg.getParsedResume', optional: true },
    { id: 'backfill-jd', tool: 'partner-pg.getRequirement', optional: true },
    { id: 'invite', tool: 'robohire.inviteCandidate' },
    { id: 'write-comm-log', tool: 'allmeta.writeCommunicationLog' },
    { id: 'write-interview-record', tool: 'allmeta.writeInterviewRecord' },
  ],
  expectedEmits: [
    { name: 'INTERVIEW_INVITATION_SENT' },
    // FAILED is emitted only on the error branch — alternativeOf
    // signals the analyzer to give credit if either branch is wired.
    { name: 'INTERVIEW_INVITATION_FAILED', alternativeOf: 'INTERVIEW_INVITATION_SENT' },
  ],
  conventions: {
    nonRetriableUsed: true, // both 4xx + 2xx-with-success=false branches
    tryCatchUsed: true,
    minLoggerCalls: 3,
  },
  replacementVerdict:
    'Codegen v2 should produce ≥85% structural match — few-shot entry #9 contains the GoHire 2xx-with-success=false NonRetriableError pattern verbatim. FULL replace candidate: generate, compile, eyeball the backfill guards, ship as draft → PR.',
};
