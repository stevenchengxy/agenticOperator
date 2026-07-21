// Postgres wiring for the eval layer — the MonitorEval upsert store (idempotent
// on (kind, sampledFrom)), the MonitorConfig reader, the eval-sample loader
// (recent rule-check audits → groundedness samples), and readers for drift +
// calibration. Thin; verified by typecheck. Relative imports for the tsx sweeper.

import { prisma } from '../../server/db';
import { RECRUITMENT_DOMAIN_ID } from '../domain-ids';
import type { GroundednessSample } from './groundedness';
import type { EvalStore, MonitorEvalRecord } from './run-eval';
import type { MonitorConfigRow } from './monitor-config';

function evalData(rec: MonitorEvalRecord) {
  return {
    kind: rec.kind,
    sampledFrom: rec.sampledFrom,
    domain: rec.domain,
    agent: rec.agent,
    runId: rec.runId,
    auditId: rec.auditId,
    anchorsJson: rec.anchorsJson,
    score: rec.score,
    verdict: rec.verdict,
    juryVotesJson: rec.juryVotesJson,
    rationale: rec.rationale,
    judgeModel: rec.judgeModel,
    judgeFamily: rec.judgeFamily,
    judgePromptVersion: rec.judgePromptVersion,
    rubricVersion: rec.rubricVersion,
    primaryAgreed: rec.primaryAgreed,
    llmPromptTokens: rec.llmPromptTokens,
    llmCompletionTokens: rec.llmCompletionTokens,
    llmDurationMs: rec.llmDurationMs,
    sweepWindow: rec.sweepWindow,
    autonomyMode: rec.autonomyMode,
    suppressed: rec.suppressed,
    aiSource: rec.aiSource,
  };
}

export function createPgEvalStore(): EvalStore {
  return {
    async upsertEval(rec: MonitorEvalRecord): Promise<void> {
      const data = evalData(rec);
      await prisma.monitorEval.upsert({
        where: { kind_sampledFrom: { kind: rec.kind, sampledFrom: rec.sampledFrom } },
        create: data,
        update: data,
      });
    },
  };
}

export async function getMonitorConfig(domain: string): Promise<MonitorConfigRow | null> {
  const row = await prisma.monitorConfig.findUnique({ where: { domain } });
  if (!row) return null;
  return {
    domain: row.domain,
    samplingPct: row.samplingPct,
    judgeFamily: row.judgeFamily,
    autonomy: row.autonomy,
    thresholdsJson: row.thresholdsJson,
    enabledMonitorsJson: row.enabledMonitorsJson,
  };
}

/**
 * Eval sample loader — recent rule-check audits become groundedness samples:
 * the judge re-checks whether the PASS/FAIL decision is supported by the rules +
 * resume/JD facts. Carries candidate/job anchors + auditId (deep-link).
 */
export async function recentAuditSamples(
  sinceMs: number,
  limit = 200,
): Promise<GroundednessSample[]> {
  const cutoff = new Date(Date.now() - sinceMs);
  const audits = await prisma.ruleCheckAudit.findMany({
    where: { created_at: { gte: cutoff } },
    orderBy: { created_at: 'desc' },
    take: limit,
    select: {
      audit_id: true,
      run_id: true,
      candidate_id: true,
      job_requisition_id: true,
      decision: true,
      failure_reasons: true,
      rule_provenance: true,
      parsed_resume_json: true,
      job_requisition_json: true,
    },
  });
  // Judge each audit at most once — exclude any already in MonitorEval, so a
  // per-tick sweeper doesn't re-pay the LLM for the same sample.
  const done = await prisma.monitorEval.findMany({
    where: { kind: 'groundedness', sampledFrom: { in: audits.map((a) => a.audit_id) } },
    select: { sampledFrom: true },
  });
  const doneSet = new Set(done.map((d) => d.sampledFrom));
  return audits
    .filter((a) => !doneSet.has(a.audit_id))
    .map((a) => ({
    sampledFrom: a.audit_id,
    domain: RECRUITMENT_DOMAIN_ID,
    agent: 'RuleCheck',
    runId: a.run_id,
    auditId: a.audit_id,
    anchors: { candidate_id: a.candidate_id, job_requisition_id: a.job_requisition_id },
    output: `判定:${a.decision}\n理由:${a.failure_reasons}`,
    context:
      `规则依据:${a.rule_provenance ?? '(无)'}\n` +
      `岗位:${(a.job_requisition_json ?? '').slice(0, 1500)}\n` +
      `简历:${(a.parsed_resume_json ?? '').slice(0, 1500)}`,
  }));
}

/** Recent evals of a kind, for drift re-judge comparison. */
export async function recentEvals(
  kind: string,
  limit = 200,
): Promise<Array<{ sampledFrom: string; verdict: string; judgePromptVersion: string | null }>> {
  const rows = await prisma.monitorEval.findMany({
    where: { kind },
    orderBy: { ts: 'desc' },
    take: limit,
    select: { sampledFrom: true, verdict: true, judgePromptVersion: true },
  });
  return rows.map((r) => ({
    sampledFrom: r.sampledFrom ?? '',
    verdict: r.verdict ?? 'unsure',
    judgePromptVersion: r.judgePromptVersion,
  }));
}
