import { afterEach, describe, expect, it, vi } from 'vitest';

// 注意:runner.ts 调 llm.ts 的 runLlm()。我们 mock 它,断言 verdict 行为
// 而不真的发 LLM 请求。

vi.mock('./llm', () => ({
  runLlm: vi.fn(),
}));

import { runLlm } from './llm';
import { buildRuleCheckInput, runRuleCheck } from './runner';
import type { LlmRuleCheckOutput, RuleCheckInput } from './types';

const mockRunLlm = vi.mocked(runLlm);

function fakeInput(overrides?: Partial<RuleCheckInput>): RuleCheckInput {
  return {
    runtime_context: {
      upload_id: 'upl_test',
      candidate_id: 'c_test',
      resume_id: 'r_test',
      employee_id: 'EMP_001',
    },
    resume: {
      name: '张三',
      birth_date: '1990-05-12',
      experience: [{ company: '华为', startDate: '2024-01', endDate: '2025-11' }],
      gender: '男',
    },
    job_requisition: {
      job_requisition_id: 'JR_123',
      client_id: 'CLI_TENCENT_PCG',
      job_responsibility: '负责前端',
    },
    job_requisition_specification: null,
    hsm_feedback: null,
    ...overrides,
  };
}

function fakeLlmReply(parsed: LlmRuleCheckOutput): Awaited<ReturnType<typeof runLlm>> {
  return {
    model_used: 'mock-gemini',
    duration_ms: 100,
    raw_text: JSON.stringify(parsed),
    parsed_json: parsed,
  };
}

afterEach(() => {
  mockRunLlm.mockReset();
  delete process.env.RULE_CHECK_PROMPT_SOURCE;
  delete process.env.RULE_CHECK_PARTIAL_RESUME;
});

describe('buildRuleCheckInput', () => {
  it('normalizes job_requisition_id (forces string)', () => {
    const out = buildRuleCheckInput({
      runtime_context: { upload_id: '', candidate_id: '', resume_id: '', employee_id: '' },
      parsed_resume: { name: 'x' },
      job_requisition: { job_requisition_id: 'JR_X' },
    });
    expect(out.job_requisition.job_requisition_id).toBe('JR_X');
  });

  it('falls back to "" when job_requisition_id missing', () => {
    const out = buildRuleCheckInput({
      runtime_context: { upload_id: '', candidate_id: '', resume_id: '', employee_id: '' },
      parsed_resume: null,
      job_requisition: { client_id: 'X' },
    });
    expect(out.job_requisition.job_requisition_id).toBe('');
  });

  it('keeps null parsed_resume as {} (not null) so prompt renders cleanly', () => {
    const out = buildRuleCheckInput({
      runtime_context: { upload_id: '', candidate_id: '', resume_id: '', employee_id: '' },
      parsed_resume: null,
      job_requisition: { job_requisition_id: 'JR_X' },
    });
    expect(out.resume).toEqual({});
  });
});

describe('runRuleCheck — KEEP path', () => {
  it('PASS verdict with augmentation透传', async () => {
    mockRunLlm.mockResolvedValueOnce(
      fakeLlmReply({
        overall_decision: 'KEEP',
        rule_flags: [
          {
            rule_id: '10-25',
            rule_name: '华为冷冻',
            applicable_client: '通用',
            severity: 'terminal',
            applicable: true,
            result: 'PASS',
            evidence: '简历 experience[0]: 华为, 离职 2025-11, 距今 ≥ 3 个月',
          },
        ],
        resume_augmentation:
          '## Rule Check Annotations\n- [10-25 ✓] 华为冷冻期已过(距今 5 个月)',
      }),
    );

    const verdict = await runRuleCheck(fakeInput());

    expect(verdict.decision).toBe('PASS');
    expect(verdict.llm_decision).toBe('KEEP');
    expect(verdict.failure_reasons).toEqual([]);
    expect(verdict.resume_augmentation).toContain('Rule Check Annotations');
    expect(verdict.resume_augmentation).toContain('10-25 ✓');
  });

  it('KEEP with empty resume_augmentation → verdict.resume_augmentation = undefined', async () => {
    mockRunLlm.mockResolvedValueOnce(
      fakeLlmReply({
        overall_decision: 'KEEP',
        rule_flags: [],
        resume_augmentation: '   ',
      }),
    );
    const verdict = await runRuleCheck(fakeInput());
    expect(verdict.decision).toBe('PASS');
    expect(verdict.resume_augmentation).toBeUndefined();
  });
});

