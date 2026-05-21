// lib/partner-pg/client.ts
//
// Connection pool to partner's Postgres at 192.168.1.103:5432/raas_db.
// Singleton — reuse across all agents and all Inngest steps.
//
// HMR-safe: in Next.js dev mode the module is re-evaluated on every file
// change, which would otherwise leak a new pg.Pool per HMR cycle. We
// stash the pool on globalThis under a guarded key so re-imports reuse
// the same pool (and only in dev — production keeps strict module-local
// state). Verified by the partner spec's acceptance criteria:
//   "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE …
//    不持续增长"
//
// Per 2026-05-20 dual-write decision: AO writes directly to partner's
// Postgres, replacing the RAAS HTTP API. See:
//   docs/superpowers/specs/2026-05-20-ao-direct-dual-write-event-flow.md
//   docs/superpowers/plans/2026-05-20-ao-direct-dual-write.md

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { currentLogger } from '@/lib/agent-logger';

declare global {
  // eslint-disable-next-line no-var
  var __raasPgPool: Pool | undefined;
}

let pool: Pool | null = globalThis.__raasPgPool ?? null;

// First non-empty line of the SQL (collapsed) — used as the apiCall label so
// "pg.SELECT candidate_id FROM candidate WHERE …" shows up grouped in logs.
function sqlLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const verb = oneLine.split(' ')[0]?.toUpperCase() || 'SQL';
  // Show first SQL keyword + first 60 chars
  return `pg.${verb} ${oneLine.slice(0, 60)}`;
}

async function loggedQuery<T extends QueryResultRow = QueryResultRow>(
  exec: (text: string, params?: unknown[]) => Promise<QueryResult<T>>,
  text: string,
  params: unknown[] | undefined,
  inTx: boolean,
): Promise<QueryResult<T>> {
  const logger = currentLogger();
  if (!logger) {
    // No agent context — just run the query, skip telemetry.
    return exec(text, params);
  }
  const start = Date.now();
  try {
    const r = await exec(text, params);
    logger.apiCall(sqlLabel(text), {
      url: inTx ? 'partner-pg://tx-query' : 'partner-pg://query',
      method: 'POST',
      request: { sql: text.length > 800 ? text.slice(0, 800) + '…' : text, params, in_tx: inTx },
      status: 200,
      durationMs: Date.now() - start,
      response: { rowCount: r.rowCount },
    });
    return r;
  } catch (err) {
    logger.apiCall(sqlLabel(text), {
      url: inTx ? 'partner-pg://tx-query' : 'partner-pg://query',
      method: 'POST',
      request: { sql: text.length > 800 ? text.slice(0, 800) + '…' : text, params, in_tx: inTx },
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
    throw err;
  }
}

function readPgUrl(): string | null {
  // RAAS_PG_URL is the partner-contract canonical name (per 2026-05-21
  // recruiting-jobs spec). RAAS_POSTGRES_URL is our legacy name, kept as
  // fallback so existing deployments don't have to flip env in lock-step.
  return (
    process.env.RAAS_PG_URL?.trim() ||
    process.env.RAAS_POSTGRES_URL?.trim() ||
    null
  );
}

function getPool(): Pool {
  if (pool) return pool;
  const url = readPgUrl();
  if (!url) {
    throw new Error('[partner-pg] RAAS_PG_URL / RAAS_POSTGRES_URL not set in env');
  }
  pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[partner-pg] idle client error:', err.message);
  });
  if (process.env.NODE_ENV !== 'production') {
    // Survive Next.js HMR re-imports — see header comment.
    globalThis.__raasPgPool = pool;
  }
  return pool;
}

export function isPartnerPgConfigured(): boolean {
  return !!readPgUrl();
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const p = getPool();
  return loggedQuery<T>(
    (t, ps) => p.query<T>(t, ps as never),
    text,
    params,
    false,
  );
}

/**
 * Run a callback inside a transaction. Rolls back on throw.
 *
 * The PoolClient passed to `fn` is proxied so that every `c.query(...)` call
 * inside the transaction body also flows through the per-agent logger.
 * BEGIN / COMMIT / ROLLBACK are logged as well so a single audit line per
 * step shows the full tx boundary.
 */
export async function withTx<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await getPool().connect();
  const txStart = Date.now();
  const logger = currentLogger();
  // Proxy the client so the body's c.query(...) gets the same telemetry as
  // the top-level pool query helper.
  const proxied = new Proxy(c, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (text: string, params?: unknown[]) =>
          loggedQuery(
            (t, ps) => target.query(t, ps as never),
            text,
            params,
            true,
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as PoolClient;
  try {
    await c.query('BEGIN');
    logger?.event('pg.tx.begin', { ms_since_acquire: Date.now() - txStart });
    const result = await fn(proxied);
    await c.query('COMMIT');
    logger?.event('pg.tx.commit', { duration_ms: Date.now() - txStart });
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    logger?.event('pg.tx.rollback', {
      duration_ms: Date.now() - txStart,
      error: (err as Error).message,
    });
    throw err;
  } finally {
    c.release();
  }
}

/** Close pool — used by tests + graceful shutdown. */
export async function close(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    if (process.env.NODE_ENV !== 'production') {
      globalThis.__raasPgPool = undefined;
    }
  }
}
