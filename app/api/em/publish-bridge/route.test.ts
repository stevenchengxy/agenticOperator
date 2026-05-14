import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/em', () => ({
  em: { publish: vi.fn() },
}));

import { POST } from './route';
import { em } from '@/server/em';

// Grab the mock reference after import so vi.fn() is fully initialised
const mockPublish = em.publish as ReturnType<typeof vi.fn>;

const req = (body: unknown) =>
  new Request('http://localhost/api/em/publish-bridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/em/publish-bridge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 for invalid JSON', async () => {
    const res = await POST(
      new Request('http://localhost', { method: 'POST', body: 'not-json' }),
    );
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('BAD_REQUEST');
  });

  it('returns 400 when name is missing', async () => {
    const res = await POST(req({ data: {}, source: 'rpa.test' }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.field).toBe('name');
  });

  it('returns 400 when data is missing', async () => {
    const res = await POST(req({ name: 'TEST_EVENT', source: 'rpa.test' }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.field).toBe('data');
  });

  it('returns 400 when source is missing', async () => {
    const res = await POST(req({ name: 'TEST_EVENT', data: {} }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.field).toBe('source');
  });

  it('happy path: calls em.publish with correct args and returns result', async () => {
    mockPublish.mockResolvedValue({ accepted: true, eventId: 'evt-123' });

    const res = await POST(
      req({
        name: 'RESUME_PROCESSED',
        data: { upload_id: 'u1' },
        source: 'rpa.resumeParserAgent',
        externalEventId: 'ext-001',
        causedBy: { eventId: 'prev-evt', name: 'RESUME_DOWNLOADED' },
        traceId: 'trace-abc',
      }),
    );

    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.accepted).toBe(true);
    expect(j.eventId).toBe('evt-123');

    expect(mockPublish).toHaveBeenCalledWith(
      'RESUME_PROCESSED',
      { upload_id: 'u1' },
      expect.objectContaining({
        source: 'rpa.resumeParserAgent',
        externalEventId: 'ext-001',
        causedBy: { eventId: 'prev-evt', name: 'RESUME_DOWNLOADED' },
        traceId: 'trace-abc',
      }),
    );
  });

  it('omits optional fields when not provided', async () => {
    mockPublish.mockResolvedValue({ accepted: true, eventId: 'evt-456' });

    await POST(req({ name: 'JD_GENERATED', data: { jd_id: 'j1' }, source: 'rpa.createJdAgent' }));

    expect(mockPublish).toHaveBeenCalledWith(
      'JD_GENERATED',
      { jd_id: 'j1' },
      expect.objectContaining({ source: 'rpa.createJdAgent' }),
    );
    const call = mockPublish.mock.calls[0][2];
    expect(call.externalEventId).toBeUndefined();
    expect(call.causedBy).toBeUndefined();
    expect(call.traceId).toBeUndefined();
  });

  it('returns 500 when em.publish throws', async () => {
    mockPublish.mockRejectedValue(new Error('em down'));

    const res = await POST(req({ name: 'TEST', data: {}, source: 'rpa.test' }));
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.error).toBe('internal');
  });
});
