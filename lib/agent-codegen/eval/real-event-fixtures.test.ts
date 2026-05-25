import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pickRealEventFixture, pickRealEventPayload } from './real-event-fixtures';

vi.mock('@/server/db', () => ({
  prisma: {
    eventInstance: {
      findMany: vi.fn(),
    },
  },
}));

describe('pickRealEventFixture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no rows match', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.eventInstance.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const r = await pickRealEventFixture('REQUIREMENT_LOGGED');
    expect(r).toBeNull();
  });

  it('returns null when all candidate rows have empty / unparseable payload', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.eventInstance.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'e1', source: 'raas-bridge', payloadSummary: null, ts: new Date() },
      { id: 'e2', source: 'raas-bridge', payloadSummary: 'not-json', ts: new Date() },
      { id: 'e3', source: 'raas-bridge', payloadSummary: '{}', ts: new Date() },
    ]);

    const r = await pickRealEventFixture('REQUIREMENT_LOGGED');
    expect(r).toBeNull();
  });

  it('picks the row with the most top-level keys as most representative', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.eventInstance.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'thin',
        source: 'raas-bridge',
        payloadSummary: JSON.stringify({ id: 'jr1' }),
        ts: new Date(),
      },
      {
        id: 'fat',
        source: 'raas-bridge',
        payloadSummary: JSON.stringify({
          job_requisition_id: 'jr2',
          client_id: 'c1',
          client_job_title: 'Senior SRE',
          must_have_skills: ['typescript'],
          trace: { trace_id: 't1' },
        }),
        ts: new Date(),
      },
    ]);

    const r = await pickRealEventFixture('REQUIREMENT_LOGGED');
    expect(r).not.toBeNull();
    expect(r!.eventInstanceId).toBe('fat');
    expect(r!.data.job_requisition_id).toBe('jr2');
    expect(r!.source).toBe('raas-bridge');
  });

  it('skips arrays and non-object payloads', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.eventInstance.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'arr', source: 's', payloadSummary: JSON.stringify(['a', 'b']), ts: new Date() },
      { id: 'str', source: 's', payloadSummary: JSON.stringify('just a string'), ts: new Date() },
      { id: 'ok',  source: 's', payloadSummary: JSON.stringify({ x: 1, y: 2 }), ts: new Date() },
    ]);

    const r = await pickRealEventFixture('X');
    expect(r!.eventInstanceId).toBe('ok');
  });
});

describe('pickRealEventPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the bare data when a fixture is found', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.eventInstance.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'e1', source: 's', payloadSummary: JSON.stringify({ a: 1, b: 2 }), ts: new Date() },
    ]);

    const r = await pickRealEventPayload('X');
    expect(r).toEqual({ a: 1, b: 2 });
  });

  it('returns null when nothing matches', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.eventInstance.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    expect(await pickRealEventPayload('X')).toBeNull();
  });
});
