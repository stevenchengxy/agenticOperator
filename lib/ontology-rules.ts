// Dynamic per-action rule fetch from Allmeta / Neo4j.
//
// AO's rule-check is driven by the ontology graph: a rule is reachable for an
// action via the `Action → action_step → Rule` relationship edges. The Allmeta
// studio exposes this as a per-action endpoint:
//     GET /api/v1/ontology/actions/{action}/rules?domain=X
// which returns the rules linked to that action (traversing the step edges).
//
// This is the capability the REAL rule-check agent uses (getLiveRuleCatalog /
// fetchActionRulesLive). Exposed here as a thin, generic function so:
//   1. the `ontology.fetchActionRules` factory tool can wrap it, and
//   2. generated agent code can `import { fetchOntologyActionRules }` natively.
//
// Cross-domain: works for any domain whose ontology has the action→step→rule
// edges (recruitment, energy, 费控 …), so any domain's rule-check agent can
// fetch its live rules instead of having them baked into the prompt.

export type OntologyRuleLite = {
  id: string;
  name: string;
  rule: string;
  enforcement: string;
  failurePolicy: string;
};

export type ActionRulesResult = {
  action: string;
  domain: string;
  ruleCount: number;
  rules: OntologyRuleLite[];
};

/** Fetch the rules linked to one ontology action (live, via the action→step→rule
 *  graph edges). Returns an empty list (never throws) when Allmeta is
 *  unconfigured or the call fails — so a rule-check agent degrades to "no
 *  blocking rules found" rather than hanging. */
export async function fetchOntologyActionRules(
  actionName: string,
  domain: string,
): Promise<ActionRulesResult> {
  const base = (process.env.ALLMETA_BASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.ALLMETA_API_KEY ?? "";
  const empty: ActionRulesResult = { action: actionName, domain, ruleCount: 0, rules: [] };
  if (!base) return empty;

  const url = `${base}/api/v1/ontology/actions/${encodeURIComponent(actionName)}/rules?domain=${encodeURIComponent(domain)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    });
    if (!res.ok) return empty;
    const body = (await res.json()) as Record<string, unknown>;
    const raw = Array.isArray(body.rules) ? (body.rules as Array<Record<string, unknown>>) : [];
    const rules: OntologyRuleLite[] = raw.map((r) => ({
      id: String(r.id ?? ""),
      name: String(r.businessLogicRuleName ?? r.name ?? r.id ?? ""),
      rule: String(r.standardizedLogicRule ?? r.rule ?? "").slice(0, 600),
      enforcement: String(r.enforcementLevel ?? "optional"),
      failurePolicy: String(r.failurePolicy ?? "warn"),
    }));
    return { action: actionName, domain, ruleCount: rules.length, rules };
  } catch {
    return empty;
  }
}
