// GET /api/ontology/rules/[ruleId]
//
// Resolves a single matchResume rule by id. Used by the Rule Check audit
// drawer's "查看原规则定义" expander to surface the canonical rule definition
// without re-fetching the whole action.
//
// Resolution order (mirrors fetchRulesForMatchResume in lib/rule-check/ontology-source.ts):
//   1. ALLMETA_BASE_URL + ALLMETA_API_KEY configured →
//      fetch the matchResume action via fetchAction(), intersect by rule_id,
//      hydrate metadata from JSON (the JSON file remains source-of-truth for
//      fields like applicableDepartment / standardizedLogicRule until allmeta
//      exposes them on ActionRule).
//   2. Falls back to bundled rules.json (json-fallback) when ontology API is
//      unreachable or doesn't contain the id.

import { NextResponse } from 'next/server';
import { loadAllRules } from '@/lib/rule-check/ontology';
import { fetchAction, OntologyGenError } from '@/lib/ontology-gen';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import type { Rule } from '@/lib/rule-check/types';

type Success = { ok: true; rule: Rule; source: 'ontology-api' | 'json-fallback' };
type Failure = { ok: false; reason: 'not_found' | 'api_error' | 'bad_request'; error?: string };

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ruleId: string }> },
): Promise<Response> {
  const { ruleId: raw } = await params;
  const ruleId = decodeURIComponent(raw ?? '').trim();

  if (!ruleId) {
    return NextResponse.json<Failure>(
      { ok: false, reason: 'bad_request', error: 'ruleId is required' },
      { status: 400 },
    );
  }

  const jsonRules = loadAllRules();
  const fromJson = jsonRules.find((r) => r.id === ruleId);

  const apiBase = process.env.ALLMETA_BASE_URL;
  const apiToken = process.env.ALLMETA_API_KEY;

  if (!apiBase || !apiToken) {
    if (fromJson) {
      return NextResponse.json<Success>({ ok: true, rule: fromJson, source: 'json-fallback' });
    }
    return NextResponse.json<Failure>(
      { ok: false, reason: 'not_found', error: `rule_id="${ruleId}" not in rules.json` },
      { status: 404 },
    );
  }

  try {
    const action = await fetchAction({
      actionRef: 'matchResume',
      domain: process.env.ALLMETA_DOMAIN ?? RECRUITMENT_DOMAIN_ID,
      apiBase,
      apiToken,
      timeoutMs: 5000,
    });
    const apiIds = new Set<string>();
    for (const step of action.actionSteps ?? []) {
      for (const rule of step.rules ?? []) {
        if (typeof rule.id === 'string' && rule.id.trim()) apiIds.add(rule.id);
      }
    }
    if (apiIds.has(ruleId) && fromJson) {
      return NextResponse.json<Success>({ ok: true, rule: fromJson, source: 'ontology-api' });
    }
    if (fromJson) {
      return NextResponse.json<Success>({ ok: true, rule: fromJson, source: 'json-fallback' });
    }
    return NextResponse.json<Failure>(
      { ok: false, reason: 'not_found', error: `rule_id="${ruleId}" not in matchResume action` },
      { status: 404 },
    );
  } catch (err) {
    if (fromJson) {
      return NextResponse.json<Success>({ ok: true, rule: fromJson, source: 'json-fallback' });
    }
    const errType =
      err instanceof OntologyGenError ? err.name : err instanceof Error ? err.name : 'Unknown';
    const errMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<Failure>(
      { ok: false, reason: 'api_error', error: `${errType}: ${errMsg.slice(0, 200)}` },
      { status: 502 },
    );
  }
}
