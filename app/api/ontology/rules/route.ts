// GET /api/ontology/rules?domain=<id>
//
// Lists a business domain's full ontology rule set — used by the Rule Check
// Dashboard hero grid to show every rule (including Dead Rules that never fire
// in any audit window).
//
//   - recruitment (招聘) → fetchRulesForMatchResume (RAAS-v1 ontology + JSON
//     fallback, the original matchResume path).
//   - any other Allmeta domain (费控 / 能源调度 / …) → the domain's rules read
//     live from Allmeta (or the in-repo snapshot), normalized to the Rule shape.

import { NextResponse } from 'next/server';
import { fetchRulesForMatchResume } from '@/lib/rule-check/ontology-source';
import { fetchDomainOntology } from '@/lib/ontology-generator/ontology-source';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import type { Rule } from '@/lib/rule-check/types';

export const dynamic = 'force-dynamic';

type Success = {
  ok: true;
  rules: Rule[];
  source: 'ontology-api' | 'json-fallback';
  fetched_at: string;
  drift?: { only_in_api: string[]; only_in_json: string[] };
  api_error?: string;
};
type Failure = { ok: false; error: string };

function isRecruitmentDomain(domain: string): boolean {
  return !domain || domain === RECRUITMENT_DOMAIN_ID || domain === 'RAAS-v1' || domain === 'raas';
}

function parseEntities(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return v ? [v] : [];
    }
  }
  return [];
}

/** Map an ontology rule node (snapshot camelCase OR Allmeta snake_case) → Rule. */
function toRuleCheckRule(n: Record<string, unknown>): Rule {
  const s = (snake: string, camel: string): string => {
    const v = n[snake] ?? n[camel];
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  };
  return {
    id: s('rule_id', 'id'),
    specificScenarioStage: s('scenario_stage', 'specificScenarioStage'),
    businessLogicRuleName: s('rule_name', 'businessLogicRuleName'),
    applicableClient: s('applicable_client', 'applicableClient') || '通用',
    applicableDepartment: s('applicable_department', 'applicableDepartment'),
    submissionCriteria: s('submission_criteria', 'submissionCriteria'),
    standardizedLogicRule: s('standardized_logic', 'standardizedLogicRule'),
    relatedEntities: parseEntities(n.related_entities ?? n.relatedEntities),
    businessBackgroundReason: s('business_reason', 'businessBackgroundReason'),
    ruleSource: s('rule_source', 'ruleSource'),
    executor: n.executor === 'Human' ? 'Human' : 'Agent',
    enforcementLevel:
      n.enforcementLevel === 'optional' || n.enforcement_level === 'optional'
        ? 'optional'
        : n.enforcementLevel === 'mandatory' || n.enforcement_level === 'mandatory'
          ? 'mandatory'
          : undefined,
    failurePolicy:
      n.failurePolicy === 'warn' || n.failure_policy === 'warn'
        ? 'warn'
        : n.failurePolicy === 'block' || n.failure_policy === 'block'
          ? 'block'
          : undefined,
  };
}

export async function GET(req: Request): Promise<Response> {
  const domain = new URL(req.url).searchParams.get('domain')?.trim() ?? '';
  try {
    // Recruitment keeps the original matchResume rule path.
    if (isRecruitmentDomain(domain)) {
      const result = await fetchRulesForMatchResume();
      return NextResponse.json<Success>({
        ok: true,
        rules: result.rules,
        source: result.source,
        fetched_at: new Date().toISOString(),
        ...(result.drift ? { drift: result.drift } : {}),
        ...(result.api_error ? { api_error: result.api_error } : {}),
      });
    }

    // Other domains: read this domain's rules from Allmeta (or snapshot).
    const onto = await fetchDomainOntology(domain);
    const rules = onto.rules.map((r) => toRuleCheckRule(r as Record<string, unknown>));
    return NextResponse.json<Success>({
      ok: true,
      rules,
      source: onto.source === 'allmeta' ? 'ontology-api' : 'json-fallback',
      fetched_at: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json<Failure>(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
