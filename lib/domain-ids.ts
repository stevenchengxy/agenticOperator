// Single source of truth for the Allmeta/Neo4j domain ids that AO ships
// hardcoded agent packs for.
//
// Domains in the business-domain switcher are sourced LIVE from Allmeta — AO
// never invents domain ids. But two packs are hardcoded against a specific id:
//   - the recruitment production agents (AGENT_MAP / the main Inngest app)
//   - the energy-dispatch ontology agents (snapshot + factory)
// When you rename those domains in Allmeta Studio, update the two ids here (and,
// for energy, rename the snapshot dir to match) — nothing else.
//
// Everything else (the switcher list, names, colors) derives from the live id,
// so renaming any OTHER domain in Allmeta needs no code change at all.

/** Allmeta domain id for the recruitment production agents. Primary = RAAS-v1
 *  (it holds the live ontology — 23 actions / 262 rules). 招聘-v1 is the demoted
 *  legacy name and is no longer the recruitment subject. */
export const RECRUITMENT_DOMAIN_ID = "RAAS-v1";

/** Allmeta domain id for the energy-dispatch ontology agent pack. Must match
 *  the snapshot dir name under lib/ontology-generator/snapshots/. */
export const ENERGY_DOMAIN_ID = "能源调度-v1";

/** Stable ASCII namespace for energy Inngest event names — decoupled from the
 *  (possibly CJK) domain id so event names stay ASCII even if the id changes. */
export const ENERGY_EVENT_NS = "energy";

/** Allmeta domain id for the cost-control (费控) ontology agent pack. Must match
 *  the snapshot dir name under lib/ontology-generator/snapshots/. */
export const COST_CONTROL_DOMAIN_ID = "费控-v1";

/** Stable ASCII namespace for cost-control Inngest event names (e.g.
 *  feikong/EXPENSE_SUBMITTED) — same rationale as ENERGY_EVENT_NS. */
export const COST_CONTROL_EVENT_NS = "feikong";

/** Map a (runnable) domain id → its ASCII Inngest event namespace. Used by the
 *  generalized human-decision route to send `<ns>/HUMAN_DECISION` and to derive
 *  the gate-notification dedupe prefix. Returns null for domains with no
 *  runnable pack (recruitment has no per-domain event namespace). */
export function eventNsForDomain(id: string | null | undefined): string | null {
  if (id === ENERGY_DOMAIN_ID) return ENERGY_EVENT_NS;
  if (id === COST_CONTROL_DOMAIN_ID) return COST_CONTROL_EVENT_NS;
  return null;
}

/** True when a domain id refers to the recruitment pack (primary = RAAS-v1).
 *  Empty/absent domain defaults to recruitment (the app's original single-domain
 *  behavior). Accepts the lowercase `raas` alias. NOTE: `招聘-v1` is intentionally
 *  NOT matched — it was demoted from being the recruitment subject (RAAS-v1 took
 *  over), so it no longer binds to the main app. */
export function isRecruitmentDomain(id: string | null | undefined): boolean {
  return !id || id === RECRUITMENT_DOMAIN_ID || id === "raas";
}

/** A clean, short display name derived from a domain id: strips a trailing
 *  version suffix (`-v1`, `-001`, `-v0_1_3`). e.g. 能源调度-v1 → 能源调度,
 *  R7-001 → R7, 招聘-v1 → 招聘. */
export function friendlyDomainName(id: string): string {
  const stripped = id.replace(/-v?[\d_.]+$/i, "").trim();
  return stripped || id;
}

/** Deterministic accent color (OKLCH) for a domain id, so each domain has a
 *  stable hue without a hand-maintained color table. */
export function colorForDomain(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `oklch(0.64 0.16 ${h})`;
}
