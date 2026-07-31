import { describe, it, expect } from 'vitest';
import {
  deriveCompanyDescriptor,
  buildCompanyBackgroundBlock,
  buildGenerationConstraintsBlock,
  budgetPrompt,
} from './jd-prompt-blocks';

describe('deriveCompanyDescriptor — anonymized company label (rule 4-2 safe)', () => {
  it('wraps the industry into a knowable-but-anonymous descriptor', () => {
    expect(deriveCompanyDescriptor('金融科技')).toBe('某金融科技行业知名企业');
  });
  it('avoids doubling 行业 when the industry already ends with it', () => {
    expect(deriveCompanyDescriptor('金融科技行业')).toBe('某金融科技行业知名企业');
  });
  it('degrades to a generic descriptor when industry is missing', () => {
    expect(deriveCompanyDescriptor(null)).toBe('某知名企业');
    expect(deriveCompanyDescriptor('')).toBe('某知名企业');
    expect(deriveCompanyDescriptor('   ')).toBe('某知名企业');
  });
});

describe('buildCompanyBackgroundBlock — Benefits/tech-stack context (fixes the "TBD" gap)', () => {
  it('renders descriptor + tech stack + welfare when present', () => {
    const block = buildCompanyBackgroundBlock({
      descriptor: '某金融科技行业知名企业',
      technicalStackPreference: 'Java/Spring Cloud/K8s',
      welfarePolicy: '五险一金、年度体检、弹性办公',
    });
    expect(block).toContain('公司背景: 某金融科技行业知名企业');
    expect(block).toContain('技术栈偏好: Java/Spring Cloud/K8s');
    expect(block).toContain('福利政策: 五险一金、年度体检、弹性办公');
  });
  it('emits only the lines it has', () => {
    const block = buildCompanyBackgroundBlock({ descriptor: '某知名企业' });
    expect(block).toContain('公司背景: 某知名企业');
    expect(block).not.toContain('技术栈偏好');
    expect(block).not.toContain('福利政策');
  });
  it('returns empty string when there is nothing to add', () => {
    expect(buildCompanyBackgroundBlock({})).toBe('');
  });
});

describe('buildGenerationConstraintsBlock — inject ontology createJD rules into the prompt', () => {
  const rules = [
    { id: '4-2', name: '客户匿名', rule: 'JD 全文不得出现客户公司名称', enforcement: 'mandatory', failurePolicy: 'block' },
    { id: '4-3', name: '反歧视', rule: '不得包含性别/年龄/婚育等歧视性表述', enforcement: 'mandatory', failurePolicy: 'block' },
  ];
  it('renders a constraints header + one bullet per rule', () => {
    const block = buildGenerationConstraintsBlock(rules);
    expect(block).toContain('生成约束');
    expect(block).toContain('JD 全文不得出现客户公司名称');
    expect(block).toContain('不得包含性别/年龄/婚育等歧视性表述');
  });
  it('returns empty string for no rules (Allmeta down → fail-closed, no constraint block)', () => {
    expect(buildGenerationConstraintsBlock([])).toBe('');
  });
});

describe('budgetPrompt — reserve space for appended blocks, truncate requirement body first', () => {
  it('returns the body unchanged when no blocks and within limit', () => {
    expect(budgetPrompt('short body', '', 4000)).toBe('short body');
  });
  it('caps at the limit exactly as the old slice(0,limit) did when there are no blocks', () => {
    const long = 'x'.repeat(5000);
    expect(budgetPrompt(long, '', 4000)).toHaveLength(4000);
  });
  it('preserves the full appended blocks and truncates the body to fit under the limit', () => {
    const long = 'x'.repeat(5000);
    const blocks = 'CONSTRAINTS-AND-BACKGROUND';
    const out = budgetPrompt(long, blocks, 4000);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out.endsWith(blocks)).toBe(true); // blocks survived, never truncated away
  });
  it('joins body and blocks with a separator when both fit', () => {
    expect(budgetPrompt('body', 'blocks', 4000)).toBe('body\n\nblocks');
  });
});
