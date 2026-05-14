import { describe, expect, it, afterAll } from 'vitest';
import { prisma } from '@/server/db';

describe('RuleCheckRun + RuleCheckScenarioResult models', () => {
  afterAll(async () => {
    await prisma.ruleCheckScenarioResult.deleteMany({});
    await prisma.ruleCheckRun.deleteMany({});
  });

  it('persists a run with one scenario result and reads it back', async () => {
    const run = await prisma.ruleCheckRun.create({
      data: { model: 'gemini-3-flash-preview', status: 'running' },
    });
    await prisma.ruleCheckScenarioResult.create({
      data: {
        runId: run.id,
        scenarioId: 'S01',
        scenarioName: '控制组 PASS',
        expectedDecision: 'PASS',
        expectedRules: '{}',
        actualDecision: 'REVIEW',
        actualStats: '{}',
        ruleResults: '[]',
        matchKind: 'fail-decision',
        inferenceChain: '[]',
        graphContext: '{}',
        llmMs: 28664,
        llmModel: 'gemini-3-flash-preview',
      },
    });
    const rehydrated = await prisma.ruleCheckRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { results: true },
    });
    expect(rehydrated.results).toHaveLength(1);
    expect(rehydrated.results[0].scenarioId).toBe('S01');
    expect(rehydrated.results[0].matchKind).toBe('fail-decision');
  });

  it('enforces unique (runId, scenarioId) so replay upserts cleanly', async () => {
    const run = await prisma.ruleCheckRun.create({
      data: { model: 'gemini-3-flash-preview', status: 'done' },
    });
    const base = {
      runId: run.id,
      scenarioId: 'S02',
      scenarioName: '华为冷冻期',
      expectedDecision: 'REVIEW',
      expectedRules: '{}',
      actualDecision: 'REVIEW',
      actualStats: '{}',
      ruleResults: '[]',
      matchKind: 'pass',
      inferenceChain: '[]',
      graphContext: '{}',
      llmMs: 1000,
      llmModel: 'gemini-3-flash-preview',
    };
    await prisma.ruleCheckScenarioResult.create({ data: base });
    await expect(
      prisma.ruleCheckScenarioResult.create({ data: base }),
    ).rejects.toThrow();
  });
});
