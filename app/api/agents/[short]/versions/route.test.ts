import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    agentVersion: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
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

vi.mock('@/lib/agent-versions/snapshot', () => ({
  snapshotAgentConfig: vi.fn(),
  hashSnapshot: vi.fn(),
  generateVersionLabel: vi.fn(() => '2026-05-25-1830'),
}));

import { GET, POST } from './route';
import { prisma } from '@/server/db';
import {
  snapshotAgentConfig,
  hashSnapshot,
} from '@/lib/agent-versions/snapshot';

type MockedPrisma = {
  agentVersion: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

const mockPrisma = prisma as unknown as MockedPrisma;
const mockSnapshot = snapshotAgentConfig as unknown as ReturnType<typeof vi.fn>;
const mockHash = hashSnapshot as unknown as ReturnType<typeof vi.fn>;

describe('GET /api/agents/[short]/versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns versions sorted by createdAt desc', async () => {
    mockPrisma.agentVersion.findMany.mockResolvedValue([
      {
        id: 'v2',
        short: 'JDGenerator',
        slug: 'create-jd-agent',
        versionLabel: '2026-05-25-1900',
        status: 'active',
        configJson:
          '{"enabled":true,"temperature":0.7,"maxRetries":null,"tier":null,"maxOutputTokens":null,"promptAppend":null,"skillOverrides":null,"description":null}',
        configHash: 'abc',
        capturedFrom: 'current-config',
        notes: null,
        codeBlob: null,
        codeHash: null,
        specJson: null,
        promptText: null,
        modelUsed: null,
        generatedBy: 'operator-unknown',
        createdAt: new Date('2026-05-25T19:00:00Z'),
        deployedAt: new Date('2026-05-25T19:01:00Z'),
      },
      {
        id: 'v1',
        short: 'JDGenerator',
        slug: 'create-jd-agent',
        versionLabel: '2026-05-25-1800',
        status: 'archived',
        configJson:
          '{"enabled":true,"temperature":0.5,"maxRetries":null,"tier":null,"maxOutputTokens":null,"promptAppend":null,"skillOverrides":null,"description":null}',
        configHash: 'def',
        capturedFrom: 'current-config',
        notes: null,
        codeBlob: null,
        codeHash: null,
        specJson: null,
        promptText: null,
        modelUsed: null,
        generatedBy: 'operator-unknown',
        createdAt: new Date('2026-05-25T18:00:00Z'),
        deployedAt: null,
      },
    ]);

    const req = new Request('http://localhost/api/agents/JDGenerator/versions');
    const res = await GET(req, {
      params: Promise.resolve({ short: 'JDGenerator' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0].id).toBe('v2');
    expect(body.versions[0].configJson).toEqual({
      enabled: true,
      temperature: 0.7,
      maxRetries: null,
      tier: null,
      maxOutputTokens: null,
      promptAppend: null,
      skillOverrides: null,
      description: null,
    });
    expect(body.activeVersionId).toBe('v2');
  });

  it('returns empty list + null activeVersionId when agent has no versions', async () => {
    mockPrisma.agentVersion.findMany.mockResolvedValue([]);
    const req = new Request('http://localhost/api/agents/JDGenerator/versions');
    const res = await GET(req, {
      params: Promise.resolve({ short: 'JDGenerator' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.versions).toEqual([]);
    expect(body.activeVersionId).toBeNull();
  });

  it('returns 404 when short not in AGENT_MAP', async () => {
    const req = new Request('http://localhost/api/agents/Nonexistent/versions');
    const res = await GET(req, {
      params: Promise.resolve({ short: 'Nonexistent' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/agents/[short]/versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures current AgentConfig as a new version', async () => {
    mockSnapshot.mockResolvedValue({
      enabled: true,
      temperature: 0.7,
      maxRetries: 3,
      tier: 'standard',
      maxOutputTokens: 4096,
      promptAppend: null,
      skillOverrides: null,
      description: null,
    });
    mockHash.mockReturnValue('hash123');
    mockPrisma.agentVersion.findFirst.mockResolvedValue(null);
    mockPrisma.agentVersion.create.mockResolvedValue({
      id: 'new-id',
      short: 'JDGenerator',
      slug: 'create-jd-agent',
      versionLabel: '2026-05-25-1830',
      status: 'draft',
      configJson:
        '{"enabled":true,"temperature":0.7,"maxRetries":3,"tier":"standard","maxOutputTokens":4096,"promptAppend":null,"skillOverrides":null,"description":null}',
      configHash: 'hash123',
      capturedFrom: 'current-config',
      notes: null,
      codeBlob: null,
      codeHash: null,
      specJson: null,
      promptText: null,
      modelUsed: null,
      generatedBy: 'operator-unknown',
      createdAt: new Date('2026-05-25T18:30:00Z'),
      deployedAt: null,
    });

    const req = new Request('http://localhost/api/agents/JDGenerator/versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await POST(req, {
      params: Promise.resolve({ short: 'JDGenerator' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.version.versionLabel).toBe('2026-05-25-1830');
    expect(body.version.configJson.temperature).toBe(0.7);
  });

  it('rejects with CONFLICT when same configHash already exists', async () => {
    mockSnapshot.mockResolvedValue({
      enabled: true,
      temperature: 0.7,
      maxRetries: 3,
      tier: 'standard',
      maxOutputTokens: 4096,
      promptAppend: null,
      skillOverrides: null,
      description: null,
    });
    mockHash.mockReturnValue('hash-dup');
    mockPrisma.agentVersion.findFirst.mockResolvedValue({
      id: 'existing',
      versionLabel: 'v0',
    });

    const req = new Request('http://localhost/api/agents/JDGenerator/versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await POST(req, {
      params: Promise.resolve({ short: 'JDGenerator' }),
    });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('CONFLICT');
  });

  it('rejects with NO_CONFIG when no AgentConfig row exists', async () => {
    mockSnapshot.mockResolvedValue(null);

    const req = new Request('http://localhost/api/agents/JDGenerator/versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await POST(req, {
      params: Promise.resolve({ short: 'JDGenerator' }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('NO_CONFIG');
  });

  it('returns 404 when short not in AGENT_MAP', async () => {
    const req = new Request('http://localhost/api/agents/Nonexistent/versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await POST(req, {
      params: Promise.resolve({ short: 'Nonexistent' }),
    });
    expect(res.status).toBe(404);
  });
});
