// lib/candidate-lock/types.ts
// Vendor-agnostic candidate-lock vocabulary. No IO, no imports from rmhr-client.

/** RMHR lockState scale — the literal 1/2/3 ONLY. Blacklist is a SEPARATE branch. */
export enum LockState {
  FREE = 1,
  LOCKED = 2,
  PROTECTED = 3,
}

/** Normalized result of one RMHR uploadByRecruiterEmail call (model parsed). */
export interface LockSnapshot {
  rmhrResumeId: string;          // model.resumeId, stringified — cross-system correlation key
  lockState: LockState;
  blacklisted: boolean;          // company dedup returned a blacklist branch
  lockByEmployeeId: string | null;  // model.lockBy (工号)
  lockByName: string | null;
  lockByEmail: string | null;    // model.lockByEmail — the comparison key
  lockTime: string | null;       // model.lockTime RAW "yyyy-MM-dd HH:mm:ss" (NOT coerced to Date)
  message: string | null;
}

/** Pure gate verdict over a SUCCESSFUL snapshot. 'park'/'fail' come from the error path, not decide(). */
export type LockDecision = 'proceed' | 'lock-only';

/** Why the lock-check step ended — recorded on every attempt. */
export type LockOutcomeReason =
  | 'owned-by-uploader'       // proceed
  | 'newly-locked'            // proceed (was FREE)
  | 'locked-by-other'         // 业务: lock-only
  | 'protected'               // 业务: lock-only
  | 'blacklisted'             // 业务: lock-only
  | 'infra-fault'             // 故障失败 (recorded as failure)
  | 'email-unresolvable';     // 故障失败 (data problem, recorded as failure)

/** What the dumb persistence port writes. Pre-computed; port does NOT derive anything. */
export interface LockRecord {
  candidateId: string;
  rmhrResumeId: string | null;
  lockState: number | null;        // LockState numeric, or null when no successful snapshot
  blacklisted: boolean;
  lockOwnerEmployeeId: string | null;
  lockByName: string | null;
  lockByEmail: string | null;
  lockTime: string | null;         // RAW string
  message: string | null;
  requestedByEmail: string | null; // who WE tried to lock under (distinct from owner)
  decision: LockDecision | 'fault';
  reason: LockOutcomeReason;
}
