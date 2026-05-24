// POST /api/em/sync/event-definitions/run-now
//
// Triggers the EventDefinition Neo4j sync worker on-demand instead of waiting
// for NEO4J_SYNC_INTERVAL_MS. Used by the [手动刷新] button on /events and
// inside <SystemConfigModal/>.
//
// Per spec 2026-05-24 §5.2.

import { NextResponse } from 'next/server';
import { syncEventDefinitions } from '@/server/em/sync/event-definition-sync';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  try {
    const result = await syncEventDefinitions();
    return NextResponse.json({
      ok: !result.error,
      result,
      finishedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
