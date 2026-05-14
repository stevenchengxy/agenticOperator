import { describe, expect, it } from 'vitest';
import {
  RULE_REQUIRED_FIELDS,
  assertAllRulesMapped,
  fieldsProjected,
  projectResume,
} from './resume-projection';
import { loadAllRules } from './ontology';
import type { Rule } from './types';

// Helper: 构造一个 Rule 节点(只用到 id 字段,其余字段 placeholder)。
function fakeRule(id: string, overrides: Partial<Rule> = {}): Rule {
  return {
    id,
    specificScenarioStage: '',
    businessLogicRuleName: '',
    applicableClient: '通用',
    applicableDepartment: 'N/A',
    submissionCriteria: '',
    standardizedLogicRule: '',
    relatedEntities: [],
    businessBackgroundReason: '',
    ruleSource: '',
    executor: 'Agent',
    severity: 'flag_only',
    ...overrides,
  };
}

const SAMPLE_RESUME = {
  name: '张三',
  email: 'zhang@example.com',
  phone: '13800000000',
  birth_date: '1990-05-12',
  gender: '男',
  marital_status: '已婚已育',
  expected_salary_range: '30000-50000',
  experience: [{ company: '华为', startDate: '2024-01', endDate: '2025-11' }],
  education: [{ degree: '本科', field: 'CS' }],
  skills: ['React', 'TypeScript'],
  languages: [],
  conflict_of_interest: null,
  former_csi_employment: null,
  former_tencent_employment: null,
  gap_periods: [],
  rawText: '...full resume markdown...',
};

describe('projectResume', () => {
  it('returns {} when parsedResume is null/undefined', () => {
    expect(projectResume(null, [])).toEqual({});
    expect(projectResume(undefined, [])).toEqual({});
  });

  it('keeps name as anchor even with no applicable rules', () => {
    const out = projectResume(SAMPLE_RESUME, []);
    expect(out).toEqual({ name: '张三' });
  });

  it('projects only experience for 10-25 (Huawei cooldown)', () => {
    const out = projectResume(SAMPLE_RESUME, [fakeRule('10-25')]);
    expect(Object.keys(out).sort()).toEqual(['experience', 'name']);
    expect(out.experience).toEqual(SAMPLE_RESUME.experience);
    // 关键字段不该被发出
    expect(out).not.toHaveProperty('rawText');
    expect(out).not.toHaveProperty('skills');
    expect(out).not.toHaveProperty('birth_date');
  });

  it('unions fields across multiple applicable rules', () => {
    // 10-21 需要 birth_date,10-25 需要 experience,10-47 需要 gender/birth_date/marital_status
    const out = projectResume(SAMPLE_RESUME, [
      fakeRule('10-21'),
      fakeRule('10-25'),
      fakeRule('10-47'),
    ]);
    expect(Object.keys(out).sort()).toEqual(
      ['birth_date', 'experience', 'gender', 'marital_status', 'name'].sort(),
    );
  });

  it('skips fields not present on the input resume', () => {
    // 10-5 需要 education/skills/languages/gender/birth_date,但 input
    // 只有 name 和 experience(后者 10-5 不要)→ 输出只剩 name anchor
    const out = projectResume(
      { name: '李四', experience: [] },
      [fakeRule('10-5')],
    );
    expect(Object.keys(out).sort()).toEqual(['name']);
  });

  it('rule without map entry contributes no fields (defensive, no throw)', () => {
    const out = projectResume(SAMPLE_RESUME, [fakeRule('99-fake-not-in-map')]);
    // 只剩 name anchor
    expect(out).toEqual({ name: '张三' });
  });

  it('drops PII-heavy fields like email/phone unless a rule requires them', () => {
    // 当前 51 条规则都不需要 email/phone — partial 投影把它们过滤掉
    const out = projectResume(SAMPLE_RESUME, [fakeRule('10-25')]);
    expect(out).not.toHaveProperty('email');
    expect(out).not.toHaveProperty('phone');
  });
});

describe('fieldsProjected', () => {
  it('always includes name', () => {
    expect(fieldsProjected([])).toEqual(['name']);
  });

  it('returns deduped union of required fields + name', () => {
    const out = fieldsProjected([fakeRule('10-21'), fakeRule('10-47')]);
    // 10-21: birth_date / 10-47: gender, birth_date, marital_status
    expect(out.sort()).toEqual(
      ['birth_date', 'gender', 'marital_status', 'name'].sort(),
    );
  });
});

describe('assertAllRulesMapped — LINT for missing rule entries', () => {
  it('passes when all ontology rule_ids are mapped', () => {
    const allRuleIds = loadAllRules().map((r) => r.id);
    const result = assertAllRulesMapped(allRuleIds);
    if (!result.ok) {
      // 详细列出来,加新规则忘了更新 map 时立刻能定位
      throw new Error(
        `RULE_REQUIRED_FIELDS map missing entries for: ${result.missing.join(', ')}\n` +
          `→ 加新 ontology rule 后必须在 lib/rule-check/resume-projection.ts 增加字段映射`,
      );
    }
    expect(result.ok).toBe(true);
  });

  it('reports missing ids when passed unknown ones', () => {
    const result = assertAllRulesMapped(['10-5', '10-99-fake', '10-100-fake']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(['10-99-fake', '10-100-fake']);
    }
  });
});

describe('RULE_REQUIRED_FIELDS data contract', () => {
  it('every entry is a frozen-ish readonly array', () => {
    for (const [, fields] of Object.entries(RULE_REQUIRED_FIELDS)) {
      expect(Array.isArray(fields)).toBe(true);
    }
  });

  it('Kenny §2 high-frequency rules all have non-empty mapping', () => {
    // 这些是 plan §3.3 列出的"高频/红线"规则,投影后必须有字段
    const highFreq = [
      '10-5', // 硬性要求一票否决
      '10-7', // 期望薪资
      '10-25', // 华为冷冻
      '10-38', // 腾讯历史从业
      '10-47', // 腾讯婚育
      '10-43', // IEG 工作室互斥
      '10-27', // 腾讯亲属回避
      '10-17', // CSI 高风险离场
    ];
    for (const id of highFreq) {
      expect(RULE_REQUIRED_FIELDS[id]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
