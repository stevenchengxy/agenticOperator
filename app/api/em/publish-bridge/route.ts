// POST /api/em/publish-bridge
//
// Thin HTTP wrapper around em.publish() that allows external processes
// (primarily resume-parser-agent / RPA) to route their events through
// AO-main's EM so they appear in the EventInstance audit trail.
//
// Body:
//   {
//     name: string,              // event name e.g. 'RESUME_PROCESSED'
//     data: unknown,             // event payload
//     source: string,            // 'rpa.<agent>' e.g. 'rpa.resumeParserAgent'
//     externalEventId?: string,  // optional dedup key
//     causedBy?: { eventId: string; name: string },
//     traceId?: string,
//   }
//
// Response: PublishResult — same shape as /api/em/publish
//
// Auth: NONE — safe behind VPN / internal network only.
// When RPA merges into AO-main, delete this route and call em.publish directly.

import { NextResponse } from 'next/server';
import { em } from '@/server/em';

export const dynamic = 'force-dynamic';

type BridgeBody = {
  name: string;
  data: unknown;
  source: string;
  externalEventId?: string;
  causedBy?: { eventId: string; name: string };
  traceId?: string;
};

export async function POST(req: Request): Promise<Response> {
  let body: BridgeBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'BAD_REQUEST', message: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  if (typeof body?.name !== 'string' || body.name.length === 0) {
    return NextResponse.json(
      { error: 'BAD_REQUEST', message: 'name (string) is required.', field: 'name' },
      { status: 400 },
    );
  }

  if (body?.data === undefined) {
    return NextResponse.json(
      { error: 'BAD_REQUEST', message: 'data is required.', field: 'data' },
      { status: 400 },
    );
  }

  if (typeof body?.source !== 'string' || body.source.length === 0) {
    return NextResponse.json(
      { error: 'BAD_REQUEST', message: "source (string) is required — e.g. 'rpa.resumeParserAgent'.", field: 'source' },
      { status: 400 },
    );
  }

  try {
    const result = await em.publish(body.name, body.data, {
      source: body.source,
      externalEventId:
        typeof body.externalEventId === 'string' ? body.externalEventId : undefined,
      causedBy:
        body.causedBy &&
        typeof body.causedBy.eventId === 'string' &&
        typeof body.causedBy.name === 'string'
          ? { eventId: body.causedBy.eventId, name: body.causedBy.name }
          : undefined,
      traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
    });

    return NextResponse.json(result);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[em/publish-bridge] em.publish failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal', message: (e as Error).message }, { status: 500 });
  }
}
