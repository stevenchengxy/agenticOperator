// GET /api/events/stream
//
// Server-Sent Events stream of recent EventInstance rows. Holds the connection
// open and polls the DB every 1500ms for new rows; pushes new rows down the
// stream. Client gets near-real-time updates without Redis/pub-sub infra.
//
// Wire format (per SSE chunk):
//   data: {"type":"initial","events":[...]}
//   data: {"type":"new","events":[...]}
//   data: {"type":"heartbeat"}
//
// Initial chunk delivers the last `INITIAL_LIMIT` rows so the client UI can
// hydrate immediately without an extra fetch.

import { prisma } from "@/server/db";

const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 25_000;
const INITIAL_LIMIT = 200;

export const dynamic = "force-dynamic";

// Shape matches InngestEventRow so the client hook can pass rows through
// directly without remapping (received_at is the field the UI uses).
type EventPayload = {
  id: string;
  name: string;
  source: string | null;
  status: string;
  // Map EventInstance.ts → received_at so this matches InngestEventRow
  received_at: string;
  payloadSummary: string | null;
  // data field expected by InngestEventRow consumers
  data: unknown;
};

function rowToPayload(r: {
  id: string;
  name: string;
  source: string;
  status: string;
  ts: Date;
  payloadSummary: string | null;
}): EventPayload {
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    status: r.status,
    received_at: r.ts.toISOString(),
    payloadSummary: r.payloadSummary,
    data: r.payloadSummary ? tryParseJson(r.payloadSummary) : null,
  };
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  let lastTs: Date | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // Stream closed unexpectedly
          closed = true;
        }
      };

      // Initial dump
      try {
        const initial = await prisma.eventInstance.findMany({
          orderBy: { ts: "desc" },
          take: INITIAL_LIMIT,
          select: { id: true, name: true, source: true, status: true, ts: true, payloadSummary: true },
        });
        emit({ type: "initial", events: initial.map(rowToPayload) });
        if (initial.length > 0) lastTs = initial[0].ts;
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      }

      // Poll for new rows
      pollTimer = setInterval(async () => {
        if (closed) return;
        try {
          const since = lastTs ?? new Date(Date.now() - 60_000);
          const newRows = await prisma.eventInstance.findMany({
            where: { ts: { gt: since } },
            orderBy: { ts: "asc" },
            take: 100,
            select: { id: true, name: true, source: true, status: true, ts: true, payloadSummary: true },
          });
          if (newRows.length > 0) {
            emit({ type: "new", events: newRows.map(rowToPayload) });
            lastTs = newRows[newRows.length - 1].ts;
          }
        } catch (e) {
          emit({ type: "error", message: (e as Error).message });
        }
      }, POLL_INTERVAL_MS);

      // Heartbeat to keep the connection alive through proxies
      heartbeatTimer = setInterval(() => {
        emit({ type: "heartbeat" });
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
