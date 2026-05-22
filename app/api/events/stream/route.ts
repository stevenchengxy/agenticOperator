// GET /api/events/stream
//
// Server-Sent Events stream of recent events. Sources from the local Inngest
// dev server's /v1/events API (NOT the EventInstance Prisma table) because
// many events arrive via the RAAS bridge → Inngest path without going
// through em.publish() — the EventInstance table can lag the live stream by
// hours or days, so reading from it would make /events look frozen.
//
// Connection holds open; polls Inngest every 1500ms for new events and
// pushes them down the stream as they arrive.
//
// Each event is enriched with `source` from EventInstance (best-effort, by
// externalEventId match) so the UI direction-classifier (received / published)
// still works for events that DID flow through em.publish.
//
// Wire format (per SSE chunk):
//   data: {"type":"initial","events":[...]}
//   data: {"type":"new","events":[...]}
//   data: {"type":"heartbeat"}

import { prisma } from "@/server/db";
import { getInngestUrl } from "@/lib/inngest-url";

const LOCAL_INNGEST = getInngestUrl();

const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 25_000;
const INITIAL_LIMIT = 200;
const POLL_LIMIT = 50;
const FETCH_TIMEOUT_MS = 4000;

export const dynamic = "force-dynamic";

type InngestEvent = {
  id: string;
  internal_id?: string;
  name: string;
  data: unknown;
  ts?: number;
  received_at?: string;
};

// Shape matches InngestEventRow so the client hook can pass rows through
// directly without remapping.
type EventPayload = {
  id: string;
  name: string;
  source: string | null;
  status: string;
  received_at: string;
  payloadSummary: string | null;
  data: unknown;
};

async function fetchInngestEvents(limit: number): Promise<InngestEvent[]> {
  try {
    const r = await fetch(`${LOCAL_INNGEST}/v1/events?limit=${limit}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return [];
    const body = (await r.json()) as { data?: InngestEvent[] };
    return body.data ?? [];
  } catch {
    return [];
  }
}

async function enrichWithSource(
  events: InngestEvent[],
): Promise<Map<string, string>> {
  if (events.length === 0) return new Map();
  try {
    const ids = events.map((e) => e.internal_id ?? e.id).filter(Boolean);
    const rows = await prisma.eventInstance.findMany({
      where: { externalEventId: { in: ids } },
      select: { externalEventId: true, source: true },
    });
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.externalEventId && r.source) map.set(r.externalEventId, r.source);
    }
    return map;
  } catch {
    return new Map();
  }
}

function toPayload(e: InngestEvent, sourceMap: Map<string, string>): EventPayload {
  const id = e.internal_id ?? e.id;
  const receivedAt = e.received_at ?? (e.ts ? new Date(e.ts).toISOString() : new Date().toISOString());
  return {
    id,
    name: e.name,
    source: sourceMap.get(id) ?? null,
    status: "accepted",
    received_at: receivedAt,
    payloadSummary: typeof e.data === "string" ? e.data : safeStringify(e.data),
    data: e.data,
  };
}

function safeStringify(v: unknown): string | null {
  if (v == null) return null;
  try { return JSON.stringify(v); } catch { return null; }
}

export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  const seen = new Set<string>();
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
          closed = true;
        }
      };

      // Initial dump
      try {
        const initial = await fetchInngestEvents(INITIAL_LIMIT);
        for (const e of initial) seen.add(e.internal_id ?? e.id);
        const sourceMap = await enrichWithSource(initial);
        emit({
          type: "initial",
          events: initial.map((e) => toPayload(e, sourceMap)),
        });
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      }

      // Poll for new events
      pollTimer = setInterval(async () => {
        if (closed) return;
        try {
          const recent = await fetchInngestEvents(POLL_LIMIT);
          const fresh = recent.filter((e) => {
            const id = e.internal_id ?? e.id;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          if (fresh.length > 0) {
            const sourceMap = await enrichWithSource(fresh);
            // Sort oldest-first so client receives them in chronological order
            fresh.sort((a, b) => (a.id > b.id ? 1 : -1));
            emit({
              type: "new",
              events: fresh.map((e) => toPayload(e, sourceMap)),
            });
          }
          // Prevent unbounded growth of `seen`
          if (seen.size > 5000) {
            const keep = Array.from(seen).slice(-2000);
            seen.clear();
            for (const id of keep) seen.add(id);
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
