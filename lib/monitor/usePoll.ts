"use client";
import { useEffect, useRef, useState } from 'react';

// usePoll<T>(url, intervalMs, paused)
// - First request fires immediately on mount (unless paused).
// - Subsequent requests fire every intervalMs.
// - Errors are stored in state and visible in `error`; previous data is
//   kept so the UI doesn't flash to "nothing".
// - Unmount or URL change aborts the in-flight fetch via AbortController,
//   so stale responses from a previous URL never overwrite fresh data.
// - `refresh` has a stable identity across renders so consumers can list
//   it as a useEffect/useCallback dependency without causing loops.
// - `lastSuccessAt` is set each time a successful response is received;
//   used by StreamPill to distinguish "connected" vs "disconnected".
// - `paused` suspends all polling without unmounting; the effect re-runs
//   when paused changes, which triggers an immediate fetch on resume.
// - `httpStatus` is the HTTP status code of the last response (null if
//   the request hasn't completed yet or was aborted). Consumers can use
//   this to distinguish 404 (not found) from 5xx (server error).
export function usePoll<T>(url: string, intervalMs = 4_000, paused = false): {
  data: T | null;
  error: string | null;
  httpStatus: number | null;
  lastSuccessAt: Date | null;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<Date | null>(null);

  // Stable refresh identity: the function itself is stable, but it reads
  // the latest url/intervalMs from a ref each call.
  const stateRef = useRef({ url, intervalMs, ac: null as AbortController | null });
  stateRef.current.url = url;
  stateRef.current.intervalMs = intervalMs;

  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    // When paused, abort any in-flight request and do not start polling.
    if (paused) {
      stateRef.current.ac?.abort();
      stateRef.current.ac = null;
      return;
    }

    const fire = async () => {
      // Abort any prior in-flight fetch from this effect's lifetime.
      stateRef.current.ac?.abort();
      const ac = new AbortController();
      stateRef.current.ac = ac;
      try {
        const res = await fetch(url, { cache: 'no-store', signal: ac.signal });
        if (!res.ok) {
          if (!ac.signal.aborted) setHttpStatus(res.status);
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as T;
        if (!ac.signal.aborted) {
          setData(json);
          setError(null);
          setHttpStatus(res.status);
          setLastSuccessAt(new Date());
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        if (!ac.signal.aborted) setError((e as Error).message);
      }
    };

    refreshRef.current = fire;
    fire();
    const id = setInterval(fire, intervalMs);
    return () => {
      clearInterval(id);
      stateRef.current.ac?.abort();
      stateRef.current.ac = null;
    };
  }, [url, intervalMs, paused]);

  // Stable wrapper. Calling refresh() always invokes the latest fire
  // closure stored in refreshRef.
  const stableRefresh = useRef(() => {
    refreshRef.current();
  }).current;

  return { data, error, httpStatus, lastSuccessAt, refresh: stableRefresh };
}
