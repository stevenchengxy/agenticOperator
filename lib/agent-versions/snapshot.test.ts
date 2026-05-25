import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  snapshotAgentConfig,
  hashSnapshot,
  generateVersionLabel,
} from './snapshot';
import type { AgentConfigSnapshot } from './types';

vi.mock('@/server/db', () => ({
  prisma: {
    agentConfig: {
      findUnique: vi.fn(),
    },
  },
}));

describe('snapshotAgentConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns AgentConfigSnapshot when AgentConfig exists', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.agentConfig.findUnique as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'create-jd-agent',
      enabled: true,
      temperature: 0.7,
      maxRetries: 3,
      tier: 'standard',
      maxOutputTokens: 4096,
      promptAppend: 'be concise',
      skillOverrides: null,
      description: 'JD generator',
    });

    const snap = await snapshotAgentConfig('create-jd-agent');
    expect(snap).toEqual({
      enabled: true,
      temperature: 0.7,
      maxRetries: 3,
      tier: 'standard',
      maxOutputTokens: 4096,
      promptAppend: 'be concise',
      skillOverrides: null,
      description: 'JD generator',
    });
  });

  it('returns null when AgentConfig row does not exist', async () => {
    const { prisma } = await import('@/server/db');
    (prisma.agentConfig.findUnique as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const snap = await snapshotAgentConfig('nonexistent-agent');
    expect(snap).toBeNull();
  });
});

describe('hashSnapshot', () => {
  it('produces a stable hash for the same snapshot', () => {
    const snap: AgentConfigSnapshot = {
      enabled: true,
      temperature: 0.5,
      maxRetries: 2,
      tier: 'lite',
      maxOutputTokens: null,
      promptAppend: null,
      skillOverrides: null,
      description: null,
    };
    expect(hashSnapshot(snap)).toEqual(hashSnapshot(snap));
  });

  it('produces a different hash when snapshot differs', () => {
    const a: AgentConfigSnapshot = {
      enabled: true,
      temperature: 0.5,
      maxRetries: 2,
      tier: 'lite',
      maxOutputTokens: null,
      promptAppend: null,
      skillOverrides: null,
      description: null,
    };
    const b = { ...a, temperature: 0.6 };
    expect(hashSnapshot(a)).not.toEqual(hashSnapshot(b));
  });

  it('is independent of object key ordering', () => {
    const a: AgentConfigSnapshot = {
      enabled: true,
      temperature: 0.5,
      maxRetries: 2,
      tier: 'lite',
      maxOutputTokens: null,
      promptAppend: null,
      skillOverrides: null,
      description: null,
    };
    // Same object constructed with different key order
    const b: AgentConfigSnapshot = {
      description: null,
      skillOverrides: null,
      promptAppend: null,
      maxOutputTokens: null,
      tier: 'lite',
      maxRetries: 2,
      temperature: 0.5,
      enabled: true,
    };
    expect(hashSnapshot(a)).toEqual(hashSnapshot(b));
  });
});

describe('generateVersionLabel', () => {
  it('returns a label in YYYY-MM-DD-HHMM format', () => {
    const fixed = new Date('2026-05-25T18:30:00Z');
    const label = generateVersionLabel(fixed);
    expect(label).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
  });

  it('uses UTC components', () => {
    const fixed = new Date('2026-05-25T18:30:00Z');
    const label = generateVersionLabel(fixed);
    expect(label).toBe('2026-05-25-1830');
  });
});
