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

export const DIRECTION_META: Record<EventDirection, { zh: string; en: string; color: string; arrow: "in" | "out" | "—" }> = {
  in:      { zh: "接收", en: "Received",  color: "var(--c-info)",   arrow: "in" },
  out:     { zh: "发布", en: "Published", color: "var(--c-accent)", arrow: "out" },
  unknown: { zh: "未知", en: "Unknown",   color: "var(--c-ink-4)",  arrow: "—" },
};
