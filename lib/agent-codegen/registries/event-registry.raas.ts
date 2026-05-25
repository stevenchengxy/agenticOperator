// AO RAAS event registry — every known event name in the recruitment
// workflow. Mirrors triggersEvents / emitsEvents across AGENT_MAP plus
// lifecycle events that aren't owned by any agent (SCHEDULED_SYNC,
// MANUAL_REPROCESS_REQUESTED, etc).
//
// Codegen LLM prompts use this list to ground triggerEvent + emitEvents
// to real names, so the generated code's @event hookups actually wire
// into the live workflow.
//
// Maintenance: when a new event is introduced to RAAS, add a row here.
// Ideally future work plumbs in EventDefinition table reads, but the
// static list is the auditable source of truth for now.

export type EventRegistryEntry = {
  name: string;
  /** Stage in the workflow where this event commonly fires (or 'system' for cross-cutting). */
  stage:
    | 'system'
    | 'requirement'
    | 'jd'
    | 'resume'
    | 'match'
    | 'interview'
    | 'eval'
    | 'package'
    | 'submit';
  /** One-line semantic summary for the LLM prompt. */
  summary: string;
  /** Whether agents typically *consume* (trigger) or *produce* (emit) this event. */
  direction: 'consume' | 'produce' | 'both';
};

export const EVENT_REGISTRY_RAAS: ReadonlyArray<EventRegistryEntry> = [
  // System / lifecycle
  { name: 'SCHEDULED_SYNC', stage: 'system', direction: 'consume', summary: 'Cron-style tick to drive periodic pull-from-RAAS sync.' },
  { name: 'SYNC_FAILED_ALERT', stage: 'system', direction: 'produce', summary: 'Emitted when an upstream sync attempt fails.' },

  // Requirement stage
  { name: 'REQUIREMENT_SYNCED', stage: 'requirement', direction: 'both', summary: 'A job_requisition row has been mirrored from RAAS into partner Postgres.' },
  { name: 'REQUIREMENT_LOGGED', stage: 'requirement', direction: 'both', summary: 'A requirement was manually entered or re-logged by an operator.' },
  { name: 'ANALYSIS_COMPLETED', stage: 'requirement', direction: 'both', summary: 'ReqAnalyzer finished structuring the requirement.' },
  { name: 'ANALYSIS_BLOCKED', stage: 'requirement', direction: 'produce', summary: 'Analysis cannot proceed — typically missing critical fields.' },
  { name: 'CLARIFICATION_INCOMPLETE', stage: 'requirement', direction: 'both', summary: 'Clarifier flagged the requirement as needing HITL input.' },
  { name: 'CLARIFICATION_RETRY', stage: 'requirement', direction: 'produce', summary: 'ReClarifier resubmitted clarifications.' },
  { name: 'CLARIFICATION_READY', stage: 'requirement', direction: 'both', summary: 'Requirement has all clarifications and is ready to generate a JD.' },

  // JD stage
  { name: 'JD_GENERATED', stage: 'jd', direction: 'both', summary: 'JDGenerator produced a JD; partner reads jdPosting row from partner-pg.' },
  { name: 'JD_APPROVED', stage: 'jd', direction: 'both', summary: 'JDReviewer (HITL) approved the JD.' },
  { name: 'JD_REJECTED', stage: 'jd', direction: 'both', summary: 'JDReviewer rejected the JD; loops back to JDGenerator.' },
  { name: 'TASK_ASSIGNED', stage: 'jd', direction: 'both', summary: 'TaskAssigner routed the JD to a publisher.' },
  { name: 'CHANNEL_PUBLISHED', stage: 'jd', direction: 'both', summary: 'JD has been published to an external channel.' },
  { name: 'CHANNEL_PUBLISHED_FAILED', stage: 'jd', direction: 'both', summary: 'Publishing to channel failed — ManualPublish takes over.' },

  // Resume stage
  { name: 'RESUME_DOWNLOADED', stage: 'resume', direction: 'both', summary: 'A new resume PDF has been collected and stored in MinIO.' },
  { name: 'RESUME_PROCESSED', stage: 'resume', direction: 'both', summary: 'ResumeParser saved a parsed_resume row + Candidate; RuleCheck takes over.' },
  { name: 'RESUME_PARSE_ERROR', stage: 'resume', direction: 'both', summary: 'Resume PDF could not be parsed; ResumeFixer (HITL) takes over.' },
  { name: 'RESUME_OPTIMIZED', stage: 'resume', direction: 'both', summary: 'ResumeRefiner produced an optimized version for the candidate.' },

  // Match stage
  { name: 'MATCH_RULE_CHECK_PASSED', stage: 'match', direction: 'both', summary: 'RuleCheck verdict pass — Matcher should score the candidate.' },
  { name: 'MATCH_RULE_CHECK_FAILED', stage: 'match', direction: 'produce', summary: 'RuleCheck rejected the candidate before scoring.' },
  { name: 'MATCH_PASSED_NEED_INTERVIEW', stage: 'match', direction: 'both', summary: 'Match score above interview threshold — needs an interview.' },
  { name: 'MATCH_PASSED_NO_INTERVIEW', stage: 'match', direction: 'both', summary: 'Match score above hire threshold but skips interview.' },
  { name: 'MATCH_FAILED', stage: 'match', direction: 'produce', summary: 'Match score below threshold; terminal in the canonical workflow.' },

  // Interview stage
  { name: 'INTERVIEW_INVITATION_REQUESTED', stage: 'interview', direction: 'both', summary: 'RAAS HSM approved an interview; AO should send the invite.' },
  { name: 'INTERVIEW_INVITATION_SENT', stage: 'interview', direction: 'both', summary: 'InterviewInviter successfully sent the invite (RoboHire + email).' },
  { name: 'INTERVIEW_INVITATION_FAILED', stage: 'interview', direction: 'produce', summary: 'Invite send failed (RoboHire 4xx / GoHire rejected / network).' },
  { name: 'AI_INTERVIEW_COMPLETED', stage: 'interview', direction: 'both', summary: 'AIInterviewer finished the AI video interview.' },

  // Eval / package / submit
  { name: 'EVALUATION_PASSED', stage: 'eval', direction: 'both', summary: 'Evaluator concluded the candidate passes downstream gates.' },
  { name: 'EVALUATION_FAILED', stage: 'eval', direction: 'produce', summary: 'Evaluator rejected the candidate.' },
  { name: 'PACKAGE_GENERATED', stage: 'package', direction: 'both', summary: 'PackageBuilder assembled the submission package.' },
  { name: 'PACKAGE_MISSING_INFO', stage: 'package', direction: 'both', summary: 'PackageBuilder needs more data; PackageFiller (HITL) provides it.' },
  { name: 'PACKAGE_APPROVED', stage: 'package', direction: 'both', summary: 'PackageReviewer (HITL) approved the package for submission.' },
  { name: 'APPLICATION_SUBMITTED', stage: 'submit', direction: 'produce', summary: 'PortalSubmitter submitted the package to the customer portal.' },
  { name: 'SUBMISSION_FAILED', stage: 'submit', direction: 'produce', summary: 'Portal submission failed.' },
];

export function eventNames(): string[] {
  return EVENT_REGISTRY_RAAS.map((e) => e.name);
}

export function findEvent(name: string): EventRegistryEntry | undefined {
  return EVENT_REGISTRY_RAAS.find((e) => e.name === name);
}
