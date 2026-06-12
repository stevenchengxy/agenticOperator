// A3 — GET /api/agent-execution/executions/{executionId}/llm-calls/{callId}
// Full prompt/response for one LLM call (lazy-loaded, kept out of the A2 poll).
// MVP: the engine makes one batched call 'llm-001'. Guide §4.0 / §4.2.

import { NextResponse } from 'next/server';
import { checkAuth } from '@/server/agent-execution/auth';
import { getLlmCall } from '@/server/agent-execution/service';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ executionId: string; callId: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: { code: auth.code, message: auth.message, retryable: false } },
      { status: auth.status },
    );
  }

  const { executionId, callId } = await ctx.params;
  const call = await getLlmCall(executionId, callId);
  if (!call) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: `llm call ${callId} not found for execution ${executionId}`, retryable: false } },
      { status: 404 },
    );
  }
  return NextResponse.json(call, { status: 200 });
}
