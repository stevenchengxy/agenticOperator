// AO RAAS tool registry — every wrapper the LLM is allowed to import and
// call when filling Inngest agent step bodies. The 5 production agents
// (createJdAgent, resumeParserAgent, matchResumeAgent, ruleCheckAgent,
// interviewInviterAgent) are the ground truth: every lib they actually
// import is listed here; nothing else is reachable from generated code.
//
// MAINTENANCE:
//   - Adding a new hand-written `@/lib/*` helper that codegen should be
//     able to call? Add a row here.
//   - Phase 2 lib codegen (research doc §B.6) will auto-append entries
//     for libs it generates — keyed off `generatedByLibVersion`.

export type ToolRegistryEntry = {
  /** Lookup key used in AgentSpec.steps[].callsLib. */
  id: string;
  /** Import source path (TS — use @/ alias). */
  importFrom: string;
  /** Named export to import. */
  importName: string;
  /** TS-style signature for the LLM prompt. */
  signature: string;
  /** One-line behavior summary. */
  summary: string;
  /** 'read-only' | 'writes <thing>' | 'external HTTP' — informs error handling guidance. */
  sideEffects: string;
  /** Broad bucket so UIs can group by intent. */
  category: 'partner-pg' | 'robohire' | 'allmeta' | 'minio' | 'inngest' | 'rule-check' | 'logger';
  /**
   * Real call-site snippets from production agents — one or two lines max.
   * Step body filler shows these to the LLM so it mimics the exact AO
   * idioms (null-check + NonRetriableError pattern, soft-fail ok shape,
   * logger.info one-liner format) instead of inventing its own conventions.
   * Added 2026-05-25 from inspection of the 5 real agents (D2 tuning).
   */
  exampleCalls?: string[];
  /**
   * AllmetaOntology entity label this tool writes to (Bundle J).
   * When set, codegen prompts inject the canonical field list so the LLM
   * uses real ontology fields instead of guessing from parse output.
   * Reviewer + dynamic runner also enforce that only canonical keys appear
   * in writeXInstance call sites.
   */
  canonicalEntity?: string;
};

