// Deterministic stride sampling — picks ~pct% of items with NO RNG, so re-running
// over an overlapping window is stable (a sample isn't re-judged differently each
// tick). pct is clamped to [0,100].

export function sampleByPct<T>(items: T[], pct: number): T[] {
  if (items.length === 0 || pct <= 0) return [];
  if (pct >= 100) return [...items];
  const stride = Math.max(1, Math.round(100 / pct));
  const out: T[] = [];
  for (let i = 0; i < items.length; i += stride) out.push(items[i]);
  return out;
}
