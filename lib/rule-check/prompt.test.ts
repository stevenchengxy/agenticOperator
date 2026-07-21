import { describe, expect, it } from 'vitest';
import { composeMatchResumePrompt, MATCH_RESUME_SYSTEM_PROMPT, renderRuleBlock } from './prompt';
import type { GraphContext } from './graph-context';
import type { MatchResumeStepGroup, RuleCheckInput } from './types';

const baseInput: RuleCheckInput = {
  runtime_context: {
    upload_id: 'u',
    candidate_id: 'C-1',
    resume_id: 'r',
    employee_id: 'EMP',
  },
  resume: { name: '张三' },
  job_requisition: { job_requisition_id: 'JR-1' },
  job_requisition_specification: null,
  hsm_feedback: null,
};

const baseCtx: GraphContext = {
  candidate: { candidate_id: 'C-1', name: '张三' },
  resume: { resume_id: 'R-1', candidate_id: 'C-1', skills: ['java'] },
  job_requisition: { job_requisition_id: 'JR-1' },
  applications: [],
  blacklist_hits: [],
  employment_links: [],
  fetch_count: 6,
  _cache: new Map(),
};

const baseSteps: MatchResumeStepGroup[] = [
  {
    step_id: '10::s1',
    order: 1,
    name: 'validateRedlineAndBlacklist',
    description: 'desc 1',
    condition: 'cond 1',
    rules: [
      {
        id: '10-25',
        specificScenarioStage: '',
        businessLogicRuleName: '华为荣耀竞对',
        applicableClient: '通用',
        applicableDepartment: 'N/A',
        submissionCriteria: 'sc',
        standardizedLogicRule: 'logic',
        relatedEntities: [],
        businessBackgroundReason: '',
        ruleSource: '',
        executor: 'Agent',
        enforcementLevel: 'optional',
        failurePolicy: 'warn',
        severity: 'terminal',
      },
    ],
  },
  {
    step_id: '10::s2',
    order: 2,
    name: 'matchHardRequirements',
    description: 'desc 2',
    condition: 'cond 2',
    rules: [
      {
        id: '10-5',
        specificScenarioStage: '',
        businessLogicRuleName: '硬性要求一票否决',
        applicableClient: '通用',
        applicableDepartment: 'N/A',
        submissionCriteria: 'N/A',
        standardizedLogicRule: 'logic',
        relatedEntities: [],
        businessBackgroundReason: '',
        ruleSource: '',
        executor: 'Agent',
        enforcementLevel: 'optional',
        failurePolicy: 'warn',
        severity: 'terminal',
      },
    ],
  },
];

