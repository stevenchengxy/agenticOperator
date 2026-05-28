// create-jd-agent.test.ts — unit tests for createJD helper logic.
//
// Focus: proseToSkillArray — converts RoboHire generate-jd free-text
// hardRequirements / niceToHave prose into the structured skill arrays
// (must_have_skills / nice_to_have_skills) stored on Job_Requisition.

import { describe, it, expect, vi } from 'vitest';

// Mock the inngest client so importing the agent module doesn't register a
// real function at module load.
vi.mock('@/server/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })),
  },
}));

import { proseToSkillArray } from './create-jd-agent';

describe('proseToSkillArray', () => {
  it('splits numbered hardRequirements prose into discrete items', () => {
    const input =
      '1. 必须为统招本科及以上学历（学信网可查）。\n2. 能够熟练使用 Python 进行功能开发与脚本编写。\n3. 工作地点位于深圳南山区，需线下全职办公。';
    expect(proseToSkillArray(input)).toEqual([
      '必须为统招本科及以上学历（学信网可查）。',
      '能够熟练使用 Python 进行功能开发与脚本编写。',
      '工作地点位于深圳南山区，需线下全职办公。',
    ]);
  });

  it('splits dash-bulleted niceToHave prose into discrete items', () => {
    const input =
      '- 有过个人开源 AI 项目或在 GitHub 上活跃参与过 AI 相关仓库贡献。\n- 熟悉 Docker 容器化部署及基础的 Linux 命令。';
    expect(proseToSkillArray(input)).toEqual([
      '有过个人开源 AI 项目或在 GitHub 上活跃参与过 AI 相关仓库贡献。',
      '熟悉 Docker 容器化部署及基础的 Linux 命令。',
    ]);
  });

  it('strips Chinese-style and parenthesized numbering', () => {
    expect(proseToSkillArray('1、甲\n2）乙')).toEqual(['甲', '乙']);
  });

  it('strips bullet glyphs (• · *)', () => {
    expect(proseToSkillArray('• A\n· B\n* C')).toEqual(['A', 'B', 'C']);
  });

  it('drops blank lines', () => {
    expect(proseToSkillArray('- A\n\n  \n- B')).toEqual(['A', 'B']);
  });

  it('keeps an unmarked single line as one item', () => {
    expect(proseToSkillArray('扎实的工程基础')).toEqual(['扎实的工程基础']);
  });

  it('returns empty array for non-string / empty input', () => {
    expect(proseToSkillArray(undefined)).toEqual([]);
    expect(proseToSkillArray(null)).toEqual([]);
    expect(proseToSkillArray(123)).toEqual([]);
    expect(proseToSkillArray('   ')).toEqual([]);
  });
});
