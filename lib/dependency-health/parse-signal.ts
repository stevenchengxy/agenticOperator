// Reconstruct a DepFailure from a stored `dependency` LogEvent row. Pure +
// defensive — a row whose payload is missing, malformed, or carries an unknown
// provider/reason is dropped (returns null) rather than crashing a sweep.
// Shared by the monitor read port and the /api/dependency-health route.

import { RECRUITMENT_DOMAIN_ID } from '../domain-ids';
import type { DepFailure, DepProvider, DepReason } from './types';

const PROVIDERS: ReadonlySet<string> = new Set<DepProvider>(['robohire', 'llm']);
const REASONS: ReadonlySet<string> = new Set<DepReason>(['quota', 'auth', 'rate_limit', 'empty', 'server', 'network']);

export interface DependencyLogRow {
  runId: string | null;
  ts: Date;
  payloadJson: string | null;
}

export function parseDependencyRow(row: DependencyLogRow): DepFailure | null {
  if (!row.payloadJson) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const provider = p.provider;
  const op = p.op;
  const reason = p.reason;
  if (typeof provider !== 'string' || !PROVIDERS.has(provider)) return null;
  if (typeof op !== 'string' || op.length === 0) return null;
  if (typeof reason !== 'string' || !REASONS.has(reason)) return null;

  const domain = typeof p.domain === 'string' && p.domain.length > 0 ? p.domain : RECRUITMENT_DOMAIN_ID;
  const anchors =
    p.anchors && typeof p.anchors === 'object' ? (p.anchors as Record<string, string>) : undefined;

  return {
    provider: provider as DepProvider,
    op,
    reason: reason as DepReason,
    domain,
    runId: row.runId,
    ts: row.ts,
    ...(anchors ? { anchors } : {}),
  };
}