export const TOOL_REGISTRY_RAAS: ReadonlyArray<ToolRegistryEntry> = [
  // ── partner Postgres reads ────────────────────────────────────────────
  {
    id: 'partner-pg.getRequirement',
    importFrom: '@/lib/partner-pg/requirements',
    importName: 'getRequirementDetail',
    signature: 'getRequirementDetail(id: string): Promise<RaasRequirement | null>',
    summary: 'Pull one job requirement snapshot from partner Postgres (read-only).',
    sideEffects: 'read-only',
    category: 'partner-pg',
    // Lifted from create-jd-agent.ts:fetch-requirement — note the null-check
    // → NonRetriableError pattern (every getter follows this).
    exampleCalls: [
      `const r = await getRequirementDetail(requisitionId);
if (!r) {
  throw new NonRetriableError(\`[\${AGENT_NAME}] partner-pg: job_requisition \${requisitionId} not found\`);
}
return r;`,
    ],
  },
  {
    id: 'partner-pg.getRequirementsAgentView',
    importFrom: '@/lib/partner-pg/agent-view',
    importName: 'getRequirementsAgentView',
    signature: 'getRequirementsAgentView(jrIds: string[]): Promise<RequirementView[]>',
    summary: 'Bulk-read requirements with the agent-view projection (rule check uses this).',
    sideEffects: 'read-only',
    category: 'partner-pg',
  },
  {
    id: 'partner-pg.getRecruitingJobs',
    importFrom: '@/lib/partner-pg/recruiting-jobs',
    importName: 'getRecruitingJobsAsRequirements',
    signature: 'getRecruitingJobsAsRequirements(): Promise<Requirement[]>',
    summary: 'List currently-open recruiting jobs cast as requirements.',
    sideEffects: 'read-only',
    category: 'partner-pg',
  },
  {
    id: 'partner-pg.getParsedResume',
    importFrom: '@/lib/partner-pg/parsed-resume',
    importName: 'getParsedResume',
    signature: 'getParsedResume(candidateId: string): Promise<ParsedResume | null>',
    summary: 'Fetch a previously parsed resume row from partner Postgres.',
    sideEffects: 'read-only',
    category: 'partner-pg',
  },
  // ── partner Postgres writes ───────────────────────────────────────────
  {
    id: 'partner-pg.saveCandidate',
    importFrom: '@/lib/partner-pg/candidates',
    importName: 'saveCandidateToPartnerPg',
    signature: 'saveCandidateToPartnerPg(input: SaveCandidateInput): Promise<Candidate>',
    summary: 'Upsert a parsed resume into partner Postgres candidates table.',
    sideEffects: 'writes Candidate row',
    category: 'partner-pg',
  },
  {
    id: 'partner-pg.syncJd',
    importFrom: '@/lib/partner-pg/job-postings',
    importName: 'syncJdToPartnerPg',
    signature: 'syncJdToPartnerPg(input: SyncJdInput): Promise<{ synced: boolean; job_posting_id: string; reason?: string }>',
    summary: 'Write a generated JD (RoboHire output + requirement fields) into job_posting.',
    sideEffects: 'writes JobPosting row',
    category: 'partner-pg',
  },
  {
    id: 'partner-pg.saveMatchResults',
    importFrom: '@/lib/partner-pg/match-results',
    importName: 'saveMatchResultsToPartnerPg',
    signature: 'saveMatchResultsToPartnerPg(input: SaveMatchInput): Promise<{ candidate_match_result_id: string; created: boolean; skipped?: boolean; reason?: string }>',
    summary: 'Persist RoboHire match-resume output (overall + breakdown) to partner Postgres.',
    sideEffects: 'writes CandidateMatchResult row',
    category: 'partner-pg',
  },
  // ── RoboHire direct calls (F4 pattern; never go through RAAS) ─────────
  {
    id: 'robohire.parseResume',
    importFrom: '@/lib/robohire-client',
    importName: 'parseResumeDirect',
    signature: 'parseResumeDirect(pdf: Buffer, opts?: { traceId?: string }): Promise<{ data: ParsedResume; requestId: string }>',
    summary: 'Direct-call RoboHire /api/v1/parse-resume on a raw PDF buffer.',
    sideEffects: 'external HTTP; may throw RobohireApiError',
    category: 'robohire',
  },
  {
    id: 'robohire.generateJd',
    importFrom: '@/lib/robohire-client',
    importName: 'generateJdDirect',
    signature: 'generateJdDirect(input: JdGenInput, opts?: { traceId?: string }): Promise<{ data: JdGeneratedPayload; requestId: string; meta?: unknown }>',
    summary: 'Direct-call RoboHire /api/v1/jobs/generate-jd to synthesize a JD.',
    sideEffects: 'external HTTP; may throw RobohireApiError',
    category: 'robohire',
    // Lifted from create-jd-agent.ts:generate — the canonical RoboHire
    // call pattern: try/catch with NonRetriableError on isClientError.
    exampleCalls: [
      `try {
  const r = await generateJdDirect(
    { prompt, language: 'zh', companyName: requirement.client_name },
    { traceId },
  );
  logger.info(\`[\${AGENT_NAME}] RoboHire generate-jd OK · requestId=\${r.requestId}\`);
  return r;
} catch (e) {
  if (e instanceof RobohireApiError && e.isClientError) {
    throw new NonRetriableError(\`RoboHire generate-jd 4xx: \${e.httpStatus} \${e.code} \${e.message}\`);
  }
  throw e;
}`,
    ],
  },
  {
    id: 'robohire.matchResume',
    importFrom: '@/lib/robohire-client',
    importName: 'matchResumeDirect',
    signature: 'matchResumeDirect(input: { resume: string; jd: string }, opts?: { traceId?: string }): Promise<{ data: MatchPayload; requestId: string; savedAs?: string }>',
    summary: 'Direct-call RoboHire /api/v1/match-resume to score a candidate against a JD.',
    sideEffects: 'external HTTP; may throw RobohireApiError',
    category: 'robohire',
  },
  {
    id: 'robohire.inviteCandidate',
    importFrom: '@/lib/robohire-client',
    importName: 'inviteCandidateDirect',
    signature: 'inviteCandidateDirect(input: InviteCandidateInput, opts?: { traceId?: string }): Promise<{ data: { invite_url?: string; success: boolean }; requestId: string }>',
    summary: 'Direct-call RoboHire /api/v1/invite-candidate to send an interview invitation.',
    sideEffects: 'external HTTP + sends email; may throw RobohireApiError',
    category: 'robohire',
  },
  // ── MinIO ────────────────────────────────────────────────────────────
  {
    id: 'minio.getResumeBuffer',
    importFrom: '@/lib/minio',
    importName: 'getResumeBuffer',
    signature: 'getResumeBuffer(objectKey: string): Promise<Buffer>',
    summary: 'Fetch a resume file by object key from MinIO.',
    sideEffects: 'external HTTP (object storage)',
    category: 'minio',
  },
  {
    id: 'minio.statResume',
    importFrom: '@/lib/minio',
    importName: 'statResume',
    signature: 'statResume(objectKey: string): Promise<{ size: number; etag: string } | null>',
    summary: 'Stat a resume file in MinIO without downloading the body.',
    sideEffects: 'external HTTP (object storage)',
    category: 'minio',
  },
  // ── Allmeta / Neo4j mirror writes ─────────────────────────────────────
  {
    id: 'allmeta.writeJobRequisition',
    importFrom: '@/lib/allmeta-writers',
    importName: 'writeJobRequisitionInstance',
    signature: 'writeJobRequisitionInstance(input: { requirement: Record<string, unknown> }): Promise<{ ok: boolean; error?: string }>',
    summary: 'Mirror a job_requisition row into the Allmeta Neo4j ontology.',
    sideEffects: 'writes Neo4j Job_Requisition instance',
    category: 'allmeta',
    // Lifted from create-jd-agent.ts:write-jr-neo4j — allmeta is soft-fail
    // by design: never throw, log warn on !ok, return the result so
    // downstream steps see what happened.
    exampleCalls: [
      `const r = await writeJobRequisitionInstance({
  requirement: requirement as unknown as Record<string, unknown>,
});
if (r.ok) logger.info(\`[\${AGENT_NAME}] ✓ allmeta wrote Job_Requisition \${requisitionId}\`);
else logger.warn(\`[\${AGENT_NAME}] allmeta JR write failed: \${r.error}\`);
return r;`,
    ],
    canonicalEntity: 'Job_Requisition',
  },
  {
    id: 'allmeta.writeJobPosting',
    importFrom: '@/lib/allmeta-writers',
    importName: 'writeJobPostingInstance',
    signature: 'writeJobPostingInstance(input: { job_posting_id: string; job_requisition_id: string; [k: string]: unknown }): Promise<{ ok: boolean; error?: string }>',
    summary: 'Mirror a job_posting row into the Allmeta Neo4j ontology.',
    sideEffects: 'writes Neo4j Job_Posting instance',
    category: 'allmeta',
    canonicalEntity: 'Job_Posting',
  },
  {
    id: 'allmeta.writeCandidate',
    importFrom: '@/lib/allmeta-writers',
    importName: 'writeCandidateInstance',
    signature: 'writeCandidateInstance(input: { candidate_id: string; [k: string]: unknown }): Promise<{ ok: boolean; error?: string }>',
    summary: 'Mirror a candidate row into the Allmeta Neo4j ontology.',
    sideEffects: 'writes Neo4j Candidate instance',
    category: 'allmeta',
    canonicalEntity: 'Candidate',
  },
  {
    id: 'allmeta.writeResume',
    importFrom: '@/lib/allmeta-writers',
    importName: 'writeResumeInstance',
    signature: 'writeResumeInstance(input: { resume_id: string; candidate_id: string; [k: string]: unknown }): Promise<{ ok: boolean; error?: string }>',
    summary: 'Mirror a parsed resume into the Allmeta Neo4j ontology.',
    sideEffects: 'writes Neo4j Resume instance',
    category: 'allmeta',
    canonicalEntity: 'Resume',
  },
  {
    id: 'allmeta.writeCandidateMatchResult',
    importFrom: '@/lib/allmeta-writers',
    importName: 'writeCandidateMatchResultInstance',
    signature: 'writeCandidateMatchResultInstance(input: { candidate_match_result_id: string; candidate_id: string | null; job_requisition_id: string; [k: string]: unknown }): Promise<{ ok: boolean; error?: string }>',
    summary: 'Mirror a match-result row (overall + per-dimension) into the Allmeta Neo4j ontology.',
    sideEffects: 'writes Neo4j Candidate_Match_Result instance',
    category: 'allmeta',
    canonicalEntity: 'Candidate_Match_Result',
  },
  {
    id: 'allmeta.writeCommunicationLog',
    importFrom: '@/lib/allmeta-writers',
    importName: 'writeCommunicationLogInstance',
    signature: 'writeCommunicationLogInstance(input: { communication_log_id: string; candidate_id: string; channel: string; [k: string]: unknown }): Promise<{ ok: boolean; error?: string }>',
    summary: 'Mirror an outbound communication (email / SMS / phone) into the Allmeta ontology.',
    sideEffects: 'writes Neo4j Communication_Log instance',
    category: 'allmeta',
    canonicalEntity: 'Communication_Log',
  },
  {
    id: 'allmeta.writeInterviewRecord',
    importFrom: '@/lib/allmeta-writers',
    importName: 'writeInterviewRecordInstance',
    signature: 'writeInterviewRecordInstance(input: { interview_record_id: string; candidate_id: string; job_requisition_id: string; [k: string]: unknown }): Promise<{ ok: boolean; error?: string }>',
    summary: 'Mirror an interview event (invitation/round/result) into the Allmeta ontology.',
    sideEffects: 'writes Neo4j Interview_Record instance',
    category: 'allmeta',
    canonicalEntity: 'Interview_Record',
  },
  // ── Rule check ───────────────────────────────────────────────────────
  {
    id: 'rule-check.run',
    importFrom: '@/lib/rule-check',
    importName: 'runRuleCheck',
    signature: 'runRuleCheck(input: RuleCheckInput): Promise<{ verdict: "pass" | "fail"; dims: DimResult[]; auditId: string }>',
    summary: 'Run the ontology-grounded rule check on a (candidate, requirement) pair.',
    sideEffects: 'reads ontology rules; may call LLM; writes RuleCheckAudit row',
    category: 'rule-check',
  },
  // ── Inngest plumbing — always available, registered for completeness ──
  {
    id: 'inngest.send',
    importFrom: '@/server/inngest/client',
    importName: 'inngest',
    signature: "inngest.send({ name: string, data: unknown }): Promise<void>",
    summary: 'Emit a downstream event so the next agent in the workflow picks it up.',
    sideEffects: 'writes EventInstance + fans out to subscribers',
    category: 'inngest',
    // NOTE: in production agents, emits typically go via step.sendEvent(stepKey, ...)
    // for idempotent retry — but inngest.send is fine for terminal emits.
    exampleCalls: [
      `await inngest.send({
  name: 'JD_GENERATED',
  data: { job_requisition_id, job_posting_id, jd_content } satisfies JdGeneratedEnvelope,
});`,
    ],
  },
  {
    id: 'logger.event',
    importFrom: '@/lib/agent-logger',
    importName: 'createAgentLogger',
    signature: 'logger.event(name: string, data?: Record<string, unknown>): void',
    summary: 'Structured log line via the agent logger (preferred over console.log).',
    sideEffects: 'writes AgentRunLog',
    category: 'logger',
  },
];

export function findTool(id: string): ToolRegistryEntry | undefined {
  return TOOL_REGISTRY_RAAS.find((t) => t.id === id);
}
