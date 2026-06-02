// Energy dispatch (能源调度) ontology agents.
//
// Builds one Inngest function per ontology action via the shared factory. 17
// actor=Agent actions become real LLM agents; 11 actor=Human actions become
// simulated-human auto-responders. All gated by ENERGY_AGENTS=1 at the
// functions.ts registration site, and individually self-gated on
// AgentVersion.status (deploy = activate).
//
// The domain id (ENERGY_DOMAIN_ID, may be CJK) is the Allmeta id used for
// scoping / snapshot / AgentVersion.domain; Inngest EVENT names use a stable
// ASCII namespace (ENERGY_EVENT_NS) so they never contain CJK.

import { loadSnapshotOntology, type OntologyEvent } from "@/lib/ontology-generator/ontology-source";
import { deriveAgents } from "@/lib/ontology-generator/analyze";
import { ENERGY_DOMAIN_ID, ENERGY_EVENT_NS } from "@/lib/domain-ids";
import { makeOntologyAgent, type AgentFactoryOpts } from "./make-agent";

export { ENERGY_DOMAIN_ID };
export const ENERGY_SEED_EVENT = `${ENERGY_EVENT_NS}/DISPATCH_CYCLE_STARTED`;

// Loop / forward-branch actions — gated behind enableBranches so the default
// demo seed produces a clean linear ingest→archive trace. (Once-per-case dedup
// already prevents infinite loops; this just trims noise.)
const BRANCH_ACTIONS = new Set([
  "rollingRevision",
  "raiseRiskEvent",
  "declareMarket",
  "assessForecastAccuracy",
]);

const onto = loadSnapshotOntology(ENERGY_DOMAIN_ID);
const specs = deriveAgents(onto);

const eventsByName = new Map<string, OntologyEvent>(onto.events.map((e) => [e.name, e]));
const objectNameById = new Map<string, string>(onto.objects.map((o) => [o.id, o.name]));

const opts: AgentFactoryOpts = {
  domainId: ENERGY_DOMAIN_ID,
  eventNs: ENERGY_EVENT_NS,
  seedEvent: ENERGY_SEED_EVENT,
  eventsByName,
  objectNameById,
  branchActions: BRANCH_ACTIONS,
};

export const energyFunctions = specs.map((spec) => makeOntologyAgent(spec, opts));

/** The derived specs (for diagnostics / tests). */
export const energySpecs = specs;
