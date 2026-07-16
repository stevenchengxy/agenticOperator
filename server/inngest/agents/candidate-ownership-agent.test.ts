import { describe, it, expect, vi } from 'vitest';

vi.mock('@/server/inngest/client', () => ({
  inngest: { createFunction: vi.fn(() => ({ id: 'rule-check-candidate-ownership-agent' })) },
}));

import { candidateOwnershipHandler } from './candidate-ownership-agent';
import type { OwnershipContext } from '@/lib/rule-check/candidate-match/ownership-engine';

const mkStep = () => ({ run: async (_id: string, fn: () => unknown) => fn() });
const ev = { candidate_id: 'cand_1', upload_id: 'up_1', client_id: '腾讯' };

describe('candidateOwnershipHandler', () => {
  it('no-ops when disabled', async () => {
    const persist = vi.fn();
    const r = await candidateOwnershipHandler(
      { event: { data: ev }, step: mkStep() },
      { enabled: false, persist, loadContext: async () => null },
    );
    expect(r.skipped).toBe('disabled');
    expect(persist).not.toHaveBeenCalled();
  });

  it('proceed (FREE) → persists candidate-ownership audit, VALIDATED', async () => {
    const persist = vi.fn(async () => ({ id: 'orc_o1' }));
    const ctx: OwnershipContext = {
      lockState: 1, blacklisted: false, lockByEmail: null, claimantEmail: 'me@c.com', client: null, tencentRelationship: false,
    };
    const r = await candidateOwnershipHandler(
      { event: { data: ev }, step: mkStep(), runId: 'run_9' },
      { enabled: true, persist, loadContext: async () => ctx },
    );
    expect(r.skipped).toBe(false);
    expect(r.decision).toBe('proceed');
    expect(persist).toHaveBeenCalledOnce();
    const args = persist.mock.calls[0][0];
    expect(args.agentSlug).toBe('rule-check-candidate-ownership');
    expect(args.stage).toBe('候选人认领');
    expect(args.check.decision).toBe('VALIDATED');
  });

  it('腾讯 relationship conflict → VIOLATED + conflict', async () => {
    const persist = vi.fn(async () => ({ id: 'orc_o2' }));
    const ctx: OwnershipContext = {
      lockState: 1, blacklisted: false, lockByEmail: 'owner@c.com', claimantEmail: 'me@c.com', client: '腾讯', tencentRelationship: true,
    };
    const r = await candidateOwnershipHandler(
      { event: { data: ev }, step: mkStep() },
      { enabled: true, persist, loadContext: async () => ctx },
    );
    expect(r.decision).toBe('lock-only');
    expect(r.conflict).toBe(true);
    expect(persist.mock.calls[0][0].check.decision).toBe('VIOLATED');
    expect(r.matchedRule).toBe('OWN-TENCENT-1');
  });

  it('no ownership context available → skips without persisting', async () => {
    const persist = vi.fn();
    const r = await candidateOwnershipHandler(
      { event: { data: ev }, step: mkStep() },
      { enabled: true, persist, loadContext: async () => null },
    );
    expect(r.skipped).toBe('no-context');
    expect(persist).not.toHaveBeenCalled();
  });

  it('retries when persist throws so no ownership decision lacks an audit', async () => {
    const persist = vi.fn(async () => { throw new Error('db down'); });
    const ctx: OwnershipContext = { lockState: 1, blacklisted: false, lockByEmail: null, claimantEmail: 'me@c.com', client: null, tencentRelationship: false };
    await expect(candidateOwnershipHandler(
      { event: { data: ev }, step: mkStep() },
      { enabled: true, persist, loadContext: async () => ctx },
    )).rejects.toThrow(/RULE_AUDIT_PERSISTENCE_FAILED.*db down/);
  });
});
