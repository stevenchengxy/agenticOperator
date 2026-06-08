// Ontology Generator — inference engine.
//
// The "real ontology read" half of the page: findDanglingEvents runs genuine
// gap analysis over the live event catalog (events that are published but have
// no subscriber → a missing downstream consumer agent). inferAgents returns the
// domain's curated candidates, annotated with whether each candidate's trigger
// event actually exists in the catalog (ontologyGrounded).

import { EVENT_CATALOG, type EventDef } from "@/lib/events-catalog";
import { resolveProfile } from "./profiles";
import type { InferResult, InferredAgentCandidate } from "./types";
import { fetchDomainOntology, hasSnapshot, type DomainOntology } from "./ontology-source";
import { deriveAgents, type DerivedAgent } from "./analyze";

/**
 * Dangling events: published by something but consumed by no one. These are the
 * raw ontology signal that motivates inferring a new consumer agent.
 */
export function findDanglingEvents(
  catalog: EventDef[],
): { name: string; publishers: string[] }[] {
  return catalog
    .filter((e) => e.publishers.length > 0 && e.subscribers.length === 0)
    .map((e) => ({ name: e.name, publishers: [...e.publishers] }));
}

/**
 * Build the infer response for an APP domain (id + optional display name).
 * Resolves the ontology via resolveProfile, then annotates each curated
 * candidate with whether its trigger event exists in the live catalog.
 */
export function inferAgents(domainId: string, domainName?: string): InferResult {
  const profile = resolveProfile(domainId, domainName);
  const catalogEventNames = new Set(EVENT_CATALOG.map((e) => e.name));
  const dangling = findDanglingEvents(EVENT_CATALOG);

  const candidates = profile.candidates.map((c) => ({
    ...c,
    ontologyGrounded: catalogEventNames.has(c.triggerEvent),
  }));

  return {
    // Echo back the APP domain id (not the curated profile's internal id) so
    // generated drafts persist scoped to the real domain.
    domainId,
    counts: profile.counts,
    candidates,
    danglingEvents: dangling.map((d) => d.name),
  };
}

// ── Real-ontology inference (Allmeta domain id → derived agents) ─────────────
//
// For domains backed by a real ontology (in-repo snapshot or live Allmeta), the
// candidates ARE the actions: every actor=Agent action is an LLM agent and every
// actor=Human action is a simulated-human responder. No curated profile.

const ICON_COLOR_LLM = "oklch(0.62 0.14 200)";
const ICON_COLOR_SIM = "oklch(0.6 0.04 260)";

/** Events emitted by some action but consumed by none → the wiring gaps. */
function danglingFromOntology(onto: DomainOntology): string[] {
  const consumed = new Set<string>();
  const emitted = new Set<string>();
  for (const a of onto.actions) {
    for (const e of a.trigger ?? []) consumed.add(e);
    for (const e of a.triggered_event ?? []) emitted.add(e);
  }
  return [...emitted].filter((e) => !consumed.has(e)).sort();
}

function toCandidate(spec: DerivedAgent): InferredAgentCandidate {
  return {
    key: spec.key,
    short: spec.short,
    slug: spec.slug,
    nameZh: spec.nameZh,
    nameEn: spec.nameEn,
    agentId: spec.short,
    descZh: spec.descZh,
    descEn: spec.descEn,
    triggerEvent: spec.triggerEvents[0] ?? "(入口)",
    emitEvent: spec.emitEvents[0] ?? "(无)",
    rationaleZh: spec.rationaleZh,
    rationaleEn: spec.rationaleEn,
    confidence: spec.confidence,
    iconChar: spec.kind === "llm" ? "智" : "人",
    iconColor: spec.kind === "llm" ? ICON_COLOR_LLM : ICON_COLOR_SIM,
    ontologyGrounded: true,
  };
}

/** True when this domain id has a real ontology we can derive agents from. */
export function hasRealOntology(domainId: string): boolean {
  return hasSnapshot(domainId);
}

/** Build the infer response from an already-fetched ontology (pure). */
export function buildInferResult(onto: DomainOntology): InferResult {
  const specs = deriveAgents(onto);
  return {
    domainId: onto.domainId,
    counts: {
      rules: onto.rules.length,
      dataObjects: onto.objects.length,
      actions: onto.actions.length,
      events: onto.events.length,
      workflow: onto.workflow.length,
    },
    candidates: specs.map(toCandidate),
    danglingEvents: danglingFromOntology(onto),
  };
}

/** Build the infer response from the real ontology of an Allmeta domain id. */
export async function inferFromOntology(domainId: string): Promise<InferResult> {
  return buildInferResult(await fetchDomainOntology(domainId));
}
