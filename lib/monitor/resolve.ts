// Alert resolution — recordNotification only ever writes status='firing', so the
// sweeper must actively close alerts whose condition has cleared. Each sweep, a
// monitor reports its current activeKeys; resolveStale finds firing rows under
// the monitor's dedupe prefix that are no longer active and marks them resolved.
//
// keysToResolve is pure (testable without a DB); resolveStale is thin wiring over
// injected deps (the Postgres impl lives in pg-resolve.ts).

export function keysToResolve(firingKeys: string[], activeKeys: Set<string>): string[] {
  return firingKeys.filter((k) => !activeKeys.has(k));
}

export interface ResolveDeps {
  /** dedupeKeys of firing notifications whose key starts with `prefix`. */
  findFiring(prefix: string): Promise<string[]>;
  /** flip the given dedupeKeys' firing rows to status='resolved'. */
  markResolved(keys: string[]): Promise<void>;
}

/** Close firing alerts under `prefix` that are not in `activeKeys`. Returns #closed. */
export async function resolveStale(
  prefix: string,
  activeKeys: Set<string>,
  deps: ResolveDeps,
): Promise<number> {
  const firing = await deps.findFiring(prefix);
  const stale = keysToResolve(firing, activeKeys);
  if (stale.length === 0) return 0;
  await deps.markResolved(stale);
  return stale.length;
}
