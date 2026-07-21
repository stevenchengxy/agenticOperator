// Normalize a raw ontology rule node → the rule-check `Rule` shape.
//
// Ontology rules arrive in two casings: Allmeta graph nodes are snake_case
// (rule_id / scenario_stage / rule_name / standardized_logic …) while the
// in-repo snapshots are camelCase. Both normalize to the same `Rule`. Extracted
// from app/api/ontology/rules/route.ts so server-side rule-check agents (energy
// validateConstraints / triageScheme) reuse the exact same normalizer instead
// of re-implementing it.

import type { Rule } from "./types";

export function parseEntities(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return v ? [v] : [];
    }
  }
  return [];
}

/** Map an ontology rule node (snapshot camelCase OR Allmeta snake_case) → Rule. */
export function normalizeOntologyRule(n: Record<string, unknown>): Rule {
  const s = (snake: string, camel: string): string => {
    const v = n[snake] ?? n[camel];
    return typeof v === "string" ? v : v == null ? "" : String(v);
  };
  return {
    id: s("rule_id", "id"),
    specificScenarioStage: s("scenario_stage", "specificScenarioStage"),
    businessLogicRuleName: s("rule_name", "businessLogicRuleName"),
    applicableClient: s("applicable_client", "applicableClient") || "通用",
    applicableDepartment: s("applicable_department", "applicableDepartment"),
    submissionCriteria: s("submission_criteria", "submissionCriteria"),
    standardizedLogicRule: s("standardized_logic", "standardizedLogicRule"),
    relatedEntities: parseEntities(n.related_entities ?? n.relatedEntities),
    businessBackgroundReason: s("business_reason", "businessBackgroundReason"),
    ruleSource: s("rule_source", "ruleSource"),
    executor: n.executor === "Human" ? "Human" : "Agent",
    enforcementLevel:
      n.enforcementLevel === "optional" || n.enforcement_level === "optional"
        ? "optional"
        : n.enforcementLevel === "mandatory" || n.enforcement_level === "mandatory"
          ? "mandatory"
          : undefined,
    failurePolicy:
      n.failurePolicy === "warn" || n.failure_policy === "warn"
        ? "warn"
        : n.failurePolicy === "block" || n.failure_policy === "block"
          ? "block"
          : undefined,
  };
}
