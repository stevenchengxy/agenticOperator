import { describe, it, expect } from 'vitest';
import { mapResultToResponse, type MapArgs } from './mapper';
import type { MatchResumeCheckResult } from '@/lib/rule-check/types';

function baseResult(over: Partial<MatchResumeCheckResult> = {}): MatchResumeCheckResult {
  return {
    decision: 'FAIL',
    stats: { total: 3, pass: 1, fail: 1, pending: 0, insufficient_info: 1, not_triggered: 0, not_executed: 0 },
    rule_results: [
      { rule_id: '10-5', rule_name: '必备技能一票否决', step_id: '10-2', status: 'fail', reason: '必备技能字面比对未命中', next_action: 'block' },
      { rule_id: '10-16', rule_name: '学历要求', step_id: '10-1', status: 'pass', reason: '大专满足' },
      { rule_id: '10-25', rule_name: '工作年限', step_id: '10-1', status: 'insufficient_info', reason: '简历缺少起止时间' },
    ],
    explanations: [],
    audit: {
      rules_evaluated: 3,
      graph_calls: 6,
      llm_model: 'anthropic/claude-sonnet-4-6',
      llm_duration_ms: 4210,
      llm_round_trips: 1,
      llm_prompt_tokens: 8211,
      llm_completion_tokens: 902,
      rule_source: 'ontology-api',
      rule_provenance: [
        { rule_id: '10-5', tier: 'general', included: true, reason: '纳入' },
        { rule_id: '10-16', tier: 'general', included: true, reason: '纳入' },
        { rule_id: '10-25', tier: 'client', included: true, reason: '纳入' },
        { rule_id: '10-42', tier: 'department', included: false, reason: '排除：规则部门=CDG ≠ 岗位 bg=IEG' },
      ],
    },
    ...over,
  };
}

const args = (result: MatchResumeCheckResult): MapArgs => ({
  result,
  executionId: 'exec_abc',
  requestedDomain: 'RAAS-v1',
  version: 'rules_v0_1_002',
  correlation: { runId: 'tr-1', testCaseId: 'tc-de5ec703' },
  inputsResolved: { candidate: { store: 'neo4j' }, job: { store: 'neo4j' } },
  aoAuditId: null,
  ruleCount: 248,
  startedAt: '2026-06-11T03:15:15.103Z',
  finishedAt: '2026-06-11T03:15:47.842Z',
});

describe('mapResultToResponse — decision 三态', () => {
  it('maps a fail-rule FAIL to not_matched + vetoedBy', () => {
    const r = mapResultToResponse(args(baseResult()));
    expect(r.status).toBe('succeeded');
    expect(r.result?.decision).toBe('not_matched');
    expect(r.result?.decisionDetail.vetoedBy).toEqual(['10-5']);
    expect(r.result?.emittedEvents).toEqual(['MATCH_RULE_CHECK_FAILED']);
  });

  it('maps a FAIL with no fail-rule (only inconclusive) to needs_review', () => {
    const res = baseResult({
      rule_results: [
        { rule_id: '10-16', rule_name: '学历', step_id: '10-1', status: 'pass', reason: 'ok' },
        { rule_id: '10-25', rule_name: '年限', step_id: '10-1', status: 'insufficient_info', reason: '缺字段' },
      ],
    });
    const r = mapResultToResponse(args(res));
    expect(r.result?.decision).toBe('needs_review');
    expect(r.result?.decisionDetail.vetoedBy).toEqual([]);
    expect(r.result?.emittedEvents).toEqual(['MATCH_RULE_CHECK_FAILED']);
  });

  it('maps PASS to matched + MATCH_RULE_CHECK_PASSED', () => {
    const res = baseResult({
      decision: 'PASS',
      rule_results: [{ rule_id: '10-16', rule_name: '学历', step_id: '10-1', status: 'pass', reason: 'ok' }],
    });
    const r = mapResultToResponse(args(res));
    expect(r.result?.decision).toBe('matched');
    expect(r.result?.emittedEvents).toEqual(['MATCH_RULE_CHECK_PASSED']);
  });
});

