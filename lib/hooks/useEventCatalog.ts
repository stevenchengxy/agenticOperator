// React hook — fetches /api/events once and caches in module scope.
// All UI components that need event catalog data go through this hook
// instead of importing lib/events-catalog.ts directly. That way changes
// in Allmeta Ontology (synced into prisma.eventDefinition) propagate
// to the UI within one Allmeta-sync interval (or instantly via the
// manual refresh button on /events).
//
// Per spec 2026-05-24 §5.1.

"use client";
import { useEffect, useState } from "react";
import type { EventsResponse, EventContract } from "@/lib/api/types";

const CACHE_TTL_MS = 30_000;
let cached: { ts: number; data: EventsResponse } | null = null;
const subscribers = new Set<(d: EventsResponse | null) => void>();

export type UseEventCatalogResult = {
  events: EventContract[];
  loading: boolean;
  lastSyncAt: string | null;
  staleness: "fresh" | "stale" | "never";
  refresh: () => Promise<void>;
};

function deriveStaleness(iso: string | null | undefined): "fresh" | "stale" | "never" {
  if (!iso) return "never";
  const age = Date.now() - new Date(iso).getTime();
  if (age < 5 * 60 * 1000) return "fresh";
  return "stale";
}

async function doFetch(): Promise<void> {
  try {
    const r = await fetch("/api/events");
    if (!r.ok) return;
    const d = (await r.json()) as EventsResponse;
    cached = { ts: Date.now(), data: d };
    subscribers.forEach((fn) => fn(d));
  } catch {
    // keep prior cached data
  }
}

export function useEventCatalog(): UseEventCatalogResult {
  const [data, setData] = useState<EventsResponse | null>(
    cached && Date.now() - cached.ts < CACHE_TTL_MS ? cached.data : null
  );

  useEffect(() => {
    subscribers.add(setData);
    if (!cached || Date.now() - cached.ts >= CACHE_TTL_MS) {
      void doFetch();
    }
    return () => {
      subscribers.delete(setData);
    };
  }, []);

  return {
    events: data?.events ?? [],
    loading: !data,
    lastSyncAt: data?.meta.lastNeo4jSyncAt ?? null,
    staleness: deriveStaleness(data?.meta.lastNeo4jSyncAt),
    refresh: doFetch,
  };
}
