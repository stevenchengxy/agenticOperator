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

import type { Inngest } from "inngest";
import { loadSnapshotOntology, type OntologyEvent } from "@/lib/ontology-generator/ontology-source";
import { deriveAgents } from "@/lib/ontology-generator/analyze";
import { ENERGY_DOMAIN_ID, ENERGY_EVENT_NS } from "@/lib/domain-ids";
import { makeOntologyAgent } from "./make-agent";
import type { AgentFactoryOpts } from "@/server/inngest/agent-factory/types";
import { ENERGY_BEHAVIORS } from "./behaviors";
import type { ScenarioData } from "./sim-data";

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

/** Compact dataset summary for the LLM prompt — keeps the real numbers visible. */
function energyDatasetBrief(d: ScenarioData | null): string {
  if (!d) return "";
  return (
    `业务日 ${d.businessDate}｜${d.planType}｜FC ${d.fcNo}｜GZL ${d.gzlNo}｜` +
    `水位 ${d.waterLevelM}m(汛限 ${d.limits.floodLimitM})｜入库 ${d.inflowM3s}m³/s｜` +
    `置信度 ${d.forecastConfidence}｜关口偏差 ${d.gzlDeviationPct}%｜断面峰值 ${d.sectionPeakMW}MW`
  );
}

// archiveCase (归档结案) is the chain's terminal action — when it finishes the
// run is complete, so the factory flips WorkflowRun → completed (otherwise every
// energy run shows a perpetual "运行中" in /monitor).
const TERMINAL_ACTIONS = new Set(["archiveCase"]);

const opts: AgentFactoryOpts<ScenarioData> = {
  domainId: ENERGY_DOMAIN_ID,
  eventNs: ENERGY_EVENT_NS,
  seedEvent: ENERGY_SEED_EVENT,
  eventsByName,
  objectNameById,
  branchActions: BRANCH_ACTIONS,
  terminalActions: TERMINAL_ACTIONS,
  behaviors: ENERGY_BEHAVIORS,
  datasetBrief: energyDatasetBrief,
};

/** Build the 28 real energy agent functions bound to the given Inngest client.
 *  The per-domain app (domain-app.ts) calls this with the domain's own client so
 *  energy runs as its OWN app (agentic-operator-能源调度-v1) — real rule-check +
 *  HITL gates, NOT sleep+emit shells — without polluting the recruitment app. */
export function buildEnergyFunctions(client: Inngest) {
  return specs.map((spec) => makeOntologyAgent(spec, opts, client));
}

/** The derived specs (for diagnostics / tests). */
export const energySpecs = specs;
