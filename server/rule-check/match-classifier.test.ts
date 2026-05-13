import { describe, expect, it } from 'vitest';
import { classifyMatch } from './match-classifier';
import type { MatchResumeCheckResult } from '@/lib/rule-check/types';

const baseActual = (overrides: Partial<MatchResumeCheckResult> = {}): MatchResumeCheckResult => ({
  decision: 'PASS',
  stats: { total: 0, pass: 0, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
  rule_results: [],
  explanations: [],
  audit: {
    rules_evaluated: 0, graph_calls: 0, llm_model: 'm', llm_duration_ms: 0,
    llm_round_trips: 0, rule_source: 'ontology-api',
  },
  ...overrides,
});

describe('classifyMatch', () => {
  it('pass when decision matches and rule pins match', () => {
    const out = classifyMatch(
      { decision: 'PASS', rule_status: {} },
      baseActual({ decision: 'PASS' }),
    );
    expect(out.kind).toBe('pass');
    expect(out.failures).toEqual([]);
  });

  it('fail-decision when decisions differ', () => {
    const out = classifyMatch(
      { decision: 'PASS', rule_status: {} },
      baseActual({ decision: 'REVIEW' }),
    );
    expect(out.kind).toBe('fail-decision');
    expect(out.failures[0]).toContain('decision mismatch');
  });

  it('fail-rule when pinned rule status differs', () => {
    const out = classifyMatch(
      { decision: 'FAIL', rule_status: { '10-25': 'fail' } },
      baseActual({
        decision: 'FAIL',
        rule_results: [{ rule_id: '10-25', rule_name: '华为', step_id: 's1', status: 'pending', reason: 'r' }],
      }),
    );
    expect(out.kind).toBe('fail-rule');
    expect(out.failures[0]).toMatch(/rule 10-25.*expected 'fail'.*got 'pending'/);
  });

  it('fail-missing-rule when LLM dropped a pinned rule', () => {
    const out = classifyMatch(
      { decision: 'FAIL', rule_status: { '10-21': 'fail' } },
      baseActual({ decision: 'FAIL', rule_results: [] }),
    );
    expect(out.kind).toBe('fail-missing-rule');
    expect(out.failures[0]).toMatch(/rule 10-21 missing/);
  });

  it('fail-parse when audit.fail_reason is parse-error', () => {
    const out = classifyMatch(
      { decision: 'PASS', rule_status: {} },
      baseActual({
        decision: 'FAIL',
        audit: { ...baseActual().audit, fail_reason: 'parse-error' },
      }),
    );
    expect(out.kind).toBe('fail-parse');
  });

  it('fail-runtime when audit.fail_reason is ontology-graph-unavailable', () => {
    const out = classifyMatch(
      { decision: 'PASS', rule_status: {} },
      baseActual({
        decision: 'FAIL',
        audit: { ...baseActual().audit, fail_reason: 'ontology-graph-unavailable' },
      }),
    );
    expect(out.kind).toBe('fail-runtime');
  });
});
