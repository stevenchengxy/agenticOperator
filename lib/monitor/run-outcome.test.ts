import { describe, expect, it } from 'vitest';
import { deriveEventOutcome, deriveRunOutcome } from './run-outcome';

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
    })).toMatchObject({ technical: 'failed', business: 'blocked', reason: 'connect ETIMEDOUT' });
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
