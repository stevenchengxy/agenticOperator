// A1 — POST /api/agent-execution/executions
// Accept one single-case evaluation execution (idempotent on clientRequestId),
// run it in the background against the PURE runRuleCheck engine, return 202.
// Auth is scoped to this route group only (no global middleware) → existing AO
// routes are unaffected. See docs/agent-execution-partner-handoff.md.

import { NextResponse } from 'next/server';
import { checkAuth } from '@/server/agent-execution/auth';
import { acceptExecution, ConcurrencyLimitError } from '@/server/agent-execution/service';
import type { ExecutionRequest } from '@/server/agent-execution/types';

export const dynamic = 'force-dynamic';

function authError(req: Request): Response | null {
  const auth = checkAuth(req);
  if (auth.ok) return null;
  return NextResponse.json(
    { error: { code: auth.code, message: auth.message, retryable: false } },
    { status: auth.status },
  );
}

export async function POST(req: Request): Promise<Response> {
  const denied = authError(req);
  if (denied) return denied;

  let body: ExecutionRequest;
  try {
    body = (await req.json()) as ExecutionRequest;
  } catch {
    return NextResponse.json(
      { error: { code: 'INPUT_INVALID', message: 'request body must be valid JSON', retryable: false } },
      { status: 400 },
    );
  }

  // Minimal shape gate (the engine does deep validation + structured errors).
  const missing: string[] = [];
  if (typeof body?.clientRequestId !== 'string' || !body.clientRequestId.trim()) missing.push('clientRequestId');
  if (!body?.ontology || typeof body.ontology.domain !== 'string' || !body.ontology.domain.trim()) missing.push('ontology.domain');
  if (!body?.ontology || typeof body.ontology.version !== 'string') missing.push('ontology.version');
  if (typeof body?.scenario !== 'string') missing.push('scenario');
  if (!body?.inputs) missing.push('inputs');
  if (missing.length) {
    return NextResponse.json(
      { error: { code: 'INPUT_INVALID', message: `missing required field(s): ${missing.join(', ')}`, retryable: false } },
      { status: 400 },
    );
  }

  try {
    const { executionId, status, duplicate } = await acceptExecution(body);
    return NextResponse.json(
      { executionId, status, correlation: body.correlation ?? null },
      { status: duplicate ? 200 : 202 },
    );
  } catch (e) {
    if (e instanceof ConcurrencyLimitError) {
      return NextResponse.json(
        { error: { code: 'RATE_LIMITED', message: 'concurrency limit reached — retry after the indicated delay', retryable: true } },
        { status: 429, headers: { 'Retry-After': String(e.retryAfterSec) } },
      );
    }
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: (e as Error).message ?? String(e), retryable: false } },
      { status: 500 },
    );
  }
}
