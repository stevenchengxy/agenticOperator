// Triage / root-cause clustering — groups firing monitor alerts by dedupe prefix
// (the monitor namespace, e.g. run_stalled / sla_breach / cost) and domain, so a
// burst of related alerts surfaces as one cluster instead of N rows. Pure; the
// optional AI one-liner summary is added downstream (off-Inngest, fallback).

export interface FiringAlert {
  dedupeKey: string;
  domain: string | null;
  source: string;
  severity: string;
  count: number;
}

export interface AlertCluster {
  key: string;
  prefix: string;
  domain: string | null;
  total: number;
  alerts: FiringAlert[];
}

export function clusterFiring(alerts: FiringAlert[]): AlertCluster[] {
  const groups = new Map<string, AlertCluster>();
  for (const a of alerts) {
    const prefix = a.dedupeKey.split('.')[0];
    const key = `${prefix}|${a.domain ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, prefix, domain: a.domain ?? null, total: 0, alerts: [] };
      groups.set(key, g);
    }
    g.total += a.count;
    g.alerts.push(a);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}
