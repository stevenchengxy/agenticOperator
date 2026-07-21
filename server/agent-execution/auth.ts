// API-key auth for the Agent Execution API. SCOPED to /api/agent-execution/*
// only — applied per-route, NOT as global middleware — so existing AO routes
// keep their current (internal-network) behavior unchanged.
//
// Configure the shared secret in .env.local:
//   AGENT_EXECUTION_API_KEY=<strong-random-key>
// Partner sends it on every request as either header:
//   Authorization: Bearer <key>      OR      x-api-key: <key>

import { timingSafeEqual } from 'node:crypto';

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; code: 'UNAUTHORIZED' | 'SERVER_MISCONFIGURED'; message: string };

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch — compare lengths first (the
  // length itself is not secret) and short-circuit.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract the presented key from either accepted header. */
export function presentedKey(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const xkey = req.headers.get('x-api-key');
  if (xkey && xkey.trim()) return xkey.trim();
  return null;
}

/** Verify the request carries the configured key. Pure check on (req, env). */
export function checkAuth(req: Request): AuthResult {
  const configured = process.env.AGENT_EXECUTION_API_KEY;
  if (!configured || !configured.trim()) {
    return {
      ok: false,
      status: 500,
      code: 'SERVER_MISCONFIGURED',
      message: 'AGENT_EXECUTION_API_KEY is not configured on the server',
    };
  }
  const presented = presentedKey(req);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'missing api key — send Authorization: Bearer <key> or x-api-key: <key>',
    };
  }
  if (!constantTimeEquals(presented, configured.trim())) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'invalid api key' };
  }
  return { ok: true };
}
