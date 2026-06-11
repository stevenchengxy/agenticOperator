// Ownership engine — decide whether a recruiter may claim a candidate, or whether it's
// an ownership conflict (lock-only). Rule-data-driven (rules-data.ts ownershipRules):
//   - OWN-TENCENT-1 (客户关系归属保护): when present AND client is 腾讯 AND the candidate
//     already has a 腾讯 customer relationship, it is AUTHORITATIVE (优先于普通锁定) —
//     only the original owner may claim; anyone else is a conflict.
//   - OWN-LOCK-1 (锁定归属): the standard lock gate — blacklist / PROTECTED / locked-by-
//     other → conflict; FREE / locked-by-self → proceed. Mirrors lib/candidate-lock
//     decide() semantics.
// Removing a rule from rules.json disables that behavior (no code change) — P0.

import { LockState } from '@/lib/candidate-lock/types';
import { normalizeEmail } from './field-normalize';
import type { OwnershipRule } from './rules-data';

export interface OwnershipContext {
  /** 1 FREE | 2 LOCKED | 3 PROTECTED (RMHR scale; see candidate-lock/types). */
  lockState: number;
  blacklisted: boolean;
  /** Current owner's email when LOCKED. */
  lockByEmail?: string | null;
  /** Who is attempting to claim. */
  claimantEmail: string;
  /** Client of the requisition, for client-scoped rules (e.g. 腾讯). */
  client?: string | null;
  /** Candidate already has a customer relationship with this client. */
  tencentRelationship?: boolean;
}

export interface OwnershipDecision {
  decision: 'proceed' | 'lock-only';
  /** Which ownership rule decided. */
  matchedRuleId: string;
  reason: string;
  /** Convenience: true iff decision === 'lock-only'. */
  conflict: boolean;
}

const WILDCARD_CLIENT = '通用';

function sameOwner(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeEmail(a ?? '');
  const nb = normalizeEmail(b ?? '');
  return !!na && na === nb;
}

/** A rule applies to a client when scoped 通用 (wildcard) or the names match exactly.
 *  The scope comes from the rule's data (applicableClient), not a TS constant. */
function clientInScope(client: string | null | undefined, applicableClient: string): boolean {
  if (applicableClient === WILDCARD_CLIENT) return true;
  return (client ?? '').trim() === applicableClient;
}

export function decideOwnership(
  ctx: OwnershipContext,
  rules: OwnershipRule[],
): OwnershipDecision {
  const lockRule = rules.find((r) => r.id === 'OWN-LOCK-1');

  // Hard states (blacklist / PROTECTED) are absolute — no client-scoped rule may
  // override them. Evaluated above the 腾讯 branch so an owner re-claim can't slip a
  // blacklisted/protected candidate through.
  if (lockRule) {
    if (ctx.blacklisted) {
      return { decision: 'lock-only', matchedRuleId: 'OWN-LOCK-1', reason: '候选人在黑名单', conflict: true };
    }
    if (ctx.lockState === LockState.PROTECTED) {
      return { decision: 'lock-only', matchedRuleId: 'OWN-LOCK-1', reason: '候选人受保护(PROTECTED)', conflict: true };
    }
  }

  // 腾讯 (or whichever client the rule's applicableClient names) customer-relationship
  // protection — authoritative over the normal lock gate when applicable.
  const tencentRule = rules.find((r) => r.id === 'OWN-TENCENT-1');
  if (tencentRule && clientInScope(ctx.client, tencentRule.applicableClient) && ctx.tencentRelationship) {
    if (sameOwner(ctx.claimantEmail, ctx.lockByEmail)) {
      return { decision: 'proceed', matchedRuleId: 'OWN-TENCENT-1', reason: '客户关系归属:认领人即原归属人,可继续', conflict: false };
    }
    return { decision: 'lock-only', matchedRuleId: 'OWN-TENCENT-1', reason: '客户关系归属保护:非原归属人不可认领', conflict: true };
  }

  // Standard lock gate (LOCKED / FREE).
  if (lockRule) {
    if (ctx.lockState === LockState.LOCKED) {
      if (sameOwner(ctx.claimantEmail, ctx.lockByEmail)) {
        return { decision: 'proceed', matchedRuleId: 'OWN-LOCK-1', reason: '候选人已由本人锁定', conflict: false };
      }
      return { decision: 'lock-only', matchedRuleId: 'OWN-LOCK-1', reason: '候选人已被他人锁定', conflict: true };
    }
    return { decision: 'proceed', matchedRuleId: 'OWN-LOCK-1', reason: '候选人空闲,可认领', conflict: false };
  }

  return { decision: 'proceed', matchedRuleId: 'none', reason: '未配置归属规则', conflict: false };
}
