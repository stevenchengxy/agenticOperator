import { describe, it, expect, beforeEach, vi } from 'vitest';

const { create, upsert } = vi.hoisted(() => ({ create: vi.fn(), upsert: vi.fn() }));
vi.mock('@/server/db', () => ({
  prisma: { notification: { create, upsert } },
}));

import { recordNotification } from './ingest';

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: 'n1' });
  upsert.mockResolvedValue({ id: 'n1' });
});

describe('recordNotification', () => {
  it('persists a business message as a create (kind=message), with deep-link', async () => {
    await recordNotification({
      level: 'info',
      category: 'event_publish',
      eventName: 'REQUIREMENT_SYNCED',
      message: '需求已同步',
      anchors: { job_requisition_id: 'JR1' },
      runId: 'run1',
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({
      kind: 'message',
      severity: 'info',
      category: 'event',
      linkKind: 'run',
      linkId: 'run1',
      shouldNotify: false,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('upserts an alert by (dedupeKey, status=firing), bumping count on conflict', async () => {
    await recordNotification({
      level: 'critical',
      source: 'LLM 网关',
      category: 'llm_call',
      message: '401 无效的令牌',
      dedupeHint: 'llm_gateway_401',
      runId: 'run2',
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ dedupeKey_status: { dedupeKey: 'llm_gateway_401', status: 'firing' } });
    expect(arg.create).toMatchObject({ kind: 'alert', severity: 'critical', status: 'firing', shouldNotify: true });
    expect(arg.update).toMatchObject({ count: { increment: 1 } });
    expect(create).not.toHaveBeenCalled();
  });

  it('ignores plumbing signals — returns null, writes nothing', async () => {
    const r = await recordNotification({ level: 'info', category: 'tool_call', message: 'tool ran' });
    expect(r).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('never throws — swallows persistence errors (fire-and-forget)', async () => {
    create.mockRejectedValueOnce(new Error('db down'));
    const r = await recordNotification({ level: 'info', category: 'agent_lifecycle', message: 'handler.end', runId: 'r' });
    expect(r).toBeNull();
  });
});
