import { describe, expect, it } from 'vitest';
import { buildInferenceChain } from './index';
import type { GraphContext } from '../graph-context';
import type { Rule, RuleResult, RuleCheckRuntimeContext } from '../types';

const RUNTIME: RuleCheckRuntimeContext = {
  upload_id: 'u', candidate_id: 'C-1', resume_id: 'r', employee_id: 'E',
  received_at: '2026-05-13T10:00:00Z',
};

const BASE_GRAPH: GraphContext = {
  candidate: null, resume: null, job_requisition: null,
  applications: [], blacklist_hits: [], employment_links: [],
  fetch_count: 0, _cache: new Map(),
};

function rule(id: string, overrides: Partial<Rule> = {}): Rule {
  return {
    id, specificScenarioStage: '', businessLogicRuleName: `r-${id}`,
    applicableClient: '通用', applicableDepartment: 'N/A',
    submissionCriteria: '', standardizedLogicRule: `LOGIC-${id}`,
    relatedEntities: [], businessBackgroundReason: '', ruleSource: '',
    executor: 'Agent', severity: 'flag_only', ...overrides,
  };
}

function result(id: string, status: RuleResult['status'], reason?: string): RuleResult {
  return { rule_id: id, rule_name: `r-${id}`, step_id: 's1', status, reason };
}

describe('buildInferenceChain — fallback', () => {
  it('returns fallback chain (rule_logic + verdict) for unregistered rule', () => {
    const chain = buildInferenceChain(BASE_GRAPH, RUNTIME, rule('99-9'), result('99-9', 'pending', 'why'));
    expect(chain.rule_id).toBe('99-9');
    expect(chain.highlight_nodes).toEqual([]);
    expect(chain.steps).toEqual([
      { kind: 'rule_logic', markdown: 'LOGIC-99-9' },
      { kind: 'verdict', status: 'pending', reason: 'why' },
    ]);
  });

  it('fallback uses empty reason when undefined', () => {
    const chain = buildInferenceChain(BASE_GRAPH, RUNTIME, rule('99-9'), result('99-9', 'pass'));
    expect(chain.steps[1]).toEqual({ kind: 'verdict', status: 'pass', reason: '' });
  });
});

describe('extract10_5 (学历)', () => {
  it('emits candidate + jd nodes and a comparison computation', () => {
    const graph: GraphContext = {
      ...BASE_GRAPH,
      candidate: { highest_acquired_degree: '本科' },
      job_requisition: { degree_requirement: '硕士' },
    };
    const chain = buildInferenceChain(graph, RUNTIME, rule('10-5'), result('10-5', 'fail', 'low'));
    const kinds = chain.steps.map((s) => s.kind);
    expect(kinds).toContain('graph_node');
    expect(kinds).toContain('computation');
    expect(chain.highlight_nodes).toEqual(expect.arrayContaining(['candidate', 'jd']));
  });
});

describe('extract10_9 / 10-10 (空窗期)', () => {
  it('10-9 fires on gaps > 3 months', () => {
    const graph: GraphContext = {
      ...BASE_GRAPH,
      resume: { work_experience: [
        { company: 'A', start_date: '2020-01', end_date: '2020-12' },
        { company: 'B', start_date: '2024-07', end_date: '2026-04' },
      ]},
    };
    const chain = buildInferenceChain(graph, RUNTIME, rule('10-9'), result('10-9', 'insufficient_info', 'gap'));
    expect(chain.steps.find((s) => s.kind === 'graph_node')).toBeDefined();
    expect(chain.steps.find((s) => s.kind === 'computation' && s.label === '空窗期')).toBeDefined();
  });
  it('10-10 only fires on gaps > 12 months (1-month gap → no graph_node)', () => {
    const graph: GraphContext = {
      ...BASE_GRAPH,
      resume: { work_experience: [
        { company: 'A', start_date: '2020-01', end_date: '2020-12' },
        { company: 'B', start_date: '2021-02', end_date: '2024-01' },
      ]},
    };
    const chain = buildInferenceChain(graph, RUNTIME, rule('10-10'), result('10-10', 'pass'));
    expect(chain.steps.find((s) => s.kind === 'graph_node')).toBeUndefined();
  });
});

