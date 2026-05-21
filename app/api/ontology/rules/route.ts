// GET /api/ontology/rules
//
// Lists ALL matchResume rules — used by the Rule Check Dashboard hero
// grid to show the ontology full set (including Dead Rules that never
// fire in any audit window). Wraps fetchRulesForMatchResume which
// already handles the ontology-api → JSON fallback flow.
//
// Note: FetchRulesResult.steps is intentionally omitted — list consumers
// don't need the per-step grouping; that's only useful in single-rule context.

import { NextResponse } from 'next/server';
import { fetchRulesForMatchResume } from '@/lib/rule-check/ontology-source';
import type { Rule } from '@/lib/rule-check/types';

export const revalidate = 30; // 30s server-side ISR

type Success = {
  ok: true;
  rules: Rule[];
  source: 'ontology-api' | 'json-fallback';
  fetched_at: string;
  drift?: { only_in_api: string[]; only_in_json: string[] };
  api_error?: string;
};
type Failure = { ok: false; error: string };

export async function GET(): Promise<Response> {
  try {
    const result = await fetchRulesForMatchResume();
    return NextResponse.json<Success>({
      ok: true,
      rules: result.rules,
      source: result.source,
      fetched_at: new Date().toISOString(),
      ...(result.drift ? { drift: result.drift } : {}),
      ...(result.api_error ? { api_error: result.api_error } : {}),
    });
  } catch (e) {
    return NextResponse.json<Failure>(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
