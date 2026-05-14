// manager-agent.test.ts — integration tests for auto_restart cap logic
//
// Tests the managerAgentHandler directly with mocked prisma, fetch, and em
// to verify the three auto_restart scenarios specified in v11:
//   1. Happy path: count=0 → fetch restart → increment + resolve
//   2. Cap reached: count=2, within 1h window → fall back to escalate (HumanTask)
//   3. Cap reset after 1h: count=2 BUT lastAutoRestartAt >1h ago → treats as fresh (restarts)

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
// vi.mock calls are hoisted to the top, so factory functions can't reference
// variables declared outside. Use vi.fn() inline and retrieve refs via import.

vi.mock('@/server/db', () => ({
  prisma: {
    behaviorAlert: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    humanTask: {
      create: vi.fn().mockResolvedValue({ id: 'task1' }),
    },
  },
}));

vi.mock('@/server/em', () => ({
  em: {
    publish: vi.fn().mockResolvedValue({ accepted: true }),
  },
}));

vi.mock('@/server/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })),
  },
}));

vi.mock('./manager-rules', () => ({
  decide: vi.fn(),
}));

import { managerAgentHandler } from './manager-agent';
import { decide } from './manager-rules';
import { prisma } from '@/server/db';

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockDecide = decide as ReturnType<typeof vi.fn>;
const mockBehaviorAlert = prisma.behaviorAlert as {
  updateMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockHumanTask = prisma.humanTask as {
  create: ReturnType<typeof vi.fn>;
};

function makeAlertEvent(alertKey = 'run_stalled.run-abc-123') {
  return {
    data: {
      alertId: 'alert1',
      alertKey,
      severity: 'error',
      ruleId: 'run_stalled',
      details: 'Run stalled > 30 min',
      detectedAt: new Date().toISOString(),
    },
    id: 'evt1',
  };
}

const mockStep = {
  run: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
  sleep: async () => {},
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('managerAgentHandler — auto_restart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: fetch succeeds
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
  });

  it('1. happy path: count=0 → calls restart API, increments counter, marks resolved', async () => {
    mockDecide.mockReturnValue({ action: 'auto_restart', reason: 'Run stalled, restarting.' });
    mockBehaviorAlert.findUnique.mockResolvedValue({
      id: 'alert1',
      autoRestartCount: 0,
      lastAutoRestartAt: null,
    });

    const event = makeAlertEvent('run_stalled.run-abc-123');
    await managerAgentHandler({ event, step: mockStep });

    // Should have fetched restart endpoint
    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/manage/runs/run-abc-123/restart');
    expect(opts.method).toBe('POST');

    // Should have incremented counter + resolved
    expect(mockBehaviorAlert.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'alert1' },
        data: expect.objectContaining({
          autoRestartCount: { increment: 1 },
          resolvedAt: expect.any(Date),
          lastAutoRestartAt: expect.any(Date),
        }),
      }),
    );
  });

  it('2. cap reached: count=2 within 1h → skips restart, creates escalation HumanTask', async () => {
    mockDecide.mockReturnValue({ action: 'auto_restart', reason: 'Run stalled, restarting.' });
    mockBehaviorAlert.findUnique.mockResolvedValue({
      id: 'alert1',
      autoRestartCount: 2,
      // 30 minutes ago — within the 1h window
      lastAutoRestartAt: new Date(Date.now() - 30 * 60 * 1000),
    });

    const event = makeAlertEvent('run_stalled.run-abc-123');
    await managerAgentHandler({ event, step: mockStep });

    // Should NOT have called restart fetch
    expect(global.fetch).not.toHaveBeenCalled();

    // Should have created a HumanTask for escalation
    expect(mockHumanTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: expect.stringContaining('Auto-restart cap hit'),
          status: 'pending',
        }),
      }),
    );

    // Should NOT have updated the alert's autoRestartCount
    expect(mockBehaviorAlert.update).not.toHaveBeenCalled();
  });

  it('3. cap reset after 1h: count=2 but lastAutoRestartAt >1h ago → restarts as fresh', async () => {
    mockDecide.mockReturnValue({ action: 'auto_restart', reason: 'Run stalled, restarting.' });
    mockBehaviorAlert.findUnique.mockResolvedValue({
      id: 'alert1',
      autoRestartCount: 2,
      // 90 minutes ago — OUTSIDE the 1h window → count should reset
      lastAutoRestartAt: new Date(Date.now() - 90 * 60 * 1000),
    });

    const event = makeAlertEvent('run_stalled.run-xyz-456');
    await managerAgentHandler({ event, step: mockStep });

    // Should have called restart fetch since window expired
    expect(global.fetch).toHaveBeenCalledOnce();
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/manage/runs/run-xyz-456/restart');

    // Should have updated counter (incrementing past 2 is fine since window reset)
    expect(mockBehaviorAlert.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'alert1' },
        data: expect.objectContaining({
          autoRestartCount: { increment: 1 },
          resolvedAt: expect.any(Date),
        }),
      }),
    );
  });
});

describe('managerAgentHandler — escalate action', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a HumanTask for escalate action', async () => {
    mockDecide.mockReturnValue({ action: 'escalate', reason: 'Error rate too high.' });

    const event = makeAlertEvent('agent_error_rate.JDGenerator');
    await managerAgentHandler({ event, step: mockStep });

    expect(mockHumanTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: expect.stringContaining('Manager escalation'),
          status: 'pending',
        }),
      }),
    );
  });
});

describe('managerAgentHandler — monitor action', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-ops for monitor action (no HumanTask, no fetch)', async () => {
    mockDecide.mockReturnValue({ action: 'monitor', reason: 'Observation only.' });

    const event = makeAlertEvent('agent_error_rate_degraded.Matcher');
    await managerAgentHandler({ event, step: mockStep });

    expect(mockHumanTask.create).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
