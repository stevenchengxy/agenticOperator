import { describe, it, expect } from 'vitest';
import { isInfraFailure, friendlyInfraReason } from './infra-failure';

// A rule-check `decision: 'FAIL'` can mean two very different things:
//   (a) infrastructure failure — the evaluation could not complete (LLM gateway
//       down/401, graph unavailable, tool loop exhausted, unparseable LLM output).
//       failSafe() sets audit.fail_reason to one of these. This is NOT a candidate
//       rejection; it must retry/park + alert, never write 未通过 to partner.
//   (b) a real rule violation — the LLM returned valid JSON judging the candidate
//       as failing. The normal path leaves audit.fail_reason undefined.
//
// isInfraFailure(fail_reason) distinguishes (a) from (b).

describe('isInfraFailure', () => {
  it('treats every failSafe infra reason as infra', () => {
    expect(isInfraFailure('llm-call-error')).toBe(true);
    expect(isInfraFailure('ontology-graph-unavailable')).toBe(true);
    expect(isInfraFailure('tool-use-loop-exceeded')).toBe(true);
    expect(isInfraFailure('parse-error')).toBe(true);
    expect(isInfraFailure('gateway-unavailable')).toBe(true);
  });

  it('treats a real rule violation (no fail_reason) as NOT infra', () => {
    expect(isInfraFailure(undefined)).toBe(false);
  });

  it('treats an unknown reason string as NOT infra (conservative — falls through to existing FAIL path)', () => {
    expect(isInfraFailure('candidate-disqualified')).toBe(false);
    expect(isInfraFailure('')).toBe(false);
  });
});

describe('friendlyInfraReason', () => {
  it('maps an out-of-funds LLM gateway failure to a 充值额度 message', () => {
    const msg = friendlyInfraReason('llm-call-error', 'quota');
    expect(msg).toContain('充值额度');
    expect(msg).toContain('候选人未被拒绝');
  });

  it('distinguishes auth / rate-limit / generic LLM degrade', () => {
    expect(friendlyInfraReason('llm-call-error', 'auth')).toContain('密钥');
    expect(friendlyInfraReason('gateway-unavailable', 'rate_limit')).toContain('限流');
    expect(friendlyInfraReason('llm-call-error', 'server')).toContain('暂时不可用');
    // unknown dep reason → generic LLM-unavailable copy
    expect(friendlyInfraReason('llm-call-error')).toContain('暂时不可用');
  });

  it('covers non-LLM infra reasons + every variant reassures candidate not rejected', () => {
    for (const r of [
      'ontology-graph-unavailable',
      'parse-error',
      'tool-use-loop-exceeded',
      'something-else',
    ]) {
      expect(friendlyInfraReason(r)).toContain('候选人未被拒绝');
    }
    expect(friendlyInfraReason('ontology-graph-unavailable')).toContain('规则库');
  });
});