describe('composeMatchResumePrompt', () => {
  it('renders Set headers in order with explicit Set N markers', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('### 4.1 Set 1 — validateRedlineAndBlacklist');
    expect(out).toContain('### 4.2 Set 2 — matchHardRequirements');
    expect(out.indexOf('Set 1')).toBeLessThan(out.indexOf('Set 2'));
  });

  it('renders rules in input order, not re-sorted by id', () => {
    const reorderedSteps: MatchResumeStepGroup[] = [
      {
        ...baseSteps[0],
        rules: [
          {
            ...baseSteps[0].rules[0],
            id: '10-99',
            businessLogicRuleName: 'second',
          },
          {
            ...baseSteps[0].rules[0],
            id: '10-2',
            businessLogicRuleName: 'first by id',
          },
        ],
      },
    ];
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: reorderedSteps,
    });
    expect(out.indexOf('Rule 10-99')).toBeLessThan(out.indexOf('Rule 10-2'));
  });

  it('contains the strict-order constraint block (independent per-rule eval, no short-circuit)', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('执行约束');
    expect(out).toContain('不得跳过 Set、不得乱序');
    // 2026-05-20 rewrite: rules are evaluated independently — the prompt must
    // tell the LLM NOT to short-circuit on an earlier fail.
    expect(out).toContain('不要因为前面有规则 fail 就把后续标 not_executed');
    expect(out).toContain('not_executed');
  });

  it('warns the LLM about exclusion/cooldown rule polarity (满足放行条件 → pass, not fail)', () => {
    // 陈思颖 bug:rule 10-42 是冷冻期"命中即阻断"规则。LLM 写 reason
    // "离职超6个月，满足"(= 放行条件满足)却打了 status=fail — 极性判反。
    // prompt 必须显式区分"命中阻断条件 → fail" vs "未命中(满足放行) → pass"。
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('排除类');
    expect(out).toContain('放行');
  });

  it('does NOT falsely claim department is unconditionally server-pre-filtered', () => {
    // 旧文案谎称"applicableDepartment 已在 server 端做过过滤,一定满足部门维度",
    // 导致 LLM 跳过部门判断。现在 server 做了 client+部门过滤,但 prompt 仍要
    // 指示 LLM 按 rule 文案校验场景,不能用"一定满足"这种绝对措辞。
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).not.toContain('一定满足客户/部门维度');
  });

  it('renders Set references dynamically — N=2 yields §4.1 → §4.2 not §4.1 → §4.4', () => {
    // baseSteps has 2 steps. With a fixed 4-Set reference, the LLM would be
    // pointed at §4.3 and §4.4 that do not exist. Verify dynamic refs.
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('§4.1 → §4.2');
    expect(out).not.toContain('§4.3');
    expect(out).not.toContain('§4.4');
  });

  it('renders the GraphContext section with named slots (JR slot dropped, renumbered to 5)', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('## 3. Graph context');
    expect(out).toContain('### 3.1 candidate');
    expect(out).toContain('### 3.2 resume');
    expect(out).toContain('### 3.3 applications');
    expect(out).toContain('### 3.4 blacklist_hits');
    expect(out).toContain('### 3.5 employment_links');
    // §3.3 job_requisition graph slot is gone — JR now lives only in §2.1
    // (the partner-pg blob), so the LLM never sees two conflicting JR copies.
    expect(out).not.toContain('### 3.6');
    expect(out).not.toContain('### 3.3 job_requisition');
  });

  it('§2 carries ONLY a slimmed job_requisition — no runtime_context / spec / hsm blocks', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('## 2. Inputs');
    expect(out).toContain('### 2.1 job_requisition');
    // dropped sections (runtime_context = pure plumbing; spec/hsm = always null)
    expect(out).not.toContain('runtime_context');
    expect(out).not.toContain('2.3 job_requisition_specification');
    expect(out).not.toContain('2.4 hsm_feedback');
  });

  it('§2.1 JR keeps whitelisted requirement fields and drops operational noise', () => {
    const out = composeMatchResumePrompt({
      input: {
        ...baseInput,
        job_requisition: {
          job_requisition_id: 'JR-1',
          // whitelisted (rule-relevant) — must survive
          degree_requirement: '本科',
          salary_range: '20k-30k',
          must_have_skills: ['java', 'spring'],
          age_range: '25-35',
          // denylisted (operational noise) — must be stripped
          first_interviewer_name: 'SECRET_INTERVIEWER',
          evaluation_rules: 'SECRET_RULES',
          competitor_application_count: 42,
          created_at: '2026-01-01T00:00:00Z',
          interview_process: 'SECRET_PROCESS',
        },
      },
      graph: baseCtx,
      steps: baseSteps,
    });
    // kept
    expect(out).toContain('本科');
    expect(out).toContain('20k-30k');
    expect(out).toContain('java');
    expect(out).toContain('25-35');
    // stripped
    expect(out).not.toContain('SECRET_INTERVIEWER');
    expect(out).not.toContain('SECRET_RULES');
    expect(out).not.toContain('SECRET_PROCESS');
    expect(out).not.toContain('competitor_application_count');
  });

  it('emits null/[] for missing graph slots', () => {
    const empty: GraphContext = {
      ...baseCtx,
      candidate: null,
      resume: null,
      applications: [],
    };
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: empty,
      steps: baseSteps,
    });
    expect(out).toMatch(/### 3\.1 candidate[\s\S]+?null/);
    expect(out).toMatch(/### 3\.2 resume[\s\S]+?null/);
  });

  it('includes a compact output schema (only rule_results; runner recomputes stats/decision)', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('"rule_results"');
    expect(out).toContain('insufficient_info');
    expect(out).toContain('not_triggered');
    expect(out).toContain('not_executed');
    // rule_name/step_id/stats/decision/explanations are recomputed by the
    // runner from rule_results — the LLM must NOT emit them (token budget).
    expect(out).not.toContain('"explanations"');
    expect(out).not.toContain('"rule_name"');
    expect(out).not.toContain('"step_id"');
    // The schema block forbids these — they should be listed as fields the LLM
    // must skip, not as schema keys.
    expect(out).not.toMatch(/"stats":\s*\{/);
    expect(out).not.toMatch(/"decision":\s*"PASS"/);
  });

  it('instructs the LLM to emit one rule_results entry per rule, in Set order', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    // Verbatim instruction text — verify both halves are present.
    expect(out).toContain('每条规则都必须有一条对应的');
    expect(out).toContain('rule_results');
    expect(out).toContain('按 Set 顺序、Set 内列出顺序输出');
  });

  it('requires next_action in the output schema with the enum + status mapping', () => {
    const out = composeMatchResumePrompt({ input: baseInput, graph: baseCtx, steps: baseSteps });
    expect(out).toContain('next_action');
    expect(out).toContain('continue');
    expect(out).toContain('block');
    expect(out).toContain('supplement');
  });

  it('instructs a DETAILED reason for fail (触发判定→字段取值→逻辑→结论)', () => {
    const out = composeMatchResumePrompt({ input: baseInput, graph: baseCtx, steps: baseSteps });
    expect(out).toContain('详细');
  });

  it('decision-fold block no longer routes pending to REVIEW (pending folds to PASS)', () => {
    const out = composeMatchResumePrompt({ input: baseInput, graph: baseCtx, steps: baseSteps });
    expect(out).not.toContain('decision="REVIEW"');
  });

  it('renders enforcement + failure policy in rule block header', () => {
    const rule = {
      id: '10-5',
      businessLogicRuleName: 'degree-check',
      applicableClient: '通用',
      applicableDepartment: 'N/A',
      submissionCriteria: '',
      standardizedLogicRule: 'check degree',
      relatedEntities: [],
      businessBackgroundReason: '',
      ruleSource: '',
      executor: 'Agent',
      enforcementLevel: 'mandatory',
      failurePolicy: 'block',
      severity: 'terminal',
    } as const;
    const out = renderRuleBlock(rule as any);
    expect(out).toContain('enforcement=mandatory');
    expect(out).toContain('onFail=block');
    expect(out).not.toContain('severity=');
  });
});

describe('MATCH_RESUME_SYSTEM_PROMPT', () => {
  it('is a non-empty string with role guidance', () => {
    expect(typeof MATCH_RESUME_SYSTEM_PROMPT).toBe('string');
    expect(MATCH_RESUME_SYSTEM_PROMPT.length).toBeGreaterThan(50);
    expect(MATCH_RESUME_SYSTEM_PROMPT).toContain('matchResume');
  });
});
