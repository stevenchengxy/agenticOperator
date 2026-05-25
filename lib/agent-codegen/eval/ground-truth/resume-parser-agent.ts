// Ground truth for resume-parser-agent.
//
// Lifted from server/inngest/agents/resume-parser-agent.ts (470 lines).
// Conditional emit (PARSE_ERROR on failure) modeled via alternativeOf so
// codegen earns credit when either branch is wired correctly.

import type { GroundTruth } from './types';

export const RESUME_PARSER_GROUND_TRUTH: GroundTruth = {
  fixtureName: 'resume-parser-agent',
  productionPath: 'server/inngest/agents/resume-parser-agent.ts',
  expectedSteps: [
    // Production wraps download + parse in ONE step.run for atomicity
    // (resume buffer is heavy; don't split).
    { id: 'download-and-parse', tool: 'robohire.parseResume' },
    { id: 'save-candidate', tool: 'partner-pg.saveCandidate' },
    { id: 'write-candidate-neo4j', tool: 'allmeta.writeCandidate' },
    { id: 'write-resume-neo4j', tool: 'allmeta.writeResume' },
  ],
  expectedEmits: [
    { name: 'RESUME_PROCESSED' },
    { name: 'RESUME_PARSE_ERROR', alternativeOf: 'RESUME_PROCESSED' },
  ],
  conventions: {
    nonRetriableUsed: true,
    tryCatchUsed: true,
    minLoggerCalls: 3,
  },
  replacementVerdict:
    'Codegen v2 typically produces a clean draft (~85%). The download-and-parse step is well-covered by few-shot entry #4; save-candidate by #5. Risk areas: production includes a sha256-based dedup key for upload_id which codegen may omit. PARTIAL replace: 5-min hand-finish for the dedup, then ship.',
};
