// Cost-control (费控) ontology agents.
//
// Builds one Inngest function per ontology action via the shared factory
// (../energy/make-agent — domain-agnostic). 10 actor=Agent actions become real
// agents (most with a deterministic behavior); 4 actor=Human actions become
// simulated-human auto-responders. Each function self-gates on
// AgentVersion.status (deploy = activate).
//
// `buildCostControlFunctions(client)` registers them on whatever Inngest client
// the caller passes — server/inngest/domain-app.ts passes the per-domain client
// (agentic-operator-费控-v1) so they NEVER touch the recruitment main app.
//
// Event names use the ASCII namespace COST_CONTROL_EVENT_NS (feikong/…) so they
// never contain CJK, decoupled from the (CJK) domain id 费控-v1.

import type { Inngest } from "inngest";
import { loadSnapshotOntology, type OntologyEvent } from "@/lib/ontology-generator/ontology-source";
import { deriveAgents } from "@/lib/ontology-generator/analyze";
import { COST_CONTROL_DOMAIN_ID, COST_CONTROL_EVENT_NS } from "@/lib/domain-ids";
import { makeOntologyAgent } from "../energy/make-agent";
import type { AgentFactoryOpts } from "@/server/inngest/agent-factory/types";
import { FEIKONG_BEHAVIORS } from "./behaviors";
import { feikongDatasetBrief, type FeikongScenarioData } from "./sim-data";

export { COST_CONTROL_DOMAIN_ID };
/** Seed event that kicks off a 费控 case — consumed by runInvoiceOCR. */
export const COST_CONTROL_SEED_EVENT = `${COST_CONTROL_EVENT_NS}/EXPENSE_SUBMITTED`;

// 费控链路是线性的(submitExpenseClaim 的 RETURNED_FOR_FIX 回环靠 once-per-case
// claim 自然收敛),无需 branch gating。
const BRANCH_ACTIONS = new Set<string>();

const onto = loadSnapshotOntology(COST_CONTROL_DOMAIN_ID);
const specs = deriveAgents(onto);

const eventsByName = new Map<string, OntologyEvent>(onto.events.map((e) => [e.name, e]));
const objectNameById = new Map<string, string>(onto.objects.map((o) => [o.id, o.name]));

const opts: AgentFactoryOpts<FeikongScenarioData> = {
  domainId: COST_CONTROL_DOMAIN_ID,
  eventNs: COST_CONTROL_EVENT_NS,
  seedEvent: COST_CONTROL_SEED_EVENT,
  eventsByName,
  objectNameById,
  branchActions: BRANCH_ACTIONS,
  behaviors: FEIKONG_BEHAVIORS,
  datasetBrief: feikongDatasetBrief,
};

/** Build the 费控 functions on a given Inngest client (per-domain app). */
export function buildCostControlFunctions(client: Inngest) {
  return specs.map((spec) => makeOntologyAgent(spec, opts, client));
}

/** The derived specs (for diagnostics / tests / deploy = activate). */
export const costControlSpecs = specs;
