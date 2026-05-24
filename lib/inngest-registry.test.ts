import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock listFunctions before importing the SUT so the cached module sees the mock
const mockListFunctions = vi.fn();
vi.mock('@/lib/inngest-admin-client', () => ({
  listFunctions: () => mockListFunctions(),
}));

describe('fetchLiveRegistry', () => {
  beforeEach(() => {
    mockListFunctions.mockReset();
    vi.resetModules();
  });

  it('derives realness=real for non-agent. fnIds and realness=shell for agent. fnIds', async () => {
    mockListFunctions.mockResolvedValue([
      { id: 'create-jd-agent',       slug: 'agentic-operator-main-create-jd-agent',       name: 'Create JD Agent', triggers: [{ value: 'CLARIFICATION_READY' }] },
      { id: 'agent.reqsync',         slug: 'agentic-operator-main-agent.reqsync',         name: 'ReqSync',         triggers: [{ value: 'SCHEDULED_SYNC' }] },
    ]);
    const { fetchLiveRegistry } = await import('./inngest-registry');
    const entries = await fetchLiveRegistry({ force: true });
    const jd = entries.find(e => e.short === 'JDGenerator');
    expect(jd?.realness).toBe('real');
    expect(jd?.fnId).toBe('create-jd-agent');
    const req = entries.find(e => e.short === 'ReqSync');
    expect(req?.realness).toBe('shell');
  });

  it('marks AGENT_MAP entries with no matching live fn as unbuilt', async () => {
    mockListFunctions.mockResolvedValue([]); // nothing registered
    const { fetchLiveRegistry } = await import('./inngest-registry');
    const entries = await fetchLiveRegistry({ force: true });
    // ALL AGENT_MAP entries become unbuilt when Inngest returns empty
    expect(entries.every(e => e.realness === 'unbuilt')).toBe(true);
  });

  it('surfaces live fns that have no AGENT_MAP entry', async () => {
    mockListFunctions.mockResolvedValue([
      { id: 'mystery-new-agent', slug: 'agentic-operator-main-mystery-new-agent', name: 'Mystery', triggers: [{ value: 'X' }] },
    ]);
    const { fetchLiveRegistry } = await import('./inngest-registry');
    const entries = await fetchLiveRegistry({ force: true });
    const mystery = entries.find(e => e.fnId === 'mystery-new-agent');
    expect(mystery).toBeDefined();
    expect(mystery?.realness).toBe('real');
    expect(mystery?.short).toBe('mystery-new');
  });

  it('caches results for 5s; force=true bypasses cache', async () => {
    mockListFunctions.mockResolvedValue([]);
    const { fetchLiveRegistry } = await import('./inngest-registry');
    await fetchLiveRegistry({ force: true });
    await fetchLiveRegistry(); // hits cache
    await fetchLiveRegistry(); // hits cache
    expect(mockListFunctions).toHaveBeenCalledTimes(1);
    await fetchLiveRegistry({ force: true });
    expect(mockListFunctions).toHaveBeenCalledTimes(2);
  });

  it('returns AGENT_MAP entries as unbuilt when listFunctions throws', async () => {
    mockListFunctions.mockRejectedValue(new Error('inngest unreachable'));
    const { fetchLiveRegistry } = await import('./inngest-registry');
    const entries = await fetchLiveRegistry({ force: true });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e.realness === 'unbuilt')).toBe(true);
  });

  it('uses inngestId override when present, ignoring conventions', async () => {
    mockListFunctions.mockResolvedValue([
      { id: 'match-resume-agent', slug: 'agentic-operator-main-match-resume-agent', name: 'Match Resume Agent', triggers: [] },
    ]);
    const { fetchLiveRegistry } = await import('./inngest-registry');
    const entries = await fetchLiveRegistry({ force: true });
    const matcher = entries.find(e => e.short === 'Matcher');
    expect(matcher?.fnId).toBe('match-resume-agent');
    expect(matcher?.realness).toBe('real');
  });
});

describe('countByRealness', () => {
  beforeEach(() => { mockListFunctions.mockReset(); vi.resetModules(); });
  it('counts each realness bucket', async () => {
    mockListFunctions.mockResolvedValue([
      { id: 'create-jd-agent',     slug: 'a', name: 'a', triggers: [] },
      { id: 'resume-parser-agent', slug: 'b', name: 'b', triggers: [] },
      { id: 'agent.reqsync',       slug: 'c', name: 'c', triggers: [] },
    ]);
    const { countByRealness } = await import('./inngest-registry');
    const c = await countByRealness();
    expect(c.real).toBe(2);
    expect(c.shell).toBe(1);
    expect(c.total).toBeGreaterThanOrEqual(c.real + c.shell);
  });
});
