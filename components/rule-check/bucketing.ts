import type { RuleStatus } from '@/lib/rule-check/types';

export type ConfusionBucket = 'TP' | 'TN' | 'FP' | 'FN' | 'excluded';
export type CellMarker = 'match' | 'mismatch' | 'missing' | 'partial' | 'excluded';

export type CellOutcome = { bucket: ConfusionBucket; marker: CellMarker };

export type CellStatus = RuleStatus | 'missing-from-expected' | 'missing-from-actual';

function isRisk(s: RuleStatus): boolean {
  return s === 'fail' || s === 'pending' || s === 'insufficient_info';
}
function isClear(s: RuleStatus): boolean {
  return s === 'pass' || s === 'not_triggered';
}

export function bucketCell(expected: CellStatus, actual: CellStatus): CellOutcome {
  if (expected === 'not_executed' || actual === 'not_executed') {
    return { bucket: 'excluded', marker: 'excluded' };
  }
  if (actual === 'missing-from-actual') {
    if (expected === 'missing-from-expected') {
      return { bucket: 'excluded', marker: 'excluded' };
    }
    if (isRisk(expected as RuleStatus)) return { bucket: 'FN', marker: 'missing' };
    return { bucket: 'FP', marker: 'missing' };
  }
  if (expected === 'missing-from-expected') {
    return { bucket: 'excluded', marker: 'excluded' };
  }
  const expRisk = isRisk(expected as RuleStatus);
  const actRisk = isRisk(actual as RuleStatus);
  if (expRisk && actRisk) {
    return { bucket: 'TP', marker: expected === actual ? 'match' : 'partial' };
  }
  if (isClear(expected as RuleStatus) && isClear(actual as RuleStatus)) {
    return { bucket: 'TN', marker: expected === actual ? 'match' : 'partial' };
  }
  if (!expRisk && actRisk) return { bucket: 'FP', marker: 'mismatch' };
  return { bucket: 'FN', marker: 'mismatch' };
}
