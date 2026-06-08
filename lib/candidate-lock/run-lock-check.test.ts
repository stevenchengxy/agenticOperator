// lib/candidate-lock/run-lock-check.test.ts
//
// Integration-style unit tests for runLockCheck orchestrator.
// Mocks: minio, partner-pg/employee, rmhr/resume-source-map, ./rmhr-client (fn only),
//        ./persistence-port.
// Real (NOT mocked): ./decide, ./classify — both pure functions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LockState } from './types';

// ---------------------------------------------------------------------------
// vi.hoisted: declare mock fns before module hoisting
// ---------------------------------------------------------------------------
const {
  mockGetResumeBuffer,
  mockResolveRecruiterEmail,
  mockResolveResumeSourceId,
  mockUploadByRecruiterEmail,
  mockPersistLock,
  mockFindLockByUploadId,
} = vi.hoisted(() => ({
  mockGetResumeBuffer: vi.fn(),
  mockResolveRecruiterEmail: vi.fn(),
  mockResolveResumeSourceId: vi.fn(),
  mockUploadByRecruiterEmail: vi.fn(),
  mockPersistLock: vi.fn(),
  mockFindLockByUploadId: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (hoisted automatically by vitest)
// ---------------------------------------------------------------------------

vi.mock('@/lib/minio', () => ({
  getResumeBuffer: mockGetResumeBuffer,
}));

vi.mock('@/lib/partner-pg/employee', () => ({
  resolveRecruiterEmail: mockResolveRecruiterEmail,
}));

vi.mock('@/lib/rmhr/resume-source-map', () => ({
  resolveResumeSourceId: mockResolveResumeSourceId,
  DEFAULT_RESUME_SOURCE_ID: '02001034',
}));

// Partial mock of rmhr-client: keep RmhrApiError real, mock uploadByRecruiterEmail only.
vi.mock('./rmhr-client', async (orig) => {
  const real = await orig<typeof import('./rmhr-client')>();
  return {
    ...real,
    uploadByRecruiterEmail: mockUploadByRecruiterEmail,
  };
});

vi.mock('./persistence-port', () => ({
  persistLock: mockPersistLock,
  findLockByUploadId: mockFindLockByUploadId,
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks are wired.
// ---------------------------------------------------------------------------
import { runLockCheck, type LockCheckInput } from './run-lock-check';
import { RmhrApiError } from './rmhr-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid LockCheckInput with sane defaults. Override any field as needed. */
function makeInput(overrides: Partial<LockCheckInput> = {}): LockCheckInput {
  return {
    candidateId: 'cand-test-001',
    uploadId: 'upl-test-001',
    employeeId: 'emp-42',
    bucket: 'resumes',
    objectKey: 'resumes/cand-test-001.pdf',
    filename: 'resume.pdf',
    sourcingChannelId: 'boss直聘-ai',
    clientId: 'client-xyz',
    hasFileBytes: true,
    ...overrides,
  };
}

/** A snapshot returned when RMHR says LOCKED (lockState=2) by someone else. */
const snapshotLockedByOther = {
  rmhrResumeId: 'r9',
  lockState: LockState.LOCKED,
  blacklisted: false,
  lockByEmployeeId: 'e9',
  lockByName: '王五',
  lockByEmail: 'other@co.com',
  lockTime: '2026-06-08 10:00:00',
  message: null,
};

/** A snapshot returned when RMHR says LOCKED (lockState=2) by the uploader. */
const snapshotLockedByMe = {
  ...snapshotLockedByOther,
  lockByEmail: 'me@co.com',
  lockByEmployeeId: 'emp-42',
};

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  // Reset all mock call history + return values.
  vi.clearAllMocks();

  // Save the three flags.
  savedEnv = {
    LOCK_CHECK_ENABLED: process.env.LOCK_CHECK_ENABLED,
    CANDIDATE_LOCK_PG_WRITE: process.env.CANDIDATE_LOCK_PG_WRITE,
    LOCK_CHECK_ENFORCE: process.env.LOCK_CHECK_ENFORCE,
  };

  // Default: all flags OFF (safest baseline).
  delete process.env.LOCK_CHECK_ENABLED;
  delete process.env.CANDIDATE_LOCK_PG_WRITE;
  delete process.env.LOCK_CHECK_ENFORCE;

  // Default mock returns — override per test as needed.
  mockGetResumeBuffer.mockResolvedValue(Buffer.from('pdf'));
  mockResolveResumeSourceId.mockReturnValue('02001034');
  mockFindLockByUploadId.mockResolvedValue(null);
  mockPersistLock.mockResolvedValue(undefined);
});

afterEach(() => {
  // Restore original env values.
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('runLockCheck', () => {
  // ── Case 1: Flag off ──────────────────────────────────────────────────────
  it('1. flag off → proceed/disabled; RMHR and recruiter email NOT called', async () => {
    // LOCK_CHECK_ENABLED is unset by default in beforeEach.
    const result = await runLockCheck(makeInput());

    expect(result.decision).toBe('proceed');
    expect(result.reason).toBe('disabled');
    expect(result.fault).toBe(false);

    expect(mockUploadByRecruiterEmail).not.toHaveBeenCalled();
    expect(mockResolveRecruiterEmail).not.toHaveBeenCalled();
  });

  // ── Case 2: No file bytes ─────────────────────────────────────────────────
  it('2. enabled but hasFileBytes:false → proceed/no-file; RMHR NOT called', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';

    const result = await runLockCheck(makeInput({ hasFileBytes: false }));

    expect(result.decision).toBe('proceed');
    expect(result.reason).toBe('no-file');
    expect(result.fault).toBe(false);

    expect(mockUploadByRecruiterEmail).not.toHaveBeenCalled();
  });

  it('2b. enabled but bucket null → proceed/no-file; RMHR NOT called', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';

    const result = await runLockCheck(makeInput({ bucket: null }));

    expect(result.decision).toBe('proceed');
    expect(result.reason).toBe('no-file');

    expect(mockUploadByRecruiterEmail).not.toHaveBeenCalled();
  });

  // ── Case 3: Idempotency replay ────────────────────────────────────────────
  it('3. enabled, hasFileBytes true, prior lock record found → replay stored decision', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';

    mockFindLockByUploadId.mockResolvedValue({
      lockDecision: 'lock-only',
      lockReason: 'locked-by-other',
      lockOwnerEmployeeId: 'x',
      lockByEmail: 'x@x.com',
      rmhrResumeId: 'r1',
    });

    const result = await runLockCheck(makeInput());

    expect(result.decision).toBe('lock-only');
    expect(result.reason).toBe('replayed');
    expect(result.fault).toBe(false); // lockDecision !== 'fault'
    expect(result.lockOwnerEmployeeId).toBe('x');
    expect(result.lockByEmail).toBe('x@x.com');
    expect(result.rmhrResumeId).toBe('r1');

    // RMHR must NOT be re-called (asymmetric idempotency).
    expect(mockUploadByRecruiterEmail).not.toHaveBeenCalled();
  });

  it('3b. replayed with proceed prior → decision:proceed, reason:replayed', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';

    mockFindLockByUploadId.mockResolvedValue({
      lockDecision: 'proceed',
      lockReason: 'owned-by-uploader',
      lockOwnerEmployeeId: null,
      lockByEmail: 'me@co.com',
      rmhrResumeId: 'r2',
    });

    const result = await runLockCheck(makeInput());

    expect(result.decision).toBe('proceed');
    expect(result.reason).toBe('replayed');
    expect(mockUploadByRecruiterEmail).not.toHaveBeenCalled();
  });

  it('3c. prior is a stored FAULT → NOT reused; re-attempts the live check', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';

    mockFindLockByUploadId.mockResolvedValue({
      lockDecision: 'fault',
      lockReason: 'infra-fault',
      lockOwnerEmployeeId: null,
      lockByEmail: null,
      rmhrResumeId: null,
    });
    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '李四' });
    mockUploadByRecruiterEmail.mockResolvedValue(snapshotLockedByMe);

    const result = await runLockCheck(makeInput());

    // A stored fault is NOT a usable verdict → fall through and re-attempt live.
    expect(result.reason).not.toBe('replayed');
    expect(result.decision).toBe('proceed');
    expect(result.reason).toBe('owned-by-uploader');
    expect(mockUploadByRecruiterEmail).toHaveBeenCalledOnce();
  });

  // ── Case 4: Email unresolvable, NOT enforcing ─────────────────────────────
  it('4. email unresolvable, enforce off → proceed/email-unresolvable, fault:true; RMHR NOT called', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';
    // LOCK_CHECK_ENFORCE is off (unset).

    mockResolveRecruiterEmail.mockResolvedValue(null);

    const result = await runLockCheck(makeInput());

    expect(result.decision).toBe('proceed');
    expect(result.reason).toBe('email-unresolvable');
    expect(result.fault).toBe(true);

    expect(mockUploadByRecruiterEmail).not.toHaveBeenCalled();
  });

  // ── Case 5: Email unresolvable, enforcing ────────────────────────────────
  it('5. email unresolvable, enforce on → THROWS (parks)', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';
    process.env.LOCK_CHECK_ENFORCE = '1';

    mockResolveRecruiterEmail.mockResolvedValue(null);

    await expect(runLockCheck(makeInput())).rejects.toThrow(
      /recruiterEmail unresolvable/,
    );

    expect(mockUploadByRecruiterEmail).not.toHaveBeenCalled();
  });

  // ── Case 6: RMHR success, locked by other ────────────────────────────────
  it('6. RMHR success, LOCKED by other → lock-only/locked-by-other, fault:false', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';

    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '张三' });
    mockUploadByRecruiterEmail.mockResolvedValue(snapshotLockedByOther);

    const result = await runLockCheck(makeInput());

    // Real decide() → locked-by-other (lockByEmail !== 'me@co.com')
    expect(result.decision).toBe('lock-only');
    expect(result.reason).toBe('locked-by-other');
    expect(result.fault).toBe(false);
    expect(result.lockByEmail).toBe('other@co.com');
    expect(result.lockOwnerEmployeeId).toBe('e9');
    expect(result.rmhrResumeId).toBe('r9');
  });

  // ── Case 7: RMHR success, owned by me ────────────────────────────────────
  it('7. RMHR success, LOCKED by me → proceed/owned-by-uploader', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';

    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '李四' });
    mockUploadByRecruiterEmail.mockResolvedValue(snapshotLockedByMe);

    const result = await runLockCheck(makeInput());

    // Real decide() → owned-by-uploader
    expect(result.decision).toBe('proceed');
    expect(result.reason).toBe('owned-by-uploader');
    expect(result.fault).toBe(false);
    expect(result.lockByEmail).toBe('me@co.com');
  });

  // ── Case 8: RMHR recoverable fault ───────────────────────────────────────
  it('8a. RMHR NETWORK error, enforce on → THROWS (parks)', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';
    process.env.LOCK_CHECK_ENFORCE = '1';

    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '招聘员' });
    mockUploadByRecruiterEmail.mockRejectedValue(new RmhrApiError('NETWORK', 'down'));

    await expect(runLockCheck(makeInput())).rejects.toThrow();
  });

  it('8b. RMHR NETWORK error, enforce off → proceed/infra-fault, fault:true; does NOT throw', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';
    // LOCK_CHECK_ENFORCE unset.

    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '招聘员' });
    mockUploadByRecruiterEmail.mockRejectedValue(new RmhrApiError('NETWORK', 'down'));

    const result = await runLockCheck(makeInput());

    expect(result.decision).toBe('proceed');
    expect(result.reason).toBe('infra-fault');
    expect(result.fault).toBe(true);
  });

  it('8c. RMHR non-recoverable (CLIENT) error, enforce on → THROWS (no silent proceed-as-unlocked)', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';
    process.env.LOCK_CHECK_ENFORCE = '1';

    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '招聘员' });
    mockUploadByRecruiterEmail.mockRejectedValue(new RmhrApiError('CLIENT', 'bad creds', 400));

    await expect(runLockCheck(makeInput())).rejects.toThrow();
  });

  // ── Case 9: Persist on vs off ────────────────────────────────────────────
  it('9a. persist ON + success snapshot → persistLock called once with correct fields', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';
    process.env.CANDIDATE_LOCK_PG_WRITE = '1';

    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '李四' });
    mockUploadByRecruiterEmail.mockResolvedValue(snapshotLockedByMe);

    const input = makeInput({ candidateId: 'cand-99', uploadId: 'upl-99' });
    await runLockCheck(input);

    expect(mockPersistLock).toHaveBeenCalledOnce();

    const record = mockPersistLock.mock.calls[0][0];
    expect(record.candidateId).toBe('cand-99');
    expect(record.uploadId).toBe('upl-99');
    expect(record.decision).toBe('proceed');
    expect(record.reason).toBe('owned-by-uploader');
  });

  it('9b. persist OFF → persistLock NOT called', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';
    // CANDIDATE_LOCK_PG_WRITE unset.

    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '李四' });
    mockUploadByRecruiterEmail.mockResolvedValue(snapshotLockedByMe);

    await runLockCheck(makeInput());

    expect(mockPersistLock).not.toHaveBeenCalled();
  });

  // ── Additional coverage: FREE lock state ──────────────────────────────────
  it('RMHR returns FREE → decide → proceed/newly-locked', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';

    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '新人' });
    mockUploadByRecruiterEmail.mockResolvedValue({
      rmhrResumeId: 'r-free',
      lockState: LockState.FREE,
      blacklisted: false,
      lockByEmployeeId: null,
      lockByName: null,
      lockByEmail: null,
      lockTime: null,
      message: null,
    });

    const result = await runLockCheck(makeInput());

    expect(result.decision).toBe('proceed');
    expect(result.reason).toBe('newly-locked');
    expect(result.fault).toBe(false);
  });

  // ── resolveResumeSourceId is called with the sourcingChannelId ─────────────
  it('passes sourcingChannelId to resolveResumeSourceId', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';

    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '李四' });
    mockUploadByRecruiterEmail.mockResolvedValue(snapshotLockedByMe);

    const input = makeInput({ sourcingChannelId: 'boss直聘-ai' });
    await runLockCheck(input);

    expect(mockResolveResumeSourceId).toHaveBeenCalledWith('boss直聘-ai');
  });

  // ── getResumeBuffer is called with the right bucket/objectKey ─────────────
  it('fetches resume buffer from minio with correct bucket+objectKey', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';

    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '李四' });
    mockUploadByRecruiterEmail.mockResolvedValue(snapshotLockedByMe);

    const input = makeInput({ bucket: 'my-bucket', objectKey: 'path/to/file.pdf' });
    await runLockCheck(input);

    expect(mockGetResumeBuffer).toHaveBeenCalledWith('my-bucket', 'path/to/file.pdf');
  });

  // ── idempotency-guard read failure → NOT swallowed; recorded as a fault, no blind re-POST ──
  it('guard read failure, enforce off → proceed/infra-fault, fault:true; RMHR NOT re-called', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';

    mockFindLockByUploadId.mockRejectedValue(new Error('DB timeout'));
    mockResolveRecruiterEmail.mockResolvedValue({ email: 'me@co.com', name: '李四' });
    mockUploadByRecruiterEmail.mockResolvedValue(snapshotLockedByMe);

    const result = await runLockCheck(makeInput());

    // The guard is a safety mechanism — a read error must NOT be treated as "no prior"
    // and must NOT trigger a blind re-POST (asymmetric idempotency).
    expect(result.decision).toBe('proceed');
    expect(result.reason).toBe('infra-fault');
    expect(result.fault).toBe(true);
    expect(mockUploadByRecruiterEmail).not.toHaveBeenCalled();
  });

  it('guard read failure, enforce on → THROWS (fails the run); RMHR NOT called', async () => {
    process.env.LOCK_CHECK_ENABLED = '1';
    process.env.LOCK_CHECK_ENFORCE = '1';

    mockFindLockByUploadId.mockRejectedValue(new Error('DB timeout'));

    await expect(runLockCheck(makeInput())).rejects.toThrow(/idempotency-guard read failed/);
    expect(mockUploadByRecruiterEmail).not.toHaveBeenCalled();
  });
});
