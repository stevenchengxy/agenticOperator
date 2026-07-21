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
import { normalizeOntologyRule } from '@/lib/rule-check/normalize-ontology-rule';
import type { Rule } from '@/lib/rule-check/types';

export const dynamic = 'force-dynamic';

type Success = {
  ok: true;
  rules: Rule[];
  // 'ontology-api' = live Allmeta; 'snapshot' = AO-shipped curated in-repo
  // ontology (authoritative for runnable domains like 能源调度-v1 — NOT a
  // degradation); 'json-fallback' = recruitment's degraded lib/rules.json path.
  source: 'ontology-api' | 'json-fallback' | 'snapshot';
  fetched_at: string;
  drift?: { only_in_api: string[]; only_in_json: string[] };
  api_error?: string;
};
type Failure = { ok: false; error: string };

function isRecruitmentDomain(domain: string): boolean {
  return !domain || domain === RECRUITMENT_DOMAIN_ID || domain === 'RAAS-v1' || domain === 'raas';
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

    // Other domains: read this domain's rules from Allmeta, else the in-repo
    // snapshot (the curated, authoritative ontology AO ships for runnable
    // domains — Allmeta's copy of a new domain is often empty by design). A
    // snapshot read is NOT an error, so it gets its own 'snapshot' source
    // rather than being flattened into the degraded 'json-fallback'.
    const onto = await fetchDomainOntology(domain);
    const rules = onto.rules.map((r) => normalizeOntologyRule(r as Record<string, unknown>));
    return NextResponse.json<Success>({
      ok: true,
      rules,
      source: onto.source === 'allmeta' ? 'ontology-api' : 'snapshot',
      fetched_at: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json<Failure>(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
