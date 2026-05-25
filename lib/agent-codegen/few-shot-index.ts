// Few-shot examples for step-body-filler. Each entry is a real step.run
// callback body lifted from one of the 5 production agents (createJd,
// resumeParser, matchResume, ruleCheck, interviewInviter), trimmed to its
// essence so the LLM sees idiomatic AO patterns:
//   - NonRetriableError for 4xx / unrecoverable conditions
//   - logger.info / logger.event for observability
//   - return shape (always returns something; downstream steps consume it)
//   - try/catch around external HTTP, raise typed RobohireApiError reasons
//
// Selection strategy used by the step body filler:
//   1. exact stage match (interview → interview few-shots)
//   2. lib overlap (steps that call the same tool as the new step)
//   3. fall back to top 3 most-cited bodies
//
// Per the research doc (§A.5.3) this is AO's grounding asset — the corpus
// is AO's own agents, no third-party retrieval.

import type { Stage } from '@/lib/agent-mapping';

export type FewShotEntry = {
  /** Source file, for traceability. */
  source: string;
  /** Stage from which this snippet was extracted. */
  stage: Stage;
  /** step.run('id', ...) — the operator-supplied step id. */
  stepName: string;
  /** Tool ids touched (look up against TOOL_REGISTRY_RAAS). */
  toolIds: string[];
  /** TS source — the inside of the async () => { ... } callback. */
  body: string;
};

