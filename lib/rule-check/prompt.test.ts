import { describe, expect, it } from 'vitest';
import { composeMatchResumePrompt, MATCH_RESUME_SYSTEM_PROMPT } from './prompt';
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

  it('contains the strict-order + short-circuit constraint block', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('执行约束');
    expect(out).toContain('不得跳过 Set、不得乱序');
    expect(out).toContain('立即停止后续所有 rule 的评估');
    expect(out).toContain('not_executed');
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

  it('renders the GraphContext section with named slots', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('## 3. Graph context');
    expect(out).toContain('### 3.1 candidate');
    expect(out).toContain('### 3.2 resume');
    expect(out).toContain('### 3.3 job_requisition');
    expect(out).toContain('### 3.4 applications');
    expect(out).toContain('### 3.5 blacklist_hits');
    expect(out).toContain('### 3.6 employment_links');
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

  it('includes the new output schema with stats + rule_results fields', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('"stats"');
    expect(out).toContain('"rule_results"');
    expect(out).toContain('insufficient_info');
    expect(out).toContain('not_triggered');
    expect(out).toContain('not_executed');
    // The LLM no longer emits explanations directly — it's derived in the runner.
    expect(out).not.toContain('"explanations"');
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
});

describe('MATCH_RESUME_SYSTEM_PROMPT', () => {
  it('is a non-empty string with role guidance', () => {
    expect(typeof MATCH_RESUME_SYSTEM_PROMPT).toBe('string');
    expect(MATCH_RESUME_SYSTEM_PROMPT.length).toBeGreaterThan(50);
    expect(MATCH_RESUME_SYSTEM_PROMPT).toContain('matchResume');
  });
});
