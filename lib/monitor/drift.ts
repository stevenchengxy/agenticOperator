// Judge drift — re-judge a set of historical samples and compare to the original
// verdicts, ONLY within the same judgePromptVersion (else a deliberate prompt
// edit looks like model drift). Pure.

export interface JudgedSample {
  sampledFrom: string;
  verdict: string;
  judgePromptVersion: string | null;
}

export function agreementRate(
  original: JudgedSample[],
  rejudge: JudgedSample[],
  promptVersion: string,
): { compared: number; agreed: number; rate: number } {
  const orig = new Map(
    original.filter((s) => s.judgePromptVersion === promptVersion).map((s) => [s.sampledFrom, s.verdict]),
  );
  let compared = 0;
  let agreed = 0;
  for (const r of rejudge) {
    if (r.judgePromptVersion !== promptVersion) continue;
    const o = orig.get(r.sampledFrom);
    if (o === undefined) continue;
    compared++;
    if (o === r.verdict) agreed++;
  }
  return { compared, agreed, rate: compared ? agreed / compared : 1 };
}

export function isDrifting(rate: number, threshold = 0.8): boolean {
  return rate < threshold;
}
