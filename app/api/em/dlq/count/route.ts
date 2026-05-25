// GET /api/em/dlq/count
//
// Returns the count of unresolved DLQ entries. Used by /overview KPI bar
// to surface "events that failed validation and need attention" without
// loading the full DLQ list (which can be large).
//
// Filters: resolvedAt IS NULL = "still pending operator action".

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

export type DlqCountResponse = {
  pending: number;
  fetchedAt: string;
};

export async function GET(): Promise<Response> {
  try {
    const pending = await prisma.dLQEntry.count({ where: { resolvedAt: null } });
    return NextResponse.json({ pending, fetchedAt: new Date().toISOString() } satisfies DlqCountResponse);
  } catch {
    // DB hiccup — surface 0 so the KPI doesn't go red on a transient blip.
    return NextResponse.json({ pending: 0, fetchedAt: new Date().toISOString() } satisfies DlqCountResponse);
  }
}
