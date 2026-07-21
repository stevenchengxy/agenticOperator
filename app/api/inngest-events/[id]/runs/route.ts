// /api/inngest-events/:id/runs
//
// "Which Inngest function runs were spawned by this event, and what's their
// status?" — the /events fullscreen log modal uses it to show completion
// lifecycle inline alongside the raw event.
//
// Reads via lib/inngest-source (live /v1/events/{id}/runs ∪ durable run
// archive): the live buffer answers [] for any event that aged out of it, so
// without the archive merge the modal shows nothing for historical events.
//
// Empty runs array = event was accepted by the bus but no function was
// triggered (or none have been recorded yet — runs appear after Inngest
// records them, which can lag the event by ~1s).

import { NextResponse } from "next/server";
import { getEventRuns } from "@/lib/inngest-source";

export type EventRunRow = {
  run_id: string;
  function_id?: string;
  status: string; // Running / Completed / Failed / Cancelled / etc.
  run_started_at?: string;
  ended_at?: string | null;
  output?: unknown;
  event_id?: string;
};

export type EventRunsResponse = {
  runs: EventRunRow[];
  fetchedAt: string;
  error: string | null;
};

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "missing event id" },
      { status: 400 },
    );
  }
  try {
    const runs = await getEventRuns(id);
    const body: EventRunsResponse = {
      runs: runs as EventRunRow[],
      fetchedAt: new Date().toISOString(),
      error: null,
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      {
        runs: [],
        fetchedAt: new Date().toISOString(),
        error: (e as Error).message,
      },
      { status: 200 },
    );
  }
}
