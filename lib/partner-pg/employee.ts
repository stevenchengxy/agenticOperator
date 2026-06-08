// lib/partner-pg/employee.ts
//
// Resolve a recruiter's contact details from the partner Postgres `employee`
// table by their employee_id.
//
// TODO(partner): confirm table name 'employee' and columns 'email' / 'name' /
//   'employee_id' with the RAAS partner — these match the schema as observed
//   but have not been formally documented in the partner spec yet.
//
// Design notes:
//  - Uses the shared `query` helper from client.ts (same pool, same telemetry).
//  - Process-local cache on globalThis (HMR-safe, like the pool itself):
//      positive TTL: 10 min (email addresses are stable)
//      negative TTL:  1 min (allow re-lookup after a backfill)
//  - Returns null — never fabricates an email — when:
//      · employeeId is null / empty
//      · no row found in the table
//      · the stored email is null or blank
//    Callers MUST treat null as fail-open (skip the send, do not guess).

import { query } from './client';

// ── Cache types ──────────────────────────────────────────────────────────────

type CacheEntry =
  | { kind: 'hit'; value: { email: string; name: string | null }; expiresAt: number }
  | { kind: 'miss'; expiresAt: number };

const POSITIVE_TTL_MS = 10 * 60 * 1_000; //  10 min
const NEGATIVE_TTL_MS =  1 * 60 * 1_000; //   1 min

// HMR-safe cache key — same pattern as __raasPgPool in client.ts.
const CACHE_KEY = '__partnerPgEmployeeCache';

declare global {
  // eslint-disable-next-line no-var
  var __partnerPgEmployeeCache: Map<string, CacheEntry> | undefined;
}

function getCache(): Map<string, CacheEntry> {
  if (!globalThis.__partnerPgEmployeeCache) {
    globalThis.__partnerPgEmployeeCache = new Map();
  }
  return globalThis.__partnerPgEmployeeCache;
}

// ── SQL ──────────────────────────────────────────────────────────────────────

const SELECT_SQL = `
  SELECT email, name
  FROM employee
  WHERE employee_id = $1
  LIMIT 1
`;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve a recruiter's email (and name) from the partner `employee` table.
 *
 * Returns null when:
 *  - employeeId is null or blank (no query is issued)
 *  - no row is found for that employee_id
 *  - the stored email is null or blank
 *
 * A 10-minute positive cache and 1-minute negative cache reduce round-trips
 * when the same recruiter's email is looked up across many candidates in one
 * batch run.
 */
export async function resolveRecruiterEmail(
  employeeId: string | null,
): Promise<{ email: string; name: string | null } | null> {
  const id = employeeId?.trim();
  if (!id) return null;

  const cache = getCache();
  const now = Date.now();

  // Cache hit?
  const cached = cache.get(id);
  if (cached && cached.expiresAt > now) {
    return cached.kind === 'hit' ? cached.value : null;
  }

  // Query partner Postgres.
  const { rows } = await query<{ email: string | null; name: string | null }>(
    SELECT_SQL,
    [id],
  );

  if (rows.length === 0 || !rows[0].email?.trim()) {
    // Negative cache — retry quickly after a potential backfill.
    cache.set(id, { kind: 'miss', expiresAt: now + NEGATIVE_TTL_MS });
    return null;
  }

  const value = { email: rows[0].email.trim(), name: rows[0].name ?? null };
  cache.set(id, { kind: 'hit', value, expiresAt: now + POSITIVE_TTL_MS });
  return value;
}
