import { describe, it, expect } from 'vitest';
import { buildRationalePrompt, generateIdentityRationale, type RationaleInput } from './identity-rationale';
import { applyIdentityRules } from './identity-engine';
import { loadCandidateMatchRules, identityRulesByPriority } from './rules-data';
import type { CandidateRecord } from './types';
import type { LlmRunResult } from '../llm';

const RULES = identityRulesByPriority(loadCandidateMatchRules());
const a: CandidateRecord = { candidate_id: 'A', name: '陈思', phone: '13800138000', email: 'c@s.com' };
const b: CandidateRecord = { candidate_id: 'B', name: 'x', phone: '13800138000', email: 'y@z.com' }; // 手机号命中

function inputFrom(res: Awaited<ReturnType<typeof applyIdentityRules>>): RationaleInput {
  return {
    result: res,
    candidateName: '陈思',
    matchedCandidateId: 'B',
    matchedCandidateName: '陈思',
    dedupAction: 'auto-merged',
    ontologyRuleId: '9-15',
    ontologyRuleName: '同一候选人判定规则',
  };
}

const fakeLlm = (reason: unknown) =>
  (async () => ({ parsed_json: { reason }, raw_text: '', model_used: 'm', duration_ms: 1 }) as LlmRunResult);

describe('buildRationalePrompt', () => {
  it('user prompt 含 9-15 / 候选人 / 命中级别 / 去重动作;system 要求中文 JSON', async () => {
    const res = await applyIdentityRules(a, b, RULES);
    const { system, user } = buildRationalePrompt(inputFrom(res));
    expect(system).toContain('JSON');
    expect(system).toContain('中文');
    expect(user).toContain('9-15');
    expect(user).toContain('陈思');
    expect(user).toContain('手机号');
    expect(user).toContain('auto-merged');
  });
});

describe('generateIdentityRationale', () => {
  it('解析 LLM 的 {reason} 文本 + 保留 prompt/raw', async () => {
    const input = inputFrom(await applyIdentityRules(a, b, RULES));
    const r = await generateIdentityRationale(input, fakeLlm('手机号一致,判定为同一人,自动关联老档'));
    expect(r.reason).toBe('手机号一致,判定为同一人,自动关联老档');
    expect(r.prompt).toContain('9-15'); // 用户提示词供 tab 展示
  });
  it('LLM 抛错 → reason=null(soft-fail,绝不阻断审计),但 prompt 仍在', async () => {
    const input = inputFrom(await applyIdentityRules(a, b, RULES));
    const boom = (async () => {
      throw new Error('llm down');
    }) as typeof generateIdentityRationale extends (i: RationaleInput, f: infer F) => unknown ? F : never;
    const r = await generateIdentityRationale(input, boom);
    expect(r.reason).toBeNull();
    expect(r.prompt).toContain('9-15');
  });
  it('无 reason 字段 → reason=null(回退机械文案)', async () => {
    const input = inputFrom(await applyIdentityRules(a, b, RULES));
    expect((await generateIdentityRationale(input, fakeLlm(undefined))).reason).toBeNull();
  });
});