describe('extract10_17 (黑名单)', () => {
  it('points to Blacklist node when present', () => {
    const graph: GraphContext = {
      ...BASE_GRAPH,
      blacklist_hits: [{ blacklist_id: 'BL-1', lock_reason: 'A15 劳动纠纷' }],
    };
    const chain = buildInferenceChain(graph, RUNTIME, rule('10-17'), result('10-17', 'fail', 'hit'));
    expect(chain.highlight_nodes).toContain('blacklist');
    expect(chain.steps.find((s) => s.kind === 'graph_node' && s.node === 'blacklist')).toBeDefined();
  });
});

describe('extract10_21 (年龄)', () => {
  it('emits birth_date + age_range + computed age', () => {
    const graph: GraphContext = {
      ...BASE_GRAPH,
      candidate: { birth_date: '1980-01-01' },
      job_requisition: { age_range: '20-40岁' },
    };
    const chain = buildInferenceChain(graph, RUNTIME, rule('10-21'), result('10-21', 'fail', 'too old'));
    expect(chain.steps.find((s) => s.kind === 'computation' && s.label === 'Age (today)')).toBeDefined();
  });
});

describe('extract10_25 (华为冷冻期)', () => {
  it('emits work_experience node + months computation', () => {
    const graph: GraphContext = {
      ...BASE_GRAPH,
      resume: { work_experience: [{ company: '华为', title: 'eng', start_date: '2024-01', end_date: '2026-04' }] },
    };
    const chain = buildInferenceChain(graph, RUNTIME, rule('10-25'), result('10-25', 'pending', '<3mo'));
    expect(chain.highlight_nodes).toContain('resume');
    expect(chain.steps.filter((s) => s.kind === 'computation').length).toBeGreaterThanOrEqual(1);
  });
  it('no graph_node when no 华为 history', () => {
    const graph: GraphContext = {
      ...BASE_GRAPH,
      resume: { work_experience: [{ company: '字节', title: 'eng', start_date: '2020-01', end_date: '2024-12' }] },
    };
    const chain = buildInferenceChain(graph, RUNTIME, rule('10-25'), result('10-25', 'not_triggered'));
    expect(chain.steps.find((s) => s.kind === 'graph_node')).toBeUndefined();
  });
});

describe('extract10_26 (OPPO/小米)', () => {
  it('matches OPPO work experience', () => {
    const graph: GraphContext = {
      ...BASE_GRAPH,
      resume: { work_experience: [{ company: 'OPPO', start_date: '2024-01', end_date: '2024-12' }] },
    };
    const chain = buildInferenceChain(graph, RUNTIME, rule('10-26'), result('10-26', 'pass'));
    expect(chain.steps.find((s) => s.kind === 'graph_node')).toBeDefined();
  });
});

describe('extract10_27 (亲属回避)', () => {
  it('emits candidate node when declaration is non-empty', () => {
    const graph: GraphContext = {
      ...BASE_GRAPH,
      candidate: { conflict_interest_declaration: '配偶在 XX' },
    };
    const chain = buildInferenceChain(graph, RUNTIME, rule('10-27'), result('10-27', 'pending', 'verify'));
    expect(chain.highlight_nodes).toContain('candidate');
  });
  it('omits graph_node when declaration is "无"', () => {
    const graph: GraphContext = {
      ...BASE_GRAPH,
      candidate: { conflict_interest_declaration: '无' },
    };
    const chain = buildInferenceChain(graph, RUNTIME, rule('10-27'), result('10-27', 'not_triggered'));
    expect(chain.steps.find((s) => s.kind === 'graph_node')).toBeUndefined();
  });
});

describe('extract10_32 (岗位冷冻期)', () => {
  it('points to matching application by job_requisition_id', () => {
    const graph: GraphContext = {
      ...BASE_GRAPH,
      job_requisition: { job_requisition_id: 'JR-1' },
      applications: [{ application_id: 'A-1', job_requisition_id: 'JR-1', push_timestamp: '2026-03-01T00:00:00Z', status: '筛选淘汰' }],
    };
    const chain = buildInferenceChain(graph, RUNTIME, rule('10-32'), result('10-32', 'pending', '<3mo'));
    expect(chain.highlight_nodes).toContain('application');
    expect(chain.steps.find((s) => s.kind === 'computation' && s.label === '距上次推送')).toBeDefined();
  });
});