export const FEW_SHOT_INDEX: ReadonlyArray<FewShotEntry> = [
  // ── JD generation patterns ──────────────────────────────────────────
  {
    source: 'server/inngest/agents/create-jd-agent.ts',
    stage: 'jd',
    stepName: 'fetch-requirement',
    toolIds: ['partner-pg.getRequirement'],
    body: `const r = await getRequirementDetail(requisitionId);
if (!r) {
  throw new NonRetriableError(\`[\${AGENT_NAME}] partner-pg: job_requisition \${requisitionId} not found\`);
}
logger.info(\`[\${AGENT_NAME}] fetched JR \${requisitionId} title="\${r.client_job_title ?? '?'}"\`);
return r;`,
  },
  {
    source: 'server/inngest/agents/create-jd-agent.ts',
    stage: 'jd',
    stepName: 'generate',
    toolIds: ['robohire.generateJd'],
    body: `try {
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
  },
  {
    source: 'server/inngest/agents/create-jd-agent.ts',
    stage: 'jd',
    stepName: 'sync-jd',
    toolIds: ['partner-pg.syncJd'],
    body: `const r = await syncJdToPartnerPg({
  job_requisition_id: requisitionId,
  client_id: clientId,
  ...(jdData as Record<string, unknown>),
});
logger.info(\`[\${AGENT_NAME}] partner-pg syncJd OK · job_posting_id=\${r.job_posting_id}\`);
return r;`,
  },

  // ── Resume parsing patterns ─────────────────────────────────────────
  {
    source: 'server/inngest/agents/resume-parser-agent.ts',
    stage: 'resume',
    stepName: 'download-and-parse',
    toolIds: ['minio.getResumeBuffer', 'robohire.parseResume'],
    body: `const pdf = await getResumeBuffer(objectKey);
try {
  const r = await parseResumeDirect(pdf, { traceId });
  logger.info(\`[\${AGENT_NAME}] parsed resume \${objectKey} chars=\${r.data.text?.length ?? 0}\`);
  return r;
} catch (e) {
  if (e instanceof RobohireApiError && e.isClientError) {
    throw new NonRetriableError(\`RoboHire parse-resume 4xx: \${e.httpStatus} \${e.code}\`);
  }
  throw e;
}`,
  },
  {
    source: 'server/inngest/agents/resume-parser-agent.ts',
    stage: 'resume',
    stepName: 'save-candidate',
    toolIds: ['partner-pg.saveCandidate'],
    body: `const r = await saveCandidateToPartnerPg({
  upload_id: event.data.upload_id,
  parsed_resume_json: parsed.data,
  source: 'resume-parser-agent',
});
logger.info(\`[\${AGENT_NAME}] saveCandidate OK · candidate_id=\${r.candidate_id}\`);
return r;`,
  },

  // ── Matching patterns ────────────────────────────────────────────────
  {
    source: 'server/inngest/agents/match-resume-agent.ts',
    stage: 'match',
    stepName: 'match',
    toolIds: ['robohire.matchResume'],
    body: `try {
  const r = await matchResumeDirect(
    { resume: resumeText, jd: jdText },
    { traceId: traceId ?? undefined },
  );
  logger.info(\`[\${AGENT_NAME}] match OK · score=\${r.data.matchScore} requestId=\${r.requestId}\`);
  return { ok: true as const, data: r.data, requestId: r.requestId };
} catch (e) {
  if (e instanceof RobohireApiError && e.isClientError) {
    return { ok: false as const, error: \`\${e.code}: \${e.message}\` };
  }
  throw e;
}`,
  },
  {
    source: 'server/inngest/agents/match-resume-agent.ts',
    stage: 'match',
    stepName: 'save-match',
    toolIds: ['partner-pg.saveMatchResults'],
    body: `const r = await saveMatchResultsToPartnerPg({
  candidate_id: candidateId,
  job_requisition_id: data.job_requisition_id,
  source: 'need_interview',
  created_by: 'ai_engine',
  raw_llm_response: matchResult.data as Record<string, unknown>,
});
logger.info(\`[\${AGENT_NAME}] saveMatchResults OK · cmr=\${r.candidate_match_result_id}\`);
return r;`,
  },

  // ── Rule check patterns ─────────────────────────────────────────────
  {
    source: 'server/inngest/agents/rule-check-agent.ts',
    stage: 'match',
    stepName: 'rule-check',
    toolIds: ['rule-check.run'],
    body: `const input = await buildRuleCheckInput({ requirement: req, candidate, parsedResume });
const r = await runRuleCheck(input);
logger.event('rule-check.complete', { verdict: r.verdict, dim_count: r.dims.length, audit_id: r.auditId });
return r;`,
  },

  // ── Interview invitation patterns ───────────────────────────────────
  {
    source: 'server/inngest/agents/interview-inviter-agent.ts',
    stage: 'interview',
    stepName: 'invite',
    toolIds: ['robohire.inviteCandidate'],
    body: `try {
  const r = await inviteCandidateDirect(input, { traceId });
  if (!r.data.success) {
    throw new NonRetriableError(\`GoHire rejected invite: \${JSON.stringify(r.data)}\`);
  }
  logger.info(\`[\${AGENT_NAME}] invite sent · candidate=\${candidateId} url=\${r.data.invite_url}\`);
  return r;
} catch (e) {
  if (e instanceof RobohireApiError && e.isClientError) {
    throw new NonRetriableError(\`RoboHire invite-candidate 4xx: \${e.code}\`);
  }
  throw e;
}`,
  },
  {
    source: 'server/inngest/agents/interview-inviter-agent.ts',
    stage: 'interview',
    stepName: 'write-comm-log',
    toolIds: ['allmeta.writeCommunicationLog'],
    body: `const commId = \`comm_\${candidateId}_\${Date.now()}\`;
const r = await writeCommunicationLogInstance({
  communication_log_id: commId,
  candidate_id: candidateId,
  channel: 'email',
  subject: 'AI interview invitation',
  status: 'sent',
});
if (!r.ok) logger.warn(\`[\${AGENT_NAME}] allmeta comm-log write failed: \${r.error}\`);
return r;`,
  },

  // ── D2 expansion (2026-05-25) ──────────────────────────────────────
  // Gaps identified by inspection: production agents universally use
  // step.sendEvent(stepKey, ...) instead of inngest.send for downstream
  // emits, so retries are idempotent on the step. Codegen v1 leaned on
  // inngest.send — this entry tilts future generations toward the
  // correct pattern.
  {
    source: 'server/inngest/agents/match-resume-agent.ts',
    stage: 'match',
    stepName: 'emit-match-failed-robohire-error',
    toolIds: ['inngest.send'],
    body: `await step.sendEvent(\`emit-match-failed-\${stepKey}\`, {
  name: 'MATCH_FAILED',
  data: {
    job_requisition_id: data.job_requisition_id,
    candidate_id: candidateId || null,
    matching_score: null,
    upload_id: uploadId || null,
    overall_status: '不匹配',
    success: false,
    data: { error_kind: 'robohire-match-call-failed' },
    error: matchResult.error,
  },
});`,
  },
  // Allmeta soft-fail with PK derivation — the cmr_<candidate>_<jr>
  // pattern is canonical across match + rule-check agents.
  {
    source: 'server/inngest/agents/match-resume-agent.ts',
    stage: 'match',
    stepName: 'write-cmr-neo4j',
    toolIds: ['allmeta.writeCandidateMatchResult'],
    body: `const cmrId = \`cmr_\${candidateId || 'unknown'}_\${data.job_requisition_id}\`;
const r = await writeCandidateMatchResultInstance({
  candidate_match_result_id: cmrId,
  client_id: pickClientId(req) ?? null,
  candidate_id: candidateId,
  job_requisition_id: data.job_requisition_id,
  overall_match_score: matching_score,
  overall_fit_verdict: overall_status,
  overall_match_grade: gradeFromScore(matching_score),
});
if (r.ok) logger.info(\`[\${AGENT_NAME}] ✓ allmeta wrote Candidate_Match_Result \${cmrId}\`);
else logger.warn(\`[\${AGENT_NAME}] allmeta cmr write failed: \${r.error}\`);
return r;`,
  },
  // Partner-pg writer return shape: { synced, job_posting_id, reason? }.
  // Codegen v1 sometimes generated bodies that swallowed the return; this
  // entry shows the production "log then return" idiom.
  {
    source: 'server/inngest/agents/resume-parser-agent.ts',
    stage: 'resume',
    stepName: 'save-candidate-detailed',
    toolIds: ['partner-pg.saveCandidate'],
    body: `const r = await saveCandidateToPartnerPg({
  upload_id: event.data.upload_id,
  parsed_resume_json: parsed.data,
  source: 'resume-parser-agent',
  trace_id: traceId ?? undefined,
});
logger.info(
  \`[\${AGENT_NAME}] saveCandidate OK · candidate_id=\${r.candidate_id} \` +
  \`upload_id=\${event.data.upload_id} created=\${r.created}\`,
);
return r;`,
  },
];

/**
 * Pick the top-N most relevant few-shots for a given (stage, toolIds) target.
 * Scoring: stage match = 3 pts; per-tool overlap = 2 pts; clamp to topN.
 */
export function pickFewShots(opts: {
  stage?: Stage;
  toolIds?: string[];
  topN?: number;
}): FewShotEntry[] {
  const topN = opts.topN ?? 3;
  const targetTools = new Set(opts.toolIds ?? []);
  const scored = FEW_SHOT_INDEX.map((e) => {
    let score = 0;
    if (opts.stage && e.stage === opts.stage) score += 3;
    for (const t of e.toolIds) if (targetTools.has(t)) score += 2;
    return { e, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((x) => x.e);
}
