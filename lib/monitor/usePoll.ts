"use client";
import { useEffect, useRef, useState } from 'react';

// usePoll<T>(url, intervalMs)
// - First request fires immediately on mount.
// - Subsequent requests fire every intervalMs.
// - Errors are stored in state and visible in `error`; previous data is
//   kept so the UI doesn't flash to "nothing".
// - Unmount cancels the next tick.
export function usePoll<T>(url: string, intervalMs = 4_000): {
  data: T | null;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const tick = async () => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!cancelled.current) {
        setData(json);
        setError(null);
      }
    } catch (e) {
      if (!cancelled.current) setError((e as Error).message);
    }
  };

  useEffect(() => {
    cancelled.current = false;
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled.current = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, intervalMs]);

  return { data, error, refresh: tick };
}
