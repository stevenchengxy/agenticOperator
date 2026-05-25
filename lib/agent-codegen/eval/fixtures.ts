// Eval fixtures — one per production agent (5 in total).
//
// Each fixture is the operator-input the codegen pipeline would receive
// if we asked it to regenerate this exact agent today. The harness runs
// the pipeline with these inputs and compares the generated code against
// `server/inngest/agents/<slug>.ts` to measure how close we are.
//
// IMPORTANT: keep the business description text faithful to what a real
// operator would type — not a transcript of the production code. The
// point is to measure realistic codegen quality, not to ship perfect
// inputs that match the prod code 1:1.

import type { AgentFormFields } from '../spec-types';

export type EvalFixture = {
  /** Short slug used by `npm run codegen:eval -- --fixture=<name>`. */
  name: string;
  /** Path to the production reference (relative to repo root). */
  productionPath: string;
  /** Form fields as if operator clicked "🔁 Regenerate existing" → picked this agent. */
  form: AgentFormFields;
  /** Business description prose the operator would paste. */
  businessLogic: string;
};

export const FIXTURES: ReadonlyArray<EvalFixture> = [
  {
    name: 'create-jd-agent',
    productionPath: 'server/inngest/agents/create-jd-agent.ts',
    form: {
      slug: 'create-jd-agent',
      displayName: 'Create JD Agent',
      stage: 'jd',
      ownerTeam: 'HSM·交付',
      triggerEvent: 'REQUIREMENT_LOGGED',
      emitEvents: ['JD_GENERATED'],
      retries: 2,
      errorHandling: 'retry',
    },
    businessLogic: `1. Pull job_requisition from partner Postgres by event.data.job_requisition_id
2. Mirror the requirement into Allmeta Neo4j as a Job_Requisition node
3. Build a prompt from requirement fields (client_job_title, must_have_skills,
   nice_to_have_skills, work_years, salary_range_raw, city)
4. Call RoboHire /generate-jd with { prompt, language: 'zh', companyName }
   - 4xx errors → NonRetriableError; 5xx allowed to retry
5. Write the generated JD into partner Postgres job_posting via syncJdToPartnerPg
6. Mirror the new job_posting into Allmeta Neo4j as a Job_Posting node
7. emit JD_GENERATED with { job_requisition_id, job_posting_id, jd_content }`,
  },

  {
    name: 'resume-parser-agent',
    productionPath: 'server/inngest/agents/resume-parser-agent.ts',
    form: {
      slug: 'resume-parser-agent',
      displayName: 'Resume Parser Agent',
      stage: 'resume',
      ownerTeam: '招聘运营',
      triggerEvent: 'RESUME_DOWNLOADED',
      emitEvents: ['RESUME_PROCESSED', 'RESUME_PARSE_ERROR'],
      retries: 2,
      errorHandling: 'retry',
    },
    businessLogic: `On RESUME_DOWNLOADED with data { minio_object_key, upload_id, filename }:
1. minio.statResume on the object key — if size > 10MB throw NonRetriableError
2. minio.getResumeBuffer to download the PDF buffer
3. RoboHire parse-resume on the buffer (pass filename + trace_id)
   - 4xx RobohireApiError → NonRetriableError + emit RESUME_PARSE_ERROR
4. saveCandidateToPartnerPg with { upload_id, parsed_resume_json, source }
5. Mirror Candidate into Allmeta Neo4j (writeCandidateInstance)
6. Mirror Resume into Allmeta Neo4j (writeResumeInstance)
7. emit RESUME_PROCESSED on success`,
  },

  {
    name: 'match-resume-agent',
    productionPath: 'server/inngest/agents/match-resume-agent.ts',
    form: {
      slug: 'match-resume-agent',
      displayName: 'Match Resume Agent',
      stage: 'match',
      ownerTeam: '招聘运营',
      triggerEvent: 'MATCH_RULE_CHECK_PASSED',
      emitEvents: ['MATCH_PASSED_NEED_INTERVIEW', 'MATCH_PASSED_NO_INTERVIEW', 'MATCH_FAILED'],
      retries: 2,
      errorHandling: 'retry',
    },
    businessLogic: `On MATCH_RULE_CHECK_PASSED:
1. Fetch the requirement (jrId from event.data.job_requisition_id)
2. Flatten requirement into jdText; build resumeText from event.data.parsed_resume_json
3. Call RoboHire /match-resume
   - 4xx → return { ok: false, error } and immediately step.sendEvent MATCH_FAILED
4. On ok=true: saveMatchResultsToPartnerPg with full envelope
5. Mirror Candidate_Match_Result.overall_* into Allmeta (PK = cmr_<candidate>_<jr>)
6. Decide emit by score:
   - if matching_score === null → MATCH_FAILED
   - else if needsInterview(score) → MATCH_PASSED_NEED_INTERVIEW
   - else → MATCH_PASSED_NO_INTERVIEW`,
  },

  {
    name: 'rule-check-agent',
    productionPath: 'server/inngest/agents/rule-check-agent.ts',
    form: {
      slug: 'rule-check-agent',
      displayName: 'Rule Check Agent',
      stage: 'match',
      ownerTeam: '合规',
      triggerEvent: 'RESUME_PROCESSED',
      emitEvents: ['MATCH_RULE_CHECK_PASSED', 'MATCH_RULE_CHECK_FAILED'],
      retries: 2,
      errorHandling: 'retry',
    },
    businessLogic: `On RESUME_PROCESSED (data: { candidate_id, upload_id, parsed_resume_json }):

1. List current open requirements via getRecruitingJobsAsRequirements
2. Pull the parsed resume (canonical row) via getParsedResume(candidate_id)
3. For each requirement (the spec describes one JR — fan-out is implicit):
   a. Mirror the JR into Allmeta (writeJobRequisitionInstance)
   b. buildRuleCheckInput({ requirement, candidate, parsedResume })
   c. runRuleCheck(input) → { verdict, dims, auditId }
   d. Write audit row back to partner-pg
   e. Write Candidate_Match_Result.rule_check_* fields into Allmeta
4. Emit MATCH_RULE_CHECK_PASSED on verdict='pass', MATCH_RULE_CHECK_FAILED on 'fail'`,
  },

  {
    name: 'interview-inviter-agent',
    productionPath: 'server/inngest/agents/interview-inviter-agent.ts',
    form: {
      slug: 'interview-inviter-agent',
      displayName: 'Interview Inviter Agent',
      stage: 'interview',
      ownerTeam: '技术招聘',
      triggerEvent: 'INTERVIEW_INVITATION_REQUESTED',
      emitEvents: ['INTERVIEW_INVITATION_SENT', 'INTERVIEW_INVITATION_FAILED'],
      retries: 2,
      errorHandling: 'retry',
    },
    businessLogic: `On INTERVIEW_INVITATION_REQUESTED:
1. If resume_text missing in payload, getParsedResume(candidate_id) for backfill
2. If jd_text missing in payload, getRequirementDetail(job_requisition_id) for backfill
3. Call RoboHire /invite-candidate with traceId
   - 4xx → NonRetriableError + emit INTERVIEW_INVITATION_FAILED
   - HTTP 2xx but body.success === false → ALSO NonRetriableError (GoHire rejected)
4. On success, write CommunicationLog into Allmeta (channel=email, subject=AI interview invitation, status=sent)
5. Write InterviewRecord into Allmeta (status=invited, interview_type=video)
6. emit INTERVIEW_INVITATION_SENT`,
  },
];

export function findFixture(name: string): EvalFixture | undefined {
  return FIXTURES.find((f) => f.name === name);
}
