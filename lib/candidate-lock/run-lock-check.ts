// lib/candidate-lock/run-lock-check.ts
//
// Orchestrates the company RMHR lock check at the resume-ingestion seam.
// Ties together: idempotency guard → recruiter-email resolve → resumeSourceId →
// MinIO file fetch → RMHR uploadByRecruiterEmail → classify → decide → persist.
//
// Three INDEPENDENT feature flags (all default OFF → byte-identical to the
// pre-2026-06-08 pipeline):
//   LOCK_CHECK_ENABLED       call RMHR + compute the decision + log  (dark-launch)
//   CANDIDATE_LOCK_PG_WRITE  persist the lock record to CandidateLock
//   LOCK_CHECK_ENFORCE       actually gate downstream (lock-only suppresses RESUME_PROCESSED;
//                            recoverable 故障 parks the run)
//
// Failure policy (design decision #2): a 故障 (infra fault) is STILL a failure —
// its reason is recorded (lockDecision='fault'), it is logged, and it is NEVER
// treated as success or as "unlocked". recruiterEmail is NEVER guessed: an
// unresolvable email is a 故障失败 (email-unresolvable). When enforcing, a
// recoverable fault / unresolvable email THROWS so Inngest parks+retries.

import { getResumeBuffer } from '@/lib/minio';
import { resolveRecruiterEmail } from '@/lib/partner-pg/employee';
import { resolveResumeSourceId } from '@/lib/rmhr/resume-source-map';
import { uploadByRecruiterEmail } from './rmhr-client';
import { classifyRmhr } from './classify';
import { decide } from './decide';
import { persistLock, findLockByUploadId } from './persistence-port';
import type { LockDecision, LockOutcomeReason, LockRecord } from './types';