describe('runRuleCheck — DROP / PAUSE / parse-fail paths', () => {
  it('DROP → FAIL with drop_reasons', async () => {
    mockRunLlm.mockResolvedValueOnce(
      fakeLlmReply({
        overall_decision: 'DROP',
        drop_reasons: ['10-21:age_overflow'],
        rule_flags: [],
      }),
    );
    const verdict = await runRuleCheck(fakeInput());
    expect(verdict.decision).toBe('FAIL');
    expect(verdict.llm_decision).toBe('DROP');
    expect(verdict.failure_reasons).toContain('10-21:age_overflow');
  });

  it('PAUSE → FAIL with pause_reasons', async () => {
    mockRunLlm.mockResolvedValueOnce(
      fakeLlmReply({
        overall_decision: 'PAUSE',
        pause_reasons: ['10-12:age_logic_anomaly'],
        rule_flags: [],
      }),
    );
    const verdict = await runRuleCheck(fakeInput());
    expect(verdict.decision).toBe('FAIL');
    expect(verdict.llm_decision).toBe('PAUSE');
    expect(verdict.failure_reasons).toContain('10-12:age_logic_anomaly');
  });

  it('LLM throw → FAIL-safe with llm-call-error reason', async () => {
    mockRunLlm.mockRejectedValueOnce(new Error('network reset'));
    const verdict = await runRuleCheck(fakeInput());
    expect(verdict.decision).toBe('FAIL');
    expect(verdict.llm_decision).toBe('UNKNOWN');
    expect(verdict.failure_reasons[0]).toContain('llm-call-error');
    expect(verdict.audit.parse_error).toContain('network reset');
  });

  it('LLM returns garbage JSON → FAIL with parse-error reason', async () => {
    mockRunLlm.mockResolvedValueOnce({
      model_used: 'mock',
      duration_ms: 50,
      raw_text: 'not json',
      parsed_json: null,
      parse_error: 'Unexpected token',
    });
    const verdict = await runRuleCheck(fakeInput());
    expect(verdict.decision).toBe('FAIL');
    expect(verdict.failure_reasons[0]).toContain('parse-error');
  });
});

describe('runRuleCheck — partial resume projection', () => {
  it('default: only relevant fields make it to the LLM prompt', async () => {
    // 跑一次 KEEP 路径,然后看 mockRunLlm 被调用时的 user prompt 字符串
    mockRunLlm.mockResolvedValueOnce(
      fakeLlmReply({ overall_decision: 'KEEP', rule_flags: [] }),
    );

    const input = fakeInput({
      resume: {
        name: '张三',
        email: 'zhang@example.com',
        phone: '13800000000',
        rawText: 'a 5000-char resume blob ...'.padEnd(5000, 'X'),
        experience: [{ company: '华为' }],
        skills: ['React'],
        birth_date: '1990-01-01',
      },
    });
    await runRuleCheck(input);

    expect(mockRunLlm).toHaveBeenCalledTimes(1);
    const call = mockRunLlm.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    const userPrompt = call!.user;
    // 应该出现:name + experience(几乎所有规则都需要)
    expect(userPrompt).toContain('张三');
    // 不应该出现 5000-char rawText:partial 把它过滤掉了
    expect(userPrompt).not.toContain('XXXXXXXXXX');
  });

  it('RULE_CHECK_PARTIAL_RESUME=false → 整段 resume 都在 prompt 里', async () => {
    process.env.RULE_CHECK_PARTIAL_RESUME = 'false';
    mockRunLlm.mockResolvedValueOnce(
      fakeLlmReply({ overall_decision: 'KEEP', rule_flags: [] }),
    );
    const input = fakeInput({
      resume: { name: '李四', rawText: 'DIAGNOSTIC_FULL_RESUME_MARKER' },
    });
    await runRuleCheck(input);
    const userPrompt = mockRunLlm.mock.calls[0]?.[0]?.user ?? '';
    expect(userPrompt).toContain('DIAGNOSTIC_FULL_RESUME_MARKER');
  });
});
