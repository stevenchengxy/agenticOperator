import { describe, expect, it, beforeEach, vi } from 'vitest';

const { runArchiveFindMany, tombstoneAndDeleteRuns, writeManageAudit } = vi.hoisted(() => ({
  runArchiveFindMany: vi.fn(),
  tombstoneAndDeleteRuns: vi.fn(),
  writeManageAudit: vi.fn(),
}));

vi.mock('@/server/db', () => ({
  prisma: { inngestRunArchive: { findMany: runArchiveFindMany } },
}));
vi.mock('@/lib/inngest-archive/tombstones', () => ({ tombstoneAndDeleteRuns }));
vi.mock('@/lib/manage/audit', () => ({ writeManageAudit }));

import { POST } from './route';

function post(body: unknown): Request {
  return new Request('http://x/api/inngest-admin/runs/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tombstoneAndDeleteRuns.mockResolvedValue({ deleted: 0 });
});

describe('POST /api/inngest-admin/runs/delete (监控页批量删除)', () => {
  it('deletes terminal + unarchived runs, rejects Running per-item', async () => {
    runArchiveFindMany.mockResolvedValue([
      { runId: 'done', status: 'Completed' },
      { runId: 'dead', status: 'Failed' },
      { runId: 'busy', status: 'Running' },
      // 'ghost' is live-only (no archive row) — deletable: tombstone hides it.
    ]);
    const res = await POST(post({ runIds: ['done', 'dead', 'busy', 'ghost', 'done'] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.requested).toBe(4); // deduped
    expect(body.deleted).toBe(3);
    expect(body.rejected).toBe(1);
    expect(body.ok).toBe(false);
    expect(tombstoneAndDeleteRuns).toHaveBeenCalledWith(['done', 'dead', 'ghost']);
    const busy = (body.results as Array<{ runId: string; ok: boolean; error?: string }>)
      .find((r) => r.runId === 'busy');
    expect(busy?.ok).toBe(false);
    expect(busy?.error).toBe('run-still-running');
  });

  it('writes one consolidated audit row per batch', async () => {
    runArchiveFindMany.mockResolvedValue([{ runId: 'a', status: 'Failed' }]);
    await POST(post({ runIds: ['a'] }));
    expect(writeManageAudit).toHaveBeenCalledTimes(1);
    expect(writeManageAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'manage.run.delete.batch',
      traceId: 'batch',
    }));
  });

  it('is ok:true when nothing was rejected', async () => {
    runArchiveFindMany.mockResolvedValue([{ runId: 'a', status: 'Cancelled' }]);
    const res = await POST(post({ runIds: ['a'] }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(1);
  });

  it('does not touch the archive when every run is still Running', async () => {
    runArchiveFindMany.mockResolvedValue([{ runId: 'a', status: 'Running' }]);
    const res = await POST(post({ runIds: ['a'] }));
    const body = await res.json();
    expect(body.deleted).toBe(0);
    expect(tombstoneAndDeleteRuns).not.toHaveBeenCalled();
  });

  it('rejects an empty batch', async () => {
    const res = await POST(post({ runIds: [] }));
    expect(res.status).toBe(400);
  });

  it('rejects non-array runIds', async () => {
    const res = await POST(post({ runIds: 'a' }));
    expect(res.status).toBe(400);
  });

  it('rejects a batch over the 100 limit', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `r${i}`);
    const res = await POST(post({ runIds: ids }));
    expect(res.status).toBe(400);
    expect(tombstoneAndDeleteRuns).not.toHaveBeenCalled();
  });

  it('502s when the delete transaction fails', async () => {
    runArchiveFindMany.mockResolvedValue([{ runId: 'a', status: 'Failed' }]);
    tombstoneAndDeleteRuns.mockRejectedValue(new Error('pg down'));
    const res = await POST(post({ runIds: ['a'] }));
    expect(res.status).toBe(502);
  });
});
