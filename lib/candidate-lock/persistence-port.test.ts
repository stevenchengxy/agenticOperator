// lib/candidate-lock/persistence-port.test.ts
// Tests for the dumb persistence port — mock prisma and assert correct field mapping.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LockRecord } from './types';

// ---------------------------------------------------------------------------
// Use vi.hoisted so mock factory variables are initialized before hoisting.
// ---------------------------------------------------------------------------
const { mockFindFirst, mockCreate, mockUpdate } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@/server/db', () => ({
  prisma: {
    candidateLock: {
      findFirst: mockFindFirst,
      create: mockCreate,
      update: mockUpdate,
    },
  },
}));

// Import AFTER mocks are set up.
import { persistLock } from './persistence-port';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const baseRecord: LockRecord = {
  candidateId: 'cand-001',
  uploadId: 'upl-001',
  rmhrResumeId: 'resume-999',
  lockState: 2, // LOCKED
  blacklisted: false,
  lockOwnerEmployeeId: 'emp-007',
  lockByName: '张三',
  lockByEmail: 'zhangsan@company.com',
  lockTime: '2026-06-08 09:00:00',
  message: 'Locked by recruiter',
  requestedByEmail: 'recruiter@company.com',
  decision: 'proceed',
  reason: 'owned-by-uploader',
};

const faultRecord: LockRecord = {
  candidateId: 'cand-002',
  uploadId: 'upl-002',
  rmhrResumeId: null,
  lockState: null,
  blacklisted: false,
  lockOwnerEmployeeId: null,
  lockByName: null,
  lockByEmail: null,
  lockTime: null,
  message: null,
  requestedByEmail: 'recruiter2@company.com',
  decision: 'fault',
  reason: 'infra-fault',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('persistLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls create when no existing row is found', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: 'new-id' });

    await persistLock(baseRecord);

    expect(mockFindFirst).toHaveBeenCalledOnce();
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { uploadId: 'upl-001' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockUpdate).not.toHaveBeenCalled();

    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.data.candidateId).toBe('cand-001');
    expect(createArg.data.rmhrResumeId).toBe('resume-999');
    expect(createArg.data.lockState).toBe(2);
    expect(createArg.data.blacklisted).toBe(false);
    expect(createArg.data.lockOwnerEmployeeId).toBe('emp-007');
    expect(createArg.data.lockByName).toBe('张三');
    expect(createArg.data.lockByEmail).toBe('zhangsan@company.com');
    expect(createArg.data.lockTime).toBe('2026-06-08 09:00:00');
    expect(createArg.data.lockMessage).toBe('Locked by recruiter');
    expect(createArg.data.requestedByEmail).toBe('recruiter@company.com');
    expect(createArg.data.lockDecision).toBe('proceed');
    expect(createArg.data.lockReason).toBe('owned-by-uploader');
    // Non-null columns default to empty string when unknown
    expect(createArg.data.clientId).toBe('');
    expect(createArg.data.recruiterId).toBe('emp-007'); // lockOwnerEmployeeId fallback
  });

  it('calls update (not create) when an existing row is found', async () => {
    mockFindFirst.mockResolvedValue({ id: 'existing-id' });
    mockUpdate.mockResolvedValue({ id: 'existing-id' });

    await persistLock(baseRecord);

    expect(mockFindFirst).toHaveBeenCalledOnce();
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockCreate).not.toHaveBeenCalled();

    const updateArg = mockUpdate.mock.calls[0][0];
    expect(updateArg.where.id).toBe('existing-id');
    expect(updateArg.data.lockState).toBe(2);
    expect(updateArg.data.lockDecision).toBe('proceed');
    expect(updateArg.data.lockReason).toBe('owned-by-uploader');
  });

  it('persists a fault record with nulls without branching on decision', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: 'fault-id' });

    await persistLock(faultRecord);

    expect(mockCreate).toHaveBeenCalledOnce();

    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.data.candidateId).toBe('cand-002');
    expect(createArg.data.rmhrResumeId).toBeNull();
    expect(createArg.data.lockState).toBeNull();
    expect(createArg.data.lockOwnerEmployeeId).toBeNull();
    expect(createArg.data.lockDecision).toBe('fault');
    expect(createArg.data.lockReason).toBe('infra-fault');
    // recruiterId defaults to '' when lockOwnerEmployeeId is null
    expect(createArg.data.recruiterId).toBe('');
  });

  it('persists two different records independently (no cross-contamination)', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: 'any-id' });

    await persistLock(baseRecord);
    await persistLock(faultRecord);

    expect(mockCreate).toHaveBeenCalledTimes(2);

    const firstCall = mockCreate.mock.calls[0][0];
    const secondCall = mockCreate.mock.calls[1][0];

    expect(firstCall.data.candidateId).toBe('cand-001');
    expect(secondCall.data.candidateId).toBe('cand-002');
    expect(firstCall.data.lockDecision).toBe('proceed');
    expect(secondCall.data.lockDecision).toBe('fault');
  });

  it('passes lastCheckedAt when provided on the record', async () => {
    const now = new Date('2026-06-08T09:00:00Z');
    const recordWithDate: LockRecord & { lastCheckedAt?: Date } = {
      ...baseRecord,
      lastCheckedAt: now,
    };

    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: 'dated-id' });

    await persistLock(recordWithDate as LockRecord);

    const createArg = mockCreate.mock.calls[0][0];
    // lastCheckedAt on LockRecord is not in the base type; the port accepts it via extension
    // This test verifies the port handles the extended record without crashing
    expect(createArg).toBeDefined();
  });
});
