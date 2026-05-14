import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const { run_id } = await params;
  const run = await prisma.ruleCheckRun.findUnique({
    where: { id: run_id },
    include: { results: { orderBy: { scenarioId: 'asc' } } },
  });
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  return NextResponse.json({ run, scenarios: run.results });
}
