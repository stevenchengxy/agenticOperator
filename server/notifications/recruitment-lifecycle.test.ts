import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordNotification = vi.fn(async (_input: unknown) => ({ id: 'n1' }));
vi.mock('./ingest', () => ({ recordNotification: (input: unknown) => recordNotification(input) }));

import { notifyRecruitmentLifecycle } from './recruitment-lifecycle';

function mockStep() {
  const ids: string[] = [];
  return {
    ids,
    run: async (id: string, fn: () => Promise<unknown>) => {
      ids.push(id);
      return await fn();
    },
  };
}

describe('notifyRecruitmentLifecycle', () => {
  beforeEach(() => recordNotification.mockClear());

  it('候选人类信号 → level info、agent_lifecycle、不带 eventName、中文文案、candidate anchors', async () => {
    const step = mockStep();
    await notifyRecruitmentLifecycle(step, 'RESUME_PROCESSED', {
      anchors: { candidate_id: 'c1', upload_id: 'u1' },
      runId: 'r1',
      traceId: 't1',
    });
    expect(step.ids).toEqual(['notify:RESUME_PROCESSED:candidate_id-c1-upload_id-u1']);
    expect(recordNotification).toHaveBeenCalledTimes(1);
    const arg = recordNotification.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.level).toBe('info');
    expect(arg.category).toBe('agent_lifecycle');
    expect(arg.eventName).toBeUndefined();
    expect(arg.message).toBe('简历解析完成 · 候选人 c1'); // 标题带主体(2026-06-11)
    expect(arg.source).toBe('简历解析');
    expect(arg.agent).toBe('ResumeParser');
    expect(arg.anchors).toEqual({ candidate_id: 'c1', upload_id: 'u1' });
    expect(arg.runId).toBe('r1');
    expect(arg.traceId).toBe('t1');
  });

  it('JD_GENERATED → 岗位文案 + JDGenerator 短名', async () => {
    const step = mockStep();
    await notifyRecruitmentLifecycle(step, 'JD_GENERATED', {
      anchors: { job_requisition_id: 'jr1' },
    });
    const arg = recordNotification.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.message).toBe('职位描述已生成 · 岗位 jr1'); // 标题带主体(2026-06-11)
    expect(arg.agent).toBe('JDGenerator');
    expect(arg.source).toBe('JD 生成');
  });

  it('每个 signal 都有文案且 step id 唯一', async () => {
    const signals = [
      'RESUME_PROCESSED', 'MATCH_RULE_CHECK_PASSED', 'MATCH_RULE_CHECK_FAILED',
      'MATCH_PASSED_NEED_INTERVIEW', 'MATCH_FAILED', 'JD_GENERATED', 'INTERVIEW_INVITATION_SENT',
      'INTERVIEW_INVITATION_FAILED',
    ] as const;
    for (const s of signals) {
      recordNotification.mockClear();
      const step = mockStep();
      await notifyRecruitmentLifecycle(step, s, { anchors: { candidate_id: 'c' } });
      const arg = recordNotification.mock.calls[0][0] as Record<string, unknown>;
      expect(typeof arg.message).toBe('string');
      expect((arg.message as string).length).toBeGreaterThan(0);
      expect(step.ids[0]).toBe(`notify:${s}:candidate_id-c`);
    }
  });

  it('同一 run 内不同 JR 使用不同 step id，不会只记录第一条通知', async () => {
    const step = mockStep();
    await notifyRecruitmentLifecycle(step, 'MATCH_RULE_CHECK_FAILED', {
      anchors: { candidate_id: 'c1', job_requisition_id: 'jr1' },
    });
    await notifyRecruitmentLifecycle(step, 'MATCH_RULE_CHECK_FAILED', {
      anchors: { candidate_id: 'c1', job_requisition_id: 'jr2' },
    });
    expect(step.ids).toEqual([
      'notify:MATCH_RULE_CHECK_FAILED:candidate_id-c1-job_requisition_id-jr1',
      'notify:MATCH_RULE_CHECK_FAILED:candidate_id-c1-job_requisition_id-jr2',
    ]);
  });

  it('recordNotification 抛错不向上冒泡（fire-and-forget）', async () => {
    recordNotification.mockRejectedValueOnce(new Error('db down'));
    const step = mockStep();
    await expect(
      notifyRecruitmentLifecycle(step, 'MATCH_FAILED', { anchors: { candidate_id: 'c' } }),
    ).resolves.toBeUndefined();
  });
});
