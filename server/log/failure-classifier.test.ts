import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  classifyLogFailure,
  enrichPayloadJsonWithFailure,
} from './failure-classifier';

describe('classifyFailure', () => {
  it('classifies rule-check LLM parse errors as LLM parse failures', () => {
    const failure = classifyFailure({
      type: 'agent_error',
      message: 'engine infra failure: parse-error',
      payload: { fail_reason: 'parse-error', llm_finish_reason: 'stop' },
    });
    expect(failure).toMatchObject({
      component: 'llm',
      reason: 'parse_error',
      retryable: true,
    });
    expect(failure?.summary).toContain('LLM');
  });

  it('classifies upstream API 429 as retryable rate limit', () => {
    const failure = classifyFailure({
      level: 'error',
      category: 'api',
      source: 'robohire',
      eventName: 'RoboHire.matchResume',
      message: 'RoboHire.matchResume -> 429',
      payload: { status: 429, error: 'Too Many Requests' },
      status: 429,
    });
    expect(failure).toMatchObject({
      component: 'robohire',
      reason: 'rate_limit',
      retryable: true,
      status: 429,
    });
  });

  it('does not mistake allmeta for llm just because the name contains those letters', () => {
    const failure = classifyFailure({
      level: 'error',
      category: 'api',
      source: 'allmeta',
      eventName: 'allmeta.POST /api/v1/ontology/instances',
      message: 'allmeta.POST /api/v1/ontology/instances -> ERROR fetch failed',
      payload: { error: 'fetch failed' },
    });
    expect(failure).toMatchObject({
      component: 'allmeta',
      reason: 'network',
      retryable: true,
    });
  });

  it('keeps partner execution validation errors non-retryable', () => {
    const failure = classifyFailure({
      type: 'agent_error',
      source: 'agent-execution',
      message: '执行失败 INPUT_INVALID: inputs.candidate.ref.id is required',
      payload: {
        error: {
          code: 'INPUT_INVALID',
          message: 'inputs.candidate.ref.id is required',
          retryable: false,
        },
      },
    });
    expect(failure).toMatchObject({
      component: 'input',
      reason: 'validation',
      retryable: false,
      code: 'INPUT_INVALID',
    });
  });

  it('prioritizes INPUT_REF_NOT_FOUND over Neo4j wording', () => {
    const failure = classifyFailure({
      type: 'agent_error',
      source: 'agent-execution',
      message: "执行失败 INPUT_REF_NOT_FOUND: candidate 'demo-r2' not found in Neo4j (no fallback)",
      payload: {
        error: {
          code: 'INPUT_REF_NOT_FOUND',
          message: "candidate 'demo-r2' not found in Neo4j (no fallback)",
          retryable: false,
        },
      },
    });
    expect(failure).toMatchObject({
      component: 'input',
      reason: 'not_found',
      retryable: false,
      code: 'INPUT_REF_NOT_FOUND',
    });
  });
});

describe('failure payload persistence', () => {
  it('embeds and reads back a structured failure object', () => {
    const failure = classifyFailure({
      type: 'dependency_degraded',
      source: 'LLM 网关',
      message: 'LLM 网关 ruleCheck 退化:quota',
      payload: { provider: 'llm', op: 'ruleCheck', reason: 'quota', detail: 'balance exhausted' },
    });
    expect(failure).not.toBeNull();
    const payloadJson = enrichPayloadJsonWithFailure('{"provider":"llm"}', failure!);
    const readBack = classifyLogFailure({
      level: 'warn',
      category: 'dependency',
      source: 'LLM 网关',
      message: 'x',
      payloadJson,
    });
    expect(readBack).toEqual(failure);
  });
});
