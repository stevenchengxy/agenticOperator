// Classifies an EventInstance.source string into "in" (received from outside)
// vs "out" (published by AO) vs "unknown".

export type EventDirection = "in" | "out" | "unknown";

const INBOUND_PREFIXES = ["raas-bridge", "manual.", "webhook."];
const OUTBOUND_PREFIXES = ["rpa.", "agent."];

export function classifySource(source: string | null | undefined): EventDirection {
  if (!source) return "unknown";
  const s = source.toLowerCase();
  for (const p of INBOUND_PREFIXES) if (s === p || s.startsWith(p)) return "in";
  for (const p of OUTBOUND_PREFIXES) if (s.startsWith(p)) return "out";
  return "unknown";
}

// ── Type-level direction, from the event catalog's `publishers` ────────────
//
// `classifySource` needs a per-instance EventInstance.source string, which the
// /events firehose can't reliably join to (AO-published events carry
// externalEventId=null). So we ALSO derive direction structurally from the
// event TYPE: every EventDef carries `publishers` (Neo4j-synced workflow
// action names). An event is "received" (接收) when its canonical producer is
// an external-intake boundary — the agents that pull data INTO the pipeline
// from outside (manual entry / client-system sync / channel resume collection,
// matching the designer's "来自 RAAS / 手动 / Webhook" semantics). Everything
// else is emitted by AO's own processing agents → "published" (发布).
//
// Edit this set if the intake boundary changes (e.g. a new webhook adapter).
export const INBOUND_PUBLISHERS = new Set<string>([
  "manualEntry", // REQUIREMENT_LOGGED — human manual entry
  "resumeCollection", // RESUME_DOWNLOADED — collected from external channels (the raas-bridge default event)
  "syncFromClientSystem", // REQUIREMENT_SYNCED / SYNC_FAILED_ALERT — pulled from the client's external system
]);

export function classifyByPublishers(publishers: string[] | null | undefined): EventDirection {
  if (!publishers || publishers.length === 0) return "unknown";
  if (publishers.some((p) => INBOUND_PUBLISHERS.has(p))) return "in";
  return "out";
}

export const DIRECTION_META: Record<EventDirection, { zh: string; en: string; color: string; arrow: "in" | "out" | "—" }> = {
  in:      { zh: "接收", en: "Received",  color: "var(--c-info)",   arrow: "in" },
  out:     { zh: "发布", en: "Published", color: "var(--c-accent)", arrow: "out" },
  unknown: { zh: "未知", en: "Unknown",   color: "var(--c-ink-4)",  arrow: "—" },
};
