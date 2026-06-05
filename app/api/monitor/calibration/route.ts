// Judge calibration — GET returns the judge-vs-human confusion matrix (+ κ) over
// labelled evals; POST attaches a human label to one eval. Drives the §7.5
// calibration loop.
import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { confusion, type LabelPair } from '@/lib/monitor/calibration';

function asLabel(v: string | null | undefined): 'grounded' | 'not_grounded' {
  return v === 'not_grounded' ? 'not_grounded' : 'grounded';
}

export async function GET(): Promise<Response> {
  const labelled = await prisma.monitorEval.findMany({
    where: { humanLabel: { not: null }, verdict: { not: null } },
    select: { verdict: true, humanLabel: true },
  });
  const pairs: LabelPair[] = labelled.map((r) => ({
    judge: asLabel(r.verdict),
    human: asLabel(r.humanLabel),
  }));
  return NextResponse.json({ matrix: confusion(pairs), labelledCount: pairs.length });
}

export async function POST(req: Request): Promise<Response> {
  let body: { id?: string; humanLabel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  if (!body.id || !body.humanLabel) {
    return NextResponse.json({ ok: false, error: 'id + humanLabel required' }, { status: 400 });
  }
  try {
    await prisma.monitorEval.update({
      where: { id: body.id },
      data: { humanLabel: asLabel(body.humanLabel) },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
