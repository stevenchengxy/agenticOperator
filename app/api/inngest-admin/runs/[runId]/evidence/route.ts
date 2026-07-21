// GET /api/inngest-admin/runs/[runId]/evidence
// → Evidence trail captured by 3 PRA agents for this run id.
//
// Includes per-step:
//   - external call (RAAS / Allmeta endpoint)
//   - input JSON (request body)
//   - output JSON (response)
//   - error message (if step failed)
//   - duration
//   - Allmeta-specific: label / pk / Cypher hint
//
// Used by /monitor/flows/[flowId] page to render the complete evidence
// trail for each run, beyond what Inngest's history shows.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const rows = await prisma.agentStepEvidence.findMany({
      where: { run_id: runId },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        run_id: true,
        flow_id: true,
        function_slug: true,
        step_name: true,
        step_kind: true,
        external_call: true,
        input_json: true,
        output_json: true,
        error_message: true,
        duration_ms: true,
        allmeta_label: true,
        allmeta_pk_value: true,
        allmeta_neo4j: true,
        created_at: true,
      },
    });
    return NextResponse.json({
      runId,
      evidence: rows.map((r) => ({
        ...r,
        // parse JSON for client (server-side parse keeps client simple)
        input: r.input_json ? safeParse(r.input_json) : null,
        output: r.output_json ? safeParse(r.output_json) : null,
      })),
      meta: { count: rows.length, generatedAt: new Date().toISOString() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'evidence-fetch-failed', message: (err as Error).message },
      { status: 500 },
    );
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