describe('mapResultToResponse — ruleEvaluations 5+1 态', () => {
  it('maps each AO status to the partner state, incl excluded provenance', () => {
    const r = mapResultToResponse(args(baseResult()));
    const byId = new Map(r.trace!.ruleEvaluations.map((e) => [e.ruleId, e]));
    expect(byId.get('10-5')?.status).toBe('evaluated_violated');
    expect(byId.get('10-5')?.aoStatus).toBe('fail');
    expect(byId.get('10-16')?.status).toBe('evaluated_passed');
    expect(byId.get('10-25')?.status).toBe('evaluated_inconclusive');
    expect(byId.get('10-25')?.aoStatus).toBe('insufficient_info');
    // excluded-by-provenance rule appears as retrieved_not_evaluated
    expect(byId.get('10-42')?.status).toBe('retrieved_not_evaluated');
    expect(byId.get('10-42')?.aoStatus).toBe('excluded');
    expect(byId.get('10-42')?.verdictReason).toContain('排除');
  });

  it('interpretation/evidence are flagged as derived-from-reason in MVP', () => {
    const r = mapResultToResponse(args(baseResult()));
    const e = r.trace!.ruleEvaluations.find((x) => x.ruleId === '10-5')!;
    expect(e.interpretationSource).toBe('derived-from-reason');
    expect(e.evidence).toContain('必备技能');
  });

  it('retrievedRuleIds = full provenance set (incl excluded)', () => {
    const r = mapResultToResponse(args(baseResult()));
    expect(r.trace?.retrievedRuleIds.sort()).toEqual(['10-16', '10-25', '10-42', '10-5'].sort());
  });

  it('ruleTextSnapshot carries the version + a sha256 or null', () => {
    const r = mapResultToResponse(args(baseResult()));
    const e = r.trace!.ruleEvaluations.find((x) => x.ruleId === '10-5')!;
    expect(e.ruleTextSnapshot?.version).toBe('rules_v0_1_002');
    expect(e.ruleTextSnapshot?.field).toBe('standardizedLogicRule');
    const sha = e.ruleTextSnapshot?.sha256;
    expect(sha === null || /^[0-9a-f]{64}$/.test(sha!)).toBe(true);
  });
});

describe('mapResultToResponse — hardRequirements & meta', () => {
  it('hardRequirements includes both pass and fail verdicts', () => {
    const r = mapResultToResponse(args(baseResult()));
    const hr = r.result!.decisionDetail.hardRequirements;
    const verdicts = new Set(hr.map((h) => h.verdict));
    expect(verdicts.has('pass')).toBe(true);
    expect(verdicts.has('fail')).toBe(true);
    expect(hr.find((h) => h.byRuleId === '10-5')?.verdict).toBe('fail');
  });

  it('meta carries version/ruleCount/usage and shadow mode', () => {
    const r = mapResultToResponse(args(baseResult()));
    expect(r.meta?.ontologyLoaded.version).toBe('rules_v0_1_002');
    expect(r.meta?.ontologyLoaded.ruleCount).toBe(248);
    expect(r.meta?.usage.inputTokens).toBe(8211);
    expect(r.meta?.usage.outputTokens).toBe(902);
    expect(r.meta?.usage.usd).toBeNull();
    expect(r.meta?.mode).toBe('shadow');
    expect(r.meta?.inputsResolved.candidate.store).toBe('neo4j');
  });

  it('echoes correlation and the requested domain', () => {
    const r = mapResultToResponse(args(baseResult()));
    expect(r.correlation?.testCaseId).toBe('tc-de5ec703');
    expect(r.meta?.ontologyLoaded.domain).toBe('RAAS-v1');
  });
});
