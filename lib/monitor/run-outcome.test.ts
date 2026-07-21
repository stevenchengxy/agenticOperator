import { describe, expect, it } from 'vitest';
import { deriveEventOutcome, deriveRunOutcome, summaryContradictsOutcome } from './run-outcome';

describe('deriveRunOutcome', () => {
  it('separates a healthy matcher execution from a rejected business result', () => {
    expect(deriveRunOutcome({
      status: 'Completed',
      functionSlug: 'agentic-operator-main-match-resume-agent',
      output: { ok: true, eventName: 'MATCH_FAILED', matching_score: 31 },
    })).toMatchObject({ technical: 'healthy', business: 'rejected', score: 31 });
  });

  it('marks a vendor failure as technical failure with blocked business outcome', () => {
    expect(deriveRunOutcome({
      status: 'Failed',
      output: { error: { message: 'connect ETIMEDOUT' } },
      dependencyFailure: { provider: 'robohire', reason: 'network', detail: 'connect ETIMEDOUT' },
    })).toMatchObject({
      technical: 'failed',
      business: 'blocked',
      reason: 'connect ETIMEDOUT',
      technicalCause: 'timeout',
      provider: 'RoboHire',
      recoveryAction: 'auto_retry',
    });
  });

  it('identifies an exhausted paid dependency and gives a top-up recovery action', () => {
    expect(deriveRunOutcome({
      status: 'Failed',
      output: { error_code: 'ROBOHIRE_QUOTA', error: 'insufficient balance' },
      dependencyFailure: { provider: 'robohire', reason: 'quota', detail: 'no credits remaining' },
    })).toMatchObject({
      technical: 'failed',
      business: 'blocked',
      technicalCause: 'quota_exhausted',
      provider: 'RoboHire',
      recoveryAction: 'top_up_then_retry',
    });
  });

  it('does not paint completed ok:false precondition blocks green', () => {
    expect(deriveRunOutcome({
      status: 'Completed',
      output: { ok: false, error: 'missing-job-requisition-or-parsed-resume' },
    })).toMatchObject({ technical: 'degraded', business: 'blocked' });
  });

  it('treats a GoHire rejection as business rejection, not vendor outage', () => {
    expect(deriveRunOutcome({
      status: 'Completed',
      output: { ok: false, error: 'GOHIRE_REJECTED', error_code: 'GOHIRE_REJECTED' },
    })).toMatchObject({ technical: 'healthy', business: 'rejected' });
  });

  it('keeps a delivered business result but marks secondary persistence warnings degraded', () => {
    expect(deriveRunOutcome({
      status: 'Completed',
      output: {
        ok: true,
        eventName: 'INTERVIEW_INVITATION_SENT',
        technical_warnings: ['Allmeta Interview_Record write failed'],
      },
    })).toMatchObject({
      technical: 'degraded',
      business: 'passed',
      reason: 'Allmeta Interview_Record write failed',
      technicalCause: 'persistence',
      provider: 'Allmeta',
      recoveryAction: 'repair_persistence',
    });
  });

  it('classifies missing input without depending on a specific agent slug', () => {
    expect(deriveRunOutcome({
      status: 'Completed',
      functionSlug: 'future-agent-not-known-to-the-operator',
      output: { ok: false, error: 'missing required payload field: entity_id' },
    })).toMatchObject({
      technical: 'degraded',
      business: 'blocked',
      technicalCause: 'missing_input',
      recoveryAction: 'fix_input',
    });
  });

  it('distinguishes missing dependency data from a storage outage', () => {
    expect(deriveRunOutcome({
      status: 'Failed',
      output: { error: '[createJD] partner Postgres: job_requisition REQ-001 不存在' },
    })).toMatchObject({
      technicalCause: 'data_not_found',
      provider: 'Partner PG',
      recoveryAction: 'fix_input',
    });
  });
});

describe('deriveEventOutcome', () => {
  it('shows MATCH_FAILED success=true as delivered but business-rejected', () => {
    expect(deriveEventOutcome('MATCH_FAILED', { success: true, matching_score: 22 })).toMatchObject({
      technical: 'healthy',
      business: 'rejected',
    });
  });

  it('shows an invitation API failure as a technical block', () => {
    expect(deriveEventOutcome('INTERVIEW_INVITATION_FAILED', {
      error_code: 'ROBOHIRE_4XX',
      error_message: '401 invalid key',
    })).toMatchObject({ technical: 'degraded', business: 'blocked' });
  });
});

describe('summaryContradictsOutcome', () => {
  it('suppresses a stale summary that advances a rejected match to interview', () => {
    expect(summaryContradictsOutcome(
      '系统判定候选人符合业务要求，匹配达标，建议推进后续面试。',
      deriveRunOutcome({
        status: 'Completed',
        output: { ok: true, eventName: 'MATCH_FAILED', matching_score: 25 },
      }),
    )).toBe(true);
  });

  it('keeps a summary that honestly reports the rejected business result', () => {
    expect(summaryContradictsOutcome(
      '执行正常，但匹配未通过，不应进入自动面试邀约。',
      deriveRunOutcome({
        status: 'Completed',
        output: { ok: true, eventName: 'MATCH_FAILED', matching_score: 25 },
      }),
    )).toBe(false);
  });

  it('suppresses an old auto-retry recommendation when operator input is required', () => {
    expect(summaryContradictsOutcome(
      '这是系统临时波动，请等待系统自动重试和重放。',
      deriveRunOutcome({
        status: 'Failed',
        output: { error: 'missing required payload field: entity_id' },
      }),
    )).toBe(true);
  });

  it('requires a top-up to be mentioned before describing quota recovery', () => {
    const outcome = deriveRunOutcome({
      status: 'Failed',
      dependencyFailure: { provider: 'llm', reason: 'quota', detail: 'insufficient credits' },
    });
    expect(summaryContradictsOutcome('系统将自动重试，请等待恢复。', outcome)).toBe(true);
    expect(summaryContradictsOutcome('AI 网关额度不足，充值后系统会自动续跑。', outcome)).toBe(false);
  });
});
