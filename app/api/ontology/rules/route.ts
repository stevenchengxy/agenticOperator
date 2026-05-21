// GET /api/ontology/rules
//
// Lists ALL matchResume rules — used by the Rule Check Dashboard hero
// grid to show the ontology full set (including Dead Rules that never
// fire in any audit window). Wraps fetchRulesForMatchResume which
// already handles the ontology-api → JSON fallback flow.

import { NextResponse } from 'next/server';
import { fetchRulesForMatchResume } from '@/lib/rule-check/ontology-source';

export const revalidate = 30; // 30s server-side ISR

export async function GET(): Promise<Response> {
  try {
    const result = await fetchRulesForMatchResume();
    return NextResponse.json({
      ok: true,
      rules: result.rules,
      source: result.source,
      fetched_at: new Date().toISOString(),
      ...(result.drift ? { drift: result.drift } : {}),
      ...(result.api_error ? { api_error: result.api_error } : {}),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