export interface LockCheckInput {
  candidateId: string;
  uploadId: string;
  employeeId: string | null;
  bucket: string | null;
  objectKey: string | null;
  filename: string;
  sourcingChannelId: string | null;
  clientId: string | null;
  /** false on the legacy parsedFromEvent path — no bytes to upload. */
  hasFileBytes: boolean;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface LockCheckResult {
  decision: LockDecision; // 'proceed' | 'lock-only'
  reason: LockOutcomeReason | 'disabled' | 'no-file' | 'replayed';
  /** true = a 故障失败 was recorded (still a failure, just classified as infra). */
  fault: boolean;
  lockOwnerEmployeeId: string | null;
  lockByEmail: string | null;
  rmhrResumeId: string | null;
}

const flagEnabled = (): boolean => process.env.LOCK_CHECK_ENABLED === '1';
const flagPersist = (): boolean => process.env.CANDIDATE_LOCK_PG_WRITE === '1';
const flagEnforce = (): boolean => process.env.LOCK_CHECK_ENFORCE === '1';

const proceed = (reason: LockCheckResult['reason'], fault = false): LockCheckResult => ({
  decision: 'proceed',
  reason,
  fault,
  lockOwnerEmployeeId: null,
  lockByEmail: null,
  rmhrResumeId: null,
});

export async function runLockCheck(input: LockCheckInput): Promise<LockCheckResult> {
  // Flag off → completely inert (pre-2026-06-08 behavior).
  if (!flagEnabled()) return proceed('disabled');

  // Legacy no-file path / missing transport → nothing to upload to RMHR.
  if (!input.hasFileBytes || !input.bucket || !input.objectKey) return proceed('no-file');

  // Idempotency guard (decision #3): same upload already checked → reuse a REAL verdict,
  // never re-POST (re-POSTing an unlocked candidate would re-lock it — asymmetric
  // idempotency). This guard is a SAFETY mechanism, NOT a best-effort read: if it errors
  // we cannot tell a replay from a first run, so we must NOT blindly re-POST — record a
  // 故障 and (when enforcing) fail the run rather than risk a double-lock.
  let prior: Awaited<ReturnType<typeof findLockByUploadId>>;
  try {
    prior = await findLockByUploadId(input.uploadId);
  } catch (e) {
    input.logger?.warn?.(
      `[lock-check] 故障失败 reason=infra-fault (idempotency-guard read) upload_id=${input.uploadId} — ${(e as Error).message}`,
    );
    await persistFault(input, 'infra-fault', null);
    if (flagEnforce()) {
      throw new Error(
        `[lock-check] idempotency-guard read failed (upload_id=${input.uploadId}) — failing run; candidate NOT processed`,
      );
    }
    return proceed('infra-fault', true);
  }
  // Only a REAL stored verdict short-circuits. A stored 'fault' is NOT a usable verdict
  // (the prior attempt never reached the company) → fall through and (re-)attempt live.
  if (prior && (prior.lockDecision === 'proceed' || prior.lockDecision === 'lock-only')) {
    const decision: LockDecision = prior.lockDecision === 'lock-only' ? 'lock-only' : 'proceed';
    input.logger?.info?.(
      `[lock-check] replay upload_id=${input.uploadId} → reuse stored decision=${decision}`,
    );
    return {
      decision,
      reason: 'replayed',
      fault: false,
      lockOwnerEmployeeId: prior.lockOwnerEmployeeId,
      lockByEmail: prior.lockByEmail,
      rmhrResumeId: prior.rmhrResumeId,
    };
  }

  // Resolve recruiter email — NEVER guess. null → 故障失败 (email-unresolvable).
  const recruiter = await resolveRecruiterEmail(input.employeeId).catch(() => null);
  if (!recruiter) {
    input.logger?.warn?.(
      `[lock-check] 故障失败 reason=email-unresolvable employee_id=${input.employeeId ?? '—'} — NOT guessing email`,
    );
    await persistFault(input, 'email-unresolvable', null);
    if (flagEnforce()) {
      throw new Error(
        `[lock-check] recruiterEmail unresolvable (employee_id=${input.employeeId ?? '—'}, upload_id=${input.uploadId}) — parking; candidate NOT processed`,
      );
    }
    return proceed('email-unresolvable', true);
  }

  const resumeSourceId = resolveResumeSourceId(input.sourcingChannelId);

  // Call RMHR (upload + lock + dedup combined).
  let snapshot;
  try {
    const file = await getResumeBuffer(input.bucket, input.objectKey);
    snapshot = await uploadByRecruiterEmail({
      file,
      filename: input.filename,
      recruiterEmail: recruiter.email,
      resumeSourceId,
    });
  } catch (err) {
    const cls = classifyRmhr(err);
    const reason: 'email-unresolvable' | 'infra-fault' =
      !cls.ok && cls.reason === 'email-unresolvable' ? 'email-unresolvable' : 'infra-fault';
    const recoverable = !cls.ok && cls.reason === 'infra-fault' ? cls.recoverable : false;
    input.logger?.warn?.(
      `[lock-check] 故障失败 reason=${reason} recoverable=${recoverable} — ${(err as Error).message}`,
    );
    // TODO: also call reportDependencyDegraded({provider:'rmhr', ...}) so the monitor
    //       surfaces RMHR 没钱/故障, mirroring the RoboHire path in resume-parser-agent.
    await persistFault(input, reason, recruiter.email);
    // 故障 is a FAILURE — never assume "unlocked". When enforcing, fail the run for ANY
    // fault (recoverable OR not); the agent's retries:0 means this fails rather than
    // auto-retries, and a manual replay re-attempts (a stored fault is never reused).
    if (flagEnforce()) throw err;
    // dark-launch (enabled, not enforcing): record the fault, let the resume flow.
    return proceed(reason, true);
  }

  // Pure gate over the company's current truth.
  const verdict = decide(snapshot, recruiter.email);

  if (flagPersist()) {
    await persistLock({
      candidateId: input.candidateId,
      uploadId: input.uploadId,
      rmhrResumeId: snapshot.rmhrResumeId,
      lockState: snapshot.lockState,
      blacklisted: snapshot.blacklisted,
      lockOwnerEmployeeId: snapshot.lockByEmployeeId,
      lockByName: snapshot.lockByName,
      lockByEmail: snapshot.lockByEmail,
      lockTime: snapshot.lockTime,
      message: snapshot.message,
      requestedByEmail: recruiter.email,
      decision: verdict.decision,
      reason: verdict.reason,
      lastCheckedAt: new Date(),
    }).catch((e) =>
      input.logger?.warn?.(`[lock-check] persistLock failed: ${(e as Error).message}`),
    );
  }

  input.logger?.info?.(
    `[lock-check] candidate=${input.candidateId} decision=${verdict.decision} reason=${verdict.reason} owner=${snapshot.lockByEmail ?? '—'}`,
  );
  return {
    decision: verdict.decision,
    reason: verdict.reason,
    fault: false,
    lockOwnerEmployeeId: snapshot.lockByEmployeeId,
    lockByEmail: snapshot.lockByEmail,
    rmhrResumeId: snapshot.rmhrResumeId,
  };
}

async function persistFault(
  input: LockCheckInput,
  reason: 'email-unresolvable' | 'infra-fault',
  requestedByEmail: string | null,
): Promise<void> {
  if (!flagPersist()) return;
  const record: LockRecord & { lastCheckedAt?: Date } = {
    candidateId: input.candidateId,
    uploadId: input.uploadId,
    rmhrResumeId: null,
    lockState: null,
    blacklisted: false,
    lockOwnerEmployeeId: null,
    lockByName: null,
    lockByEmail: null,
    lockTime: null,
    message: null,
    requestedByEmail,
    decision: 'fault',
    reason,
    lastCheckedAt: new Date(),
  };
  await persistLock(record).catch((e) =>
    input.logger?.warn?.(`[lock-check] persistFault failed: ${(e as Error).message}`),
  );
}
