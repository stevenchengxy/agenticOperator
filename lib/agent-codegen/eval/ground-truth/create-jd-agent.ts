// Ground truth for create-jd-agent.
//
// Lifted from server/inngest/agents/create-jd-agent.ts (production), 606
// lines. The expected sequence below is the 5 essential step.run blocks
// the agent walks in order; production has extra hand-coded fan-out and
// schema-massaging that codegen v2 is not expected to reproduce 1:1.
//
// The "replacementVerdict" column in the report cites this record:
//   FULL replace      = all expected steps + emits present, conventions met
//   PARTIAL replace   = ≥80% steps present, 1+ convention issue
//   DRAFT only        = <80% steps, needs hand-finish before prod

import type { GroundTruth } from './types';

export const CREATE_JD_AGENT_GROUND_TRUTH: GroundTruth = {
  fixtureName: 'create-jd-agent',
  productionPath: 'server/inngest/agents/create-jd-agent.ts',
  expectedSteps: [
    { id: 'fetch-requirement', tool: 'partner-pg.getRequirement' },
    { id: 'write-jr-neo4j', tool: 'allmeta.writeJobRequisition' },
    { id: 'generate', tool: 'robohire.generateJd' },
    { id: 'sync-jd', tool: 'partner-pg.syncJd' },
    { id: 'write-jobposting-neo4j', tool: 'allmeta.writeJobPosting' },
  ],
  expectedEmits: [{ name: 'JD_GENERATED' }],
  conventions: {
    nonRetriableUsed: true, // partner-pg null check + robohire 4xx wrap
    tryCatchUsed: true, // around generateJdDirect
    minLoggerCalls: 4, // production has ~10; we set a low floor
  },
  replacementVerdict:
    'Codegen v2 can produce a working draft, but the production agent has hand-rolled prompt construction (buildPromptFromRequirement) + multi-field input normalization that codegen will not reproduce. PARTIAL replace: ship as draft + operator hand-edits steps 3+4 before merging to prod.',
};
