// Judge-vs-human calibration — confusion matrix + precision/recall/F1/accuracy +
// Cohen's kappa, treating 'not_grounded' as the positive class (the violation we
// want the judge to catch). Pure; NaN-safe on empty/degenerate inputs.

export interface LabelPair {
  judge: 'grounded' | 'not_grounded';
  human: 'grounded' | 'not_grounded';
}

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  kappa: number;
}

export function confusion(pairs: LabelPair[]): Confusion {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const p of pairs) {
    const jPos = p.judge === 'not_grounded';
    const hPos = p.human === 'not_grounded';
    if (jPos && hPos) tp++;
    else if (jPos && !hPos) fp++;
    else if (!jPos && hPos) fn++;
    else tn++;
  }
  const n = tp + fp + tn + fn || 1;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = (tp + tn) / n;
  // Cohen's kappa
  const pJudgePos = (tp + fp) / n;
  const pHumanPos = (tp + fn) / n;
  const pe = pJudgePos * pHumanPos + (1 - pJudgePos) * (1 - pHumanPos);
  const kappa = pe >= 1 ? 1 : (accuracy - pe) / (1 - pe);
  return { tp, fp, tn, fn, precision, recall, f1, accuracy, kappa };
}
