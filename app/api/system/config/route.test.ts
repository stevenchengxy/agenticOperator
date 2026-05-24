import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockListFunctions = vi.fn();
vi.mock('@/lib/inngest-admin-client', () => ({
  listFunctions: () => mockListFunctions(),
}));

const mockEmFindUnique = vi.fn();
const mockEventDefCount = vi.fn();
const mockAgentActivityCount = vi.fn();
vi.mock('@/server/db', () => ({
  prisma: {
    emSystemStatus: { findUnique: () => mockEmFindUnique() },
    eventDefinition: { count: () => mockEventDefCount() },
    agentActivity: { count: () => mockAgentActivityCount() },
  },
}));

describe('GET /api/system/config', () => {
  beforeEach(() => {
    mockListFunctions.mockReset();
    mockEmFindUnique.mockReset();
    mockEventDefCount.mockReset();
    mockAgentActivityCount.mockReset();
    vi.resetModules();
  });

  it('returns inngest.url + sourceEnv + counts', async () => {
    process.env.INNGEST_BASE_URL = 'http://test-host:8288';
    mockListFunctions.mockResolvedValue([
      { id: 'a', slug: 's-a', name: 'A', triggers: [] },
      { id: 'b', slug: 's-b', name: 'B', triggers: [] },
    ]);
    mockEmFindUnique.mockResolvedValue({ neo4jLastSyncAt: new Date(), neo4jLastError: null });
    mockEventDefCount.mockResolvedValue(28);
    mockAgentActivityCount.mockResolvedValue(0);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.inngest.url).toBe('http://test-host:8288');
    expect(j.inngest.sourceEnv).toBe('INNGEST_BASE_URL');
    expect(j.inngest.registeredFunctionCount).toBe(2);
    expect(j.inngest.healthy).toBe(true);
  });

  it('returns eventEngine.syncedEventCount + staleness', async () => {
    process.env.INNGEST_BASE_URL = 'http://x:8288';
    mockListFunctions.mockResolvedValue([]);
    mockEmFindUnique.mockResolvedValue({ neo4jLastSyncAt: new Date(), neo4jLastError: null });
    mockEventDefCount.mockResolvedValue(28);
    mockAgentActivityCount.mockResolvedValue(0);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.eventEngine.syncedEventCount).toBe(28);
    expect(j.eventEngine.staleness).toMatch(/fresh|stale|never/);
  });

  it('returns staleness=never when lastSyncAt is null', async () => {
    process.env.INNGEST_BASE_URL = 'http://x:8288';
    mockEmFindUnique.mockResolvedValue(null);
    mockEventDefCount.mockResolvedValue(0);
    mockListFunctions.mockResolvedValue([]);
    mockAgentActivityCount.mockResolvedValue(0);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.eventEngine.staleness).toBe('never');
    expect(j.eventEngine.lastSyncAt).toBeNull();
  });

  it('returns healthy=false when Inngest list throws', async () => {
    process.env.INNGEST_BASE_URL = 'http://x:8288';
    mockListFunctions.mockRejectedValue(new Error('down'));
    mockEmFindUnique.mockResolvedValue(null);
    mockEventDefCount.mockResolvedValue(0);
    mockAgentActivityCount.mockResolvedValue(0);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.inngest.healthy).toBe(false);
    expect(j.inngest.registeredFunctionCount).toBe(0);
  });
});
