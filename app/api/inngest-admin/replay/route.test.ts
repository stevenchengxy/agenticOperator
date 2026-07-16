import { describe, expect, it, beforeEach, vi } from 'vitest';

const { replayEvent, sendEvent, writeManageAudit } = vi.hoisted(() => ({
  replayEvent: vi.fn(),
  sendEvent: vi.fn(),
  writeManageAudit: vi.fn(),
}));

vi.mock('@/lib/inngest-source', () => ({ replayEvent, sendEvent }));
vi.mock('@/lib/manage/audit', () => ({ writeManageAudit }));

import { POST } from './route';

function post(body: unknown): Request {
  return new Request('http://x/api/inngest-admin/replay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/inngest-admin/replay — batch (监控页批量重试)', () => {
  it('replays each unique id once and reports per-item results', async () => {
    replayEvent.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('event bad not found in live buffer');
      return { newEventId: `new-${id}` };
    });
    const res = await POST(post({ eventIds: ['a', 'b', 'a', 'bad'] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.requested).toBe(3); // 'a' deduped
    expect(body.replayed).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.ok).toBe(false);
    expect(replayEvent).toHaveBeenCalledTimes(3);
    const bad = (body.results as Array<{ eventId: string; ok: boolean; error?: string }>)
      .find((r) => r.eventId === 'bad');
    expect(bad?.ok).toBe(false);
    expect(bad?.error).toMatch(/not found/);
  });

  it('writes one consolidated audit row per batch', async () => {
    replayEvent.mockResolvedValue({ newEventId: 'n1' });
    await POST(post({ eventIds: ['a', 'b'] }));
    expect(writeManageAudit).toHaveBeenCalledTimes(1);
    expect(writeManageAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'manage.event.replay.batch',
      traceId: 'batch',
    }));
  });

  it('is all-green when every replay succeeds', async () => {
    replayEvent.mockResolvedValue({ newEventId: 'n1' });
    const res = await POST(post({ eventIds: ['a', 'b'] }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.replayed).toBe(2);
    expect(body.failed).toBe(0);
  });

  it('rejects an empty batch', async () => {
    const res = await POST(post({ eventIds: [] }));
    expect(res.status).toBe(400);
    expect(replayEvent).not.toHaveBeenCalled();
  });

  it('rejects non-array eventIds', async () => {
    const res = await POST(post({ eventIds: 'a' }));
    expect(res.status).toBe(400);
  });

  it('rejects a batch over the 100 limit', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `e${i}`);
    const res = await POST(post({ eventIds: ids }));
    expect(res.status).toBe(400);
    expect(replayEvent).not.toHaveBeenCalled();
  });
});

describe('POST /api/inngest-admin/replay — single', () => {
  it('replays one event by id and audits it', async () => {
    replayEvent.mockResolvedValue({ newEventId: 'new-1' });
    const res = await POST(post({ eventId: 'ev-1' }));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, replayed_from: 'ev-1', new_event_id: 'new-1' });
    expect(writeManageAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'manage.event.replay',
      traceId: 'ev-1',
    }));
  });

  it('returns 502 when the single replay fails', async () => {
    replayEvent.mockRejectedValue(new Error('boom'));
    const res = await POST(post({ eventId: 'ev-1' }));
    expect(res.status).toBe(502);
  });

  it('sends a fresh event by name', async () => {
    sendEvent.mockResolvedValue({ id: 'fresh-1' });
    const res = await POST(post({ name: 'EVENT_A', data: { x: 1 } }));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, new_event_id: 'fresh-1' });
    expect(sendEvent).toHaveBeenCalledWith('EVENT_A', { x: 1 });
  });

  it('400s when neither eventId(s) nor name is given', async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
  });
});
