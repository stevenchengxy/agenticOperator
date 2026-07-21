import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    workflowRun: { findUnique: vi.fn(), update: vi.fn() },
    humanTask: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { POST } from './route';
import { prisma } from '@/server/db';

const req = (body: unknown) =>
  new Request('http://localhost/api/manage/runs/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/manage/runs/batch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 for invalid action', async () => {
    const res = await POST(req({ action: 'restart', runIds: ['r1'] }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('BAD_REQUEST');
    expect(j.message).toMatch(/restart/);
  });

  it('returns 400 for empty runIds', async () => {
    const res = await POST(req({ action: 'cancel', runIds: [] }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('BAD_REQUEST');
    expect(j.message).toMatch(/non-empty/);
  });

  it('returns 400 when runIds exceeds 100', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `r${i}`);
    const res = await POST(req({ action: 'cancel', runIds: ids }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('BAD_REQUEST');
    expect(j.message).toMatch(/100/);
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await POST(
      new Request('http://localhost/api/manage/runs/batch', {
        method: 'POST',
        body: 'not-json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('happy path: cancel — all succeed', async () => {
    (prisma.workflowRun.findUnique as any)
      .mockResolvedValueOnce({ id: 'r1', status: 'running' })
      .mockResolvedValueOnce({ id: 'r2', status: 'paused' });
    (prisma.workflowRun.update as any).mockResolvedValue({});
    (prisma.humanTask.updateMany as any).mockResolvedValue({ count: 0 });
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(req({ action: 'cancel', runIds: ['r1', 'r2'], reason: 'test' }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.succeeded).toEqual(['r1', 'r2']);
    expect(j.failed).toHaveLength(0);
  });

  it('partial failure: one run not found', async () => {
    (prisma.workflowRun.findUnique as any)
      .mockResolvedValueOnce({ id: 'r1', status: 'running' })
      .mockResolvedValueOnce(null);
    (prisma.workflowRun.update as any).mockResolvedValue({});
    (prisma.humanTask.updateMany as any).mockResolvedValue({ count: 0 });
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(req({ action: 'cancel', runIds: ['r1', 'r2'] }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.succeeded).toContain('r1');
    expect(j.failed).toEqual([{ id: 'r2', error: 'not_found' }]);
  });

  it('partial failure: wrong status for action', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue({ id: 'r1', status: 'completed' });
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(req({ action: 'cancel', runIds: ['r1'] }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.succeeded).toHaveLength(0);
    expect(j.failed[0].id).toBe('r1');
    expect(j.failed[0].error).toMatch(/INVALID_STATUS/);
  });

  it('writes one AuditLog row with batch payload', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue({ id: 'r1', status: 'running' });
    (prisma.workflowRun.update as any).mockResolvedValue({});
    (prisma.humanTask.updateMany as any).mockResolvedValue({ count: 0 });
    (prisma.auditLog.create as any).mockResolvedValue({});

    await POST(req({ action: 'cancel', runIds: ['r1'] }));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = (prisma.auditLog.create as any).mock.calls[0][0];
    expect(call.data.eventName).toBe('manage.run.batch.cancel');
    const payload = JSON.parse(call.data.payload);
    expect(payload.after.batch).toBe(true);
    expect(payload.after.runIds).toEqual(['r1']);
  });

  it('pause batch: only running runs can be paused', async () => {
    (prisma.workflowRun.findUnique as any)
      .mockResolvedValueOnce({ id: 'r1', status: 'running' })
      .mockResolvedValueOnce({ id: 'r2', status: 'paused' }); // already paused
    (prisma.workflowRun.update as any).mockResolvedValue({});
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(req({ action: 'pause', runIds: ['r1', 'r2'] }));
    const j = await res.json();
    expect(j.succeeded).toContain('r1');
    expect(j.failed[0].id).toBe('r2');
  });

  it('resume batch: only paused runs can be resumed', async () => {
    (prisma.workflowRun.findUnique as any)
      .mockResolvedValueOnce({ id: 'r1', status: 'paused' })
      .mockResolvedValueOnce({ id: 'r2', status: 'running' }); // not paused
    (prisma.workflowRun.update as any).mockResolvedValue({});
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(req({ action: 'resume', runIds: ['r1', 'r2'] }));
    const j = await res.json();
    expect(j.succeeded).toContain('r1');
    expect(j.failed[0].id).toBe('r2');
  });
});
