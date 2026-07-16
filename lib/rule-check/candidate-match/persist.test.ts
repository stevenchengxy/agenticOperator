import { describe, it, expect, vi, beforeEach } from 'vitest';

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock('@/server/db', () => ({ prisma: { ontologyRuleCheck: { upsert } } }));

import { persistCandidateRuleCheck } from './persist';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import type { CandidateOntologyCheck } from './to-ontology-check';

const check: CandidateOntologyCheck = {
  decision: 'VIOLATED',
  redlineFlag: false,
  selectionOk: true,
  rulesTotal: 3,
  rulesSelected: 3,
  rulesExpected: 3,
  rulesEvaluated: 3,
  evals: [
    { ruleId: 'IDENTITY-3', ruleName: '六字段', ruleGroup: '身份去重', hardSoft: 'soft', result: 'FAIL', checkPoint: '命中', evidence: 'name:ai✓' },
  ],
};

beforeEach(() => {
  upsert.mockReset();
  upsert.mockImplementation(async (args: any) => ({ id: args.where.id }));
});

describe('persistCandidateRuleCheck', () => {
  it('upserts on a deterministic execution id so a retry can not duplicate the row', async () => {
    const res = await persistCandidateRuleCheck({
      agentSlug: 'rule-check-candidate-identity',
      agentName: '规则校验·候选人身份去重',
      stage: '候选人入库',
      caseId: 'run_42',
      runId: 'run_42',
      ruleSource: 'snapshot',
      selectionNote: { note: 'x' },
      check,
    });
    expect(upsert).toHaveBeenCalledOnce();
    const args = upsert.mock.calls[0][0];
    expect(args.where.id).toMatch(/^orc_[a-f0-9]{40}$/);
    expect(res.id).toBe(args.where.id);
    // create payload
    expect(args.create.domain).toBe(RECRUITMENT_DOMAIN_ID);
    expect(args.create.agentSlug).toBe('rule-check-candidate-identity');
    expect(args.create.stage).toBe('候选人入库');
    expect(args.create.decision).toBe('VIOLATED');
    expect(typeof args.create.selectionNote).toBe('string');
    expect(args.create.evals.create).toHaveLength(1);
    expect(args.create.evals.create[0]).toMatchObject({ ruleId: 'IDENTITY-3', result: 'FAIL' });
  });

  it('on replay (update path) refreshes the evals (deleteMany + recreate)', async () => {
    await persistCandidateRuleCheck({
      agentSlug: 'rule-check-candidate-ownership',
      agentName: '规则校验·候选人归属判定',
      stage: '候选人认领',
      caseId: 'run_7',
      runId: 'run_7',
      ruleSource: 'snapshot',
      check,
    });
    const args = upsert.mock.calls[0][0];
    expect(args.update.decision).toBe('VIOLATED');
    expect(args.update.evals.deleteMany).toBeDefined();
    expect(args.update.evals.create).toHaveLength(1);
    expect(args.create.runId).toBe('run_7');
  });
});
