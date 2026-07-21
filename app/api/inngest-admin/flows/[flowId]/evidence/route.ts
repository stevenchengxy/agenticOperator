// GET /api/inngest-admin/flows/[flowId]/evidence
// → All evidence rows for this flow (across all agents that touched it).
//
// flowId examples: "upload:u_xxx" / "jr:JR-001" / "evt:01KR..."

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ flowId: string }> }) {
  const { flowId: encoded } = await params;
  const flowId = decodeURIComponent(encoded);
  try {
    const rows = await prisma.agentStepEvidence.findMany({
      where: { flow_id: flowId },
      orderBy: { created_at: 'asc' },
    });
    // Group by run_id for UI rendering
    const byRun = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byRun.get(r.run_id) ?? [];
      arr.push(r);
      byRun.set(r.run_id, arr);
    }
    return NextResponse.json({
      flowId,
      evidenceByRun: Object.fromEntries(
        Array.from(byRun.entries()).map(([runId, items]) => [
          runId,
          items.map((r) => ({
            ...r,
            input: r.input_json ? safeParse(r.input_json) : null,
            output: r.output_json ? safeParse(r.output_json) : null,
          })),
        ]),
      ),
      meta: { totalRows: rows.length, runCount: byRun.size, generatedAt: new Date().toISOString() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'flow-evidence-fetch-failed', message: (err as Error).message },
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
