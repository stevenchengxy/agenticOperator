import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { streamRuleCheckRun } from '@/server/rule-check/runs-service';

export async function GET(req: NextRequest) {
  const latest = req.nextUrl.searchParams.get('latest');
  if (latest === '1') {
    const run = await prisma.ruleCheckRun.findFirst({
      orderBy: { startedAt: 'desc' },
      include: { results: { orderBy: { scenarioId: 'asc' } } },
    });
    return NextResponse.json({ run, scenarios: run?.results ?? [] });
  }
  const runs = await prisma.ruleCheckRun.findMany({
    orderBy: { startedAt: 'desc' }, take: 20,
  });
  return NextResponse.json({ runs });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    model?: string;
    client_id_override?: string;
    scenarios?: string[];
  };
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of streamRuleCheckRun({
          model: body.model,
          client_id_override: body.client_id_override,
          scenario_ids: body.scenarios,
          signal: req.signal,
        })) {
          const line = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
