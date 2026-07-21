// A2 — GET /api/agent-execution/executions/{executionId}
// Poll execution status; once done returns 结论 + trace + meta (guide §4.2).

import { NextResponse } from 'next/server';
import { checkAuth } from '@/server/agent-execution/auth';
import { getExecution } from '@/server/agent-execution/service';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ executionId: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: { code: auth.code, message: auth.message, retryable: false } },
      { status: auth.status },
    );
  }

  const { executionId } = await ctx.params;
  const resp = await getExecution(executionId);
  if (!resp) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: `execution ${executionId} not found`, retryable: false } },
      { status: 404 },
    );
  }
  return NextResponse.json(resp, { status: 200 });
}
