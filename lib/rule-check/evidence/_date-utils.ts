/** Month difference between two YYYY-MM strings (b - a). Returns null if either is malformed. */
export function monthsDiffYM(a: string, b: string): number | null {
  if (!a || !b) return null;
  const [ay, am] = a.split('-').map(Number);
  // b might be ISO date (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ) — take first 7 chars.
  const bYM = b.slice(0, 7);
  const [by, bm] = bYM.split('-').map(Number);
  if (!ay || !am || !by || !bm) return null;
  return (by - ay) * 12 + (bm - am);
}

/** Year difference between two ISO date strings, integer years. */
export function yearsBetween(birthISO: string, todayISO: string): number | null {
  if (!birthISO || !todayISO) return null;
  const b = new Date(birthISO).getTime();
  const t = new Date(todayISO).getTime();
  if (Number.isNaN(b) || Number.isNaN(t)) return null;
  return Math.floor((t - b) / (1000 * 60 * 60 * 24 * 365.25));
}
