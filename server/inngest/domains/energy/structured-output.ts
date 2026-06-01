// Structured-output helpers for ontology agents.
//
// Each agent asks the LLM to return the JSON payload for the event it emits —
// the keys are the emitted event's `event_data` field names. The LLM is free-
// form, so we (a) give it a precise schema hint and (b) parse-or-synthesize:
// if the model returns valid JSON we use it (back-filling any missing keys),
// otherwise we synthesize a deterministic payload from the event_data schema so
// the chain never stalls on a bad completion.

import type { OntologyEvent } from "@/lib/ontology-generator/ontology-source";

type EventDataField = { name: string; type: string; target_object: string | null };

function fields(event: OntologyEvent | undefined): EventDataField[] {
  return event?.payload?.event_data ?? [];
}

/** A compact, deterministic description of the JSON the LLM should return. */
export function buildSchemaHint(event: OntologyEvent | undefined): string {
  const fs = fields(event);
  if (fs.length === 0) {
    return 'Return a JSON object {"ok": true, "summary": "<one line>"}.';
  }
  const lines = fs.map((f) => `  "${f.name}": <${f.type}>${f.target_object ? ` // ${f.target_object}` : ""}`);
  return `Return ONLY a JSON object with exactly these keys:\n{\n${lines.join(",\n")}\n}`;
}

/** Deterministic default value for a field type (no randomness). */
function defaultFor(field: EventDataField, seed: string): unknown {
  const t = (field.type || "String").toLowerCase();
  switch (t) {
    case "boolean":
      return true;
    case "integer":
    case "number":
      // deterministic small number derived from the field name length
      return field.name.length;
    case "array":
      return [];
    case "object":
      return {};
    case "date":
      // fixed marker — real timestamps are stamped by the caller, not here
      return "1970-01-01T00:00:00.000Z";
    case "enum":
      return "OK";
    default:
      return `${field.name}:${seed}`;
  }
}

/** Pull the first balanced JSON object out of an LLM completion (handles fences/prose). */
function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(body.slice(start, i + 1));
          return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export type ParsedPayload = {
  payload: Record<string, unknown>;
  /** true when the LLM JSON was unusable and we filled the whole payload. */
  synthesized: boolean;
};

/**
 * Parse the LLM completion into the emitted event's payload, back-filling any
 * missing event_data keys with deterministic defaults. Falls back to a fully
 * synthesized payload when no JSON object can be recovered.
 */
export function parseOrSynthesize(
  text: string,
  event: OntologyEvent | undefined,
  seed = "sim",
): ParsedPayload {
  const fs = fields(event);
  const parsed = extractJsonObject(text);

  if (!parsed) {
    const payload: Record<string, unknown> = {};
    for (const f of fs) payload[f.name] = defaultFor(f, seed);
    if (fs.length === 0) payload.ok = true;
    return { payload, synthesized: true };
  }

  // Back-fill any keys the model omitted so downstream payloads are complete.
  const payload: Record<string, unknown> = { ...parsed };
  for (const f of fs) if (!(f.name in payload)) payload[f.name] = defaultFor(f, seed);
  return { payload, synthesized: false };
}
