import { createHash } from 'node:crypto';
import { prisma } from '@/server/db';
import type { AgentConfigSnapshot } from './types';

/**
 * Snapshot the current AgentConfig row into a plain JSON object.
 * Returns null when no AgentConfig row exists for that agentId (slug).
 *
 * agentId here = Inngest function id (e.g. 'create-jd-agent'),
 * which is the primary key of AgentConfig.
 */
export async function snapshotAgentConfig(
  agentId: string,
): Promise<AgentConfigSnapshot | null> {
  const row = await prisma.agentConfig.findUnique({
    where: { id: agentId },
    select: {
      enabled: true,
      temperature: true,
      maxRetries: true,
      tier: true,
      maxOutputTokens: true,
      promptAppend: true,
      skillOverrides: true,
      description: true,
    },
  });
  if (!row) return null;
  return {
    enabled: row.enabled,
    temperature: row.temperature,
    maxRetries: row.maxRetries,
    tier: row.tier,
    maxOutputTokens: row.maxOutputTokens,
    promptAppend: row.promptAppend,
    skillOverrides: row.skillOverrides,
    description: row.description,
  };
}

/**
 * Stable hash of an AgentConfigSnapshot, sorting keys so equivalent
 * snapshots with different key orderings produce the same hash.
 */
export function hashSnapshot(snap: AgentConfigSnapshot): string {
  const sorted = Object.keys(snap)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (snap as unknown as Record<string, unknown>)[k];
      return acc;
    }, {});
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Auto-generate a version label from a date. Format: YYYY-MM-DD-HHMM
 * (UTC). Used when operator does not supply an explicit label.
 */
export function generateVersionLabel(when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = when.getUTCFullYear();
  const m = pad(when.getUTCMonth() + 1);
  const d = pad(when.getUTCDate());
  const hh = pad(when.getUTCHours());
  const mm = pad(when.getUTCMinutes());
  return `${y}-${m}-${d}-${hh}${mm}`;
}
