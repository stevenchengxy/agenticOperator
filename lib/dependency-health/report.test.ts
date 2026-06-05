import { describe, it, expect } from 'vitest';
import { NonRetriableError } from 'inngest';
import { reportDependencyDegraded } from './report';
import type { DepOutcome } from './types';

function degraded(over: Partial<Extract<DepOutcome, { ok: false }>>): Extract<DepOutcome, { ok: false }> {
  return { ok: false, provider: 'robohire', op: 'parseResume', reason: 'quota', detail: 'no funds', ...over };
}

describe('reportDependencyDegraded', () => {
  it('writes one dependency_degraded signal carrying the structured payload, then throws', async () => {
    const writes: any[] = [];
    const fakeRecord = async (input: any) => {
      writes.push(input);
    };

    await expect(
      reportDependencyDegraded(
        degraded({ reason: 'quota' }),
        { agent: 'ResumeParser', runId: 'run_1', domain: '招聘-v1', anchors: { candidate_id: 'c1' } },
        { recordLogEvent: fakeRecord },
      ),
    ).rejects.toBeInstanceOf(Error);

    expect(writes).toHaveLength(1);
    expect(writes[0].type).toBe('dependency_degraded');
    expect(writes[0].agent).toBe('ResumeParser');
    expect(writes[0].runId).toBe('run_1');
    const payload = JSON.parse(writes[0].payloadJson);
    expect(payload).toMatchObject({
      provider: 'robohire',
      op: 'parseResume',
      reason: 'quota',
      domain: '招聘-v1',
      anchors: { candidate_id: 'c1' },
    });
  });

  it('recoverable reasons (quota/rate_limit/network/server) throw a RETRIABLE error (parks + retries)', async () => {
    const noop = async () => {};
    for (const reason of ['quota', 'rate_limit', 'network', 'server'] as const) {
      const err = await reportDependencyDegraded(degraded({ reason }), { domain: '招聘-v1' }, { recordLogEvent: noop }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NonRetriableError);
    }
  });

  it('non-recoverable reasons (auth) throw NonRetriableError (hard fail, no retry)', async () => {
    const noop = async () => {};
    const err = await reportDependencyDegraded(degraded({ reason: 'auth' }), { domain: '招聘-v1' }, { recordLogEvent: noop }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(NonRetriableError);
  });

  it('writes the signal BEFORE throwing (await ordering)', async () => {
    let wrote = false;
    const slowRecord = async () => {
      await Promise.resolve();
      wrote = true;
    };
    await reportDependencyDegraded(degraded({}), { domain: '招聘-v1' }, { recordLogEvent: slowRecord }).catch(() => {});
    expect(wrote).toBe(true);
  });
});
