// lib/candidate-lock/persistence-port.ts
// Dumb persistence port — writes a LockRecord to CandidateLock in Postgres.
// Zero lock-semantic logic here: no branching on decision, no calls to decide() or rmhr-client.
// The caller is responsible for all business decisions; this port just maps and persists.

import { prisma } from '@/server/db';
import type { LockRecord } from './types';

/** Build the data payload from a LockRecord. Pure mapping — no branching on semantics. */
function toData(record: LockRecord & { lastCheckedAt?: Date }) {
  return {
    candidateId: record.candidateId,
    uploadId: record.uploadId,
    // Non-null schema columns default to '' when the record has no meaningful value.
    clientId: '',
    recruiterId: record.lockOwnerEmployeeId ?? '',
    rmhrResumeId: record.rmhrResumeId,
    lockState: record.lockState,
    blacklisted: record.blacklisted,
    lockOwnerEmployeeId: record.lockOwnerEmployeeId,
    lockByName: record.lockByName,
    lockByEmail: record.lockByEmail,
    lockTime: record.lockTime,
    lockMessage: record.message,
    requestedByEmail: record.requestedByEmail,
    lockDecision: record.decision,
    lockReason: record.reason,
    ...(record.lastCheckedAt !== undefined
      ? { lastCheckedAt: record.lastCheckedAt }
      : {}),
  };
}

/**
 * Persist a pre-computed LockRecord to the CandidateLock table.
 *
 * Strategy: find existing row by (candidateId, rmhrResumeId) — if found, update by id;
 * otherwise create. CandidateLock has no compound @@unique so we cannot use upsert directly.
 */
export async function persistLock(record: LockRecord & { lastCheckedAt?: Date }): Promise<void> {
  // One row per ingestion upload (aligns with the uploadId idempotency guard, and stops
  // fault records — which all have rmhrResumeId=null — from colliding on (candidateId,
  // null)). Fall back to (candidateId, rmhrResumeId) only for records without an uploadId.
  const existing = await prisma.candidateLock.findFirst({
    where: record.uploadId
      ? { uploadId: record.uploadId }
      : { candidateId: record.candidateId, rmhrResumeId: record.rmhrResumeId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  const data = toData(record);

  if (existing) {
    await prisma.candidateLock.update({
      where: { id: existing.id },
      data,
    });
  } else {
    await prisma.candidateLock.create({ data });
  }
}

/**
 * Idempotency-guard lookup (Decision 3): has this ingestion event already been
 * RMHR-checked? Returns the most recent CandidateLock row for the upload, or null.
 * A manual replay of the same upload_id reuses this instead of re-POSTing to RMHR
 * — re-calling on an unlocked candidate would re-lock it (asymmetric idempotency).
 */
export async function findLockByUploadId(uploadId: string): Promise<{
  lockDecision: string | null;
  lockReason: string | null;
  lockOwnerEmployeeId: string | null;
  lockByEmail: string | null;
  rmhrResumeId: string | null;
} | null> {
  if (!uploadId) return null;
  return prisma.candidateLock.findFirst({
    where: { uploadId },
    orderBy: { createdAt: 'desc' },
    select: {
      lockDecision: true,
      lockReason: true,
      lockOwnerEmployeeId: true,
      lockByEmail: true,
      rmhrResumeId: true,
    },
  });
}
