import { describe, it, expect, beforeEach, vi } from 'vitest';

// Reusable transaction tx mock; populated per test.
const txFns = {
  agentVersion: {
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  agentConfig: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  agentConfigHistory: {
    create: vi.fn(),
  },
};

vi.mock('@/server/db', () => ({
  prisma: {
    agentVersion: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: typeof txFns) => Promise<unknown>) => fn(txFns)),
  },
}));

vi.mock('@/lib/agent-mapping', () => ({
  AGENT_MAP: [
    {
      short: 'JDGenerator',
      wsId: '4',
      stage: 'jd',
      kind: 'auto',
      ownerTeam: 'HSM·交付',
      version: 'v1.9.4',
      triggersEvents: [],
      emitsEvents: [],
      terminal: false,
      inngestName: 'Create JD Agent',
      inngestId: 'create-jd-agent',
    },
  ],
}));

import { POST } from './route';
import { prisma } from '@/server/db';

type MockedPrisma = {
  agentVersion: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
};
const mockPrisma = prisma as unknown as MockedPrisma;

describe('POST /api/agents/[short]/versions/[id]/deploy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txFns.agentVersion.update.mockReset();
    txFns.agentVersion.updateMany.mockReset();
    txFns.agentConfig.findUnique.mockReset();
    txFns.agentConfig.upsert.mockReset();
    txFns.agentConfigHistory.create.mockReset();
  });

  it('demotes current active + activates target + upserts AgentConfig + writes history', async () => {
    mockPrisma.agentVersion.findUnique.mockResolvedValue({
      id: 'v-target',
      short: 'JDGenerator',
      slug: 'create-jd-agent',
      versionLabel: 'v-target-label',
      status: 'draft',
      configJson: JSON.stringify({
        enabled: true,
        temperature: 0.4,
        maxRetries: 1,
        tier: 'lite',
        maxOutputTokens: 2048,
        promptAppend: 'short',
        skillOverrides: null,
        description: null,
      }),
      configHash: 'h-target',
      capturedFrom: 'current-config',
      notes: null,
      codeBlob: null,
      codeHash: null,
      specJson: null,
      promptText: null,
      modelUsed: null,
      generatedBy: 'operator-unknown',
      createdAt: new Date('2026-05-20T10:00:00Z'),
      deployedAt: null,
    });
    mockPrisma.agentVersion.findFirst.mockResolvedValue({
      id: 'v-currently-active',
      versionLabel: 'v-current',
    });
    txFns.agentConfig.findUnique.mockResolvedValue({
      id: 'create-jd-agent',
      enabled: true,
      temperature: 0.7,
      maxRetries: 3,
      tier: 'standard',
      maxOutputTokens: 4096,
      promptAppend: null,
      skillOverrides: null,
      description: null,
    });
    txFns.agentConfig.upsert.mockResolvedValue({
      id: 'create-jd-agent',
      enabled: true,
      temperature: 0.4,
      maxRetries: 1,
      tier: 'lite',
      maxOutputTokens: 2048,
      promptAppend: 'short',
      skillOverrides: null,
      description: null,
    });
    txFns.agentVersion.update.mockResolvedValue({
      id: 'v-target',
      short: 'JDGenerator',
      slug: 'create-jd-agent',
      versionLabel: 'v-target-label',
      status: 'active',
      configJson:
        '{"enabled":true,"temperature":0.4,"maxRetries":1,"tier":"lite","maxOutputTokens":2048,"promptAppend":"short","skillOverrides":null,"description":null}',
      configHash: 'h-target',
      capturedFrom: 'current-config',
      notes: null,
      codeBlob: null,
      codeHash: null,
      specJson: null,
      promptText: null,
      modelUsed: null,
      generatedBy: 'operator-unknown',
      createdAt: new Date('2026-05-20T10:00:00Z'),
      deployedAt: new Date('2026-05-25T19:00:00Z'),
    });
    txFns.agentVersion.updateMany.mockResolvedValue({ count: 1 });
    txFns.agentConfigHistory.create.mockResolvedValue({});

    const req = new Request(
      'http://localhost/api/agents/JDGenerator/versions/v-target/deploy',
      { method: 'POST' },
    );
    const res = await POST(req, {
      params: Promise.resolve({ short: 'JDGenerator', id: 'v-target' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.previousActiveId).toBe('v-currently-active');
    expect(body.version.status).toBe('active');
    expect(body.version.id).toBe('v-target');

    // AgentConfig 用了快照覆盖
    expect(txFns.agentConfig.upsert.mock.calls[0][0].update.temperature).toBe(0.4);
    // History 写了一行
    expect(txFns.agentConfigHistory.create).toHaveBeenCalled();
    // 旧 active 被 demote
    expect(txFns.agentVersion.updateMany.mock.calls[0][0].data.status).toBe('archived');
  });

  it('returns 404 when version id not found', async () => {
    mockPrisma.agentVersion.findUnique.mockResolvedValue(null);
    const req = new Request(
      'http://localhost/api/agents/JDGenerator/versions/no-such/deploy',
      { method: 'POST' },
    );
    const res = await POST(req, {
      params: Promise.resolve({ short: 'JDGenerator', id: 'no-such' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when version belongs to a different short', async () => {
    mockPrisma.agentVersion.findUnique.mockResolvedValue({
      id: 'v-other',
      short: 'SomeOtherAgent',
      slug: 'foo',
      versionLabel: 'x',
      status: 'draft',
      configJson:
        '{"enabled":true,"temperature":0.4,"maxRetries":1,"tier":"lite","maxOutputTokens":2048,"promptAppend":null,"skillOverrides":null,"description":null}',
      configHash: 'h',
      capturedFrom: 'current-config',
      notes: null,
      codeBlob: null,
      codeHash: null,
      specJson: null,
      promptText: null,
      modelUsed: null,
      generatedBy: 'operator-unknown',
      createdAt: new Date('2026-05-20T10:00:00Z'),
      deployedAt: null,
    });
    const req = new Request(
      'http://localhost/api/agents/JDGenerator/versions/v-other/deploy',
      { method: 'POST' },
    );
    const res = await POST(req, {
      params: Promise.resolve({ short: 'JDGenerator', id: 'v-other' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when short not in AGENT_MAP', async () => {
    const req = new Request(
      'http://localhost/api/agents/NotAReal/versions/x/deploy',
      { method: 'POST' },
    );
    const res = await POST(req, {
      params: Promise.resolve({ short: 'NotAReal', id: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});
