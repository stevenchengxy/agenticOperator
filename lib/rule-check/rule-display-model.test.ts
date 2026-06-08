import { describe, it, expect } from 'vitest';
import { filterVerdict, buildRuleDisplayModel } from './rule-display-model';

describe('filterVerdict 四象限', () => {
  it('纳入+应纳入 → correct_included', () => expect(filterVerdict(true, true)).toBe('correct_included'));
  it('纳入+存疑 → suspect_over', () => expect(filterVerdict(true, false)).toBe('suspect_over'));
  it('排除+不该纳入 → correct_excluded', () => expect(filterVerdict(false, false)).toBe('correct_excluded'));
  it('排除+应纳入 → suspect_missed(10-42 信号)', () => expect(filterVerdict(false, true)).toBe('suspect_missed'));
  it('没有 AI 意见 → unknown', () => {
    expect(filterVerdict(true, null)).toBe('unknown');
    expect(filterVerdict(false, null)).toBe('unknown');
  });
});

describe('buildRuleDisplayModel', () => {
  const provenance = [
    { rule_id: '10-25', tier: 'general' as const, included: true, reason: 'r1', rule_name: '通用A' },
    { rule_id: '10-42', tier: 'department' as const, included: false, reason: 'fail-closed', rule_name: 'CDG拦截' },
  ];
  it('按 included 分两组并计数', () => {
    const m = buildRuleDisplayModel({ provenance, opinions: [] });
    expect(m.counts).toEqual({ total: 2, selected: 1, excluded: 1 });
    expect(m.selected.map((r) => r.rule_id)).toEqual(['10-25']);
    expect(m.excluded.map((r) => r.rule_id)).toEqual(['10-42']);
  });
  it('有 opinion 时给排除行算出 suspect_missed', () => {
    const opinions = [{ rule_id: '10-42', selection_ok: true }];
    const m = buildRuleDisplayModel({ provenance, opinions });
    expect(m.excluded[0].filter_verdict).toBe('suspect_missed');
    expect(m.excluded[0].selection_ok).toBe(true);
  });
  it('无 opinion 行 selection_ok=null,verdict=unknown', () => {
    const m = buildRuleDisplayModel({ provenance, opinions: [] });
    expect(m.excluded[0].selection_ok).toBeNull();
    expect(m.excluded[0].filter_verdict).toBe('unknown');
  });
});
