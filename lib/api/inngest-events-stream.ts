"use client";
import { useEffect, useRef, useState } from "react";
import { useInngestEvents, type InngestEventRow } from "./inngest-events";

type StreamMessage =
  | { type: "initial"; events: InngestEventRow[] }
  | { type: "new"; events: InngestEventRow[] }
  | { type: "heartbeat" }
  | { type: "error"; message: string };

const MAX_EVENTS = 500; // cap client-side buffer

type Options = {
  /** When true, falls back to the legacy polling hook (for unsupported envs). */
  forcePoll?: boolean;
  /** When stream errors > N times, fall back to polling. Default 3. */
  errorFallbackThreshold?: number;
};

export function useInngestEventsStream(opts: Options = {}): {
  events: InngestEventRow[];
  connected: boolean;
  lastFetchAt: Date | null;
  error: string | null;
  sources: string[];
} {
  const [events, setEvents] = useState<InngestEventRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<Date | null>(null);
  const [shouldFallback, setShouldFallback] = useState(opts.forcePoll ?? false);
  const errorCountRef = useRef(0);

  // Polling fallback (always constructed; only active when shouldFallback=true)
  const polling = useInngestEvents({
    intervalMs: 2000,
    limit: 200,
    paused: !shouldFallback,
  });

  useEffect(() => {
    if (shouldFallback) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      setShouldFallback(true);
      return;
    }

    const es = new EventSource("/api/events/stream");
    const threshold = opts.errorFallbackThreshold ?? 3;

    es.onopen = () => {
      setConnected(true);
      setError(null);
      errorCountRef.current = 0;
    };

    es.onmessage = (msg) => {
      let parsed: StreamMessage;
      try {
        parsed = JSON.parse(msg.data as string) as StreamMessage;
      } catch {
        return;
      }
      setLastFetchAt(new Date());
      switch (parsed.type) {
        case "initial":
          setEvents(parsed.events.slice(0, MAX_EVENTS));
          break;
        case "new":
          setEvents((prev) => {
            const seen = new Set(
              prev.map((e) => e.internal_id ?? e.id ?? `${e.name}-${e.received_at ?? ""}`),
            );
            const fresh = parsed.events.filter(
              (e) => !seen.has(e.internal_id ?? e.id ?? `${e.name}-${e.received_at ?? ""}`),
            );
            return [...fresh, ...prev].slice(0, MAX_EVENTS);
          });
          break;
        case "heartbeat":
          // no-op, just keeps connection alive
          break;
        case "error":
          setError(parsed.message);
          break;
      }
    };

    es.onerror = () => {
      setConnected(false);
      errorCountRef.current += 1;
      if (errorCountRef.current >= threshold) {
        setError("stream connection lost — falling back to polling");
        setShouldFallback(true);
      }
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, [shouldFallback, opts.errorFallbackThreshold]);

  if (shouldFallback) {
    return {
      events: polling.events,
      connected: polling.connected,
      lastFetchAt: polling.lastFetchAt,
      error: polling.error,
      sources: polling.sources,
    };
  }

  return { events, connected, lastFetchAt, error, sources: [] };
}
