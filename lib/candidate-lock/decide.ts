// lib/candidate-lock/decide.ts
import { LockState, type LockSnapshot, type LockDecision, type LockOutcomeReason } from './types';

export function normalizeEmail(e: string | null | undefined): string {
  return (e ?? '').trim().toLowerCase();
}

/** Pure gate over a SUCCESSFUL snapshot. Caller handles 故障/park separately. */
export function decide(
  snap: LockSnapshot,
  recruiterEmail: string,
): { decision: LockDecision; reason: LockOutcomeReason } {
  if (snap.blacklisted) return { decision: 'lock-only', reason: 'blacklisted' };
  if (snap.lockState === LockState.PROTECTED) return { decision: 'lock-only', reason: 'protected' };
  if (snap.lockState === LockState.FREE) return { decision: 'proceed', reason: 'newly-locked' };
  // LOCKED
  const recruiter = normalizeEmail(recruiterEmail);
  const mine = recruiter !== '' && normalizeEmail(snap.lockByEmail) === recruiter;
  return mine
    ? { decision: 'proceed', reason: 'owned-by-uploader' }
    : { decision: 'lock-only', reason: 'locked-by-other' };
}
