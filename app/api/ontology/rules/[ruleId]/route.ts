// GET /api/ontology/rules/[ruleId]
//
// Resolves a single rule's canonical definition by id, for ANY domain + ANY
// stage. Used by the 规则检查·总览 rule-definition drawer and the audit drawer's
// "查看原规则定义" expander to surface the live Neo4j 原规则.
//
// Resolution (same source the 总览 lists — fetchDomainOntology, the raw :Rule
// nodes off /api/v1/ontology/rules, covering ALL stages, not just matchResume):
//   1. ALLMETA configured → fetchDomainOntology(domain), match by rule id OR
//      parsed business code, return the whole live rule (every stage). For
//      runnable non-recruitment domains, fall back to the in-repo snapshot when
//      live serves numeric ids but the audit flag uses the snapshot's code.
//   2. Recruitment: bundled rules.json (json-fallback) when ALLMETA is
//      unreachable or lacks the id.

import { NextResponse } from 'next/server';
import { loadAllRules } from '@/lib/rule-check/ontology';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import {
  fetchDomainOntology,
  hasSnapshot,
  loadSnapshotOntology,
} from '@/lib/ontology-generator/ontology-source';
import { normalizeOntologyRule } from '@/lib/rule-check/normalize-ontology-rule';
import { toEngineRules } from '@/lib/rule-check/engine';
import type { Rule } from '@/lib/rule-check/types';

type Success = { ok: true; rule: Rule; source: 'ontology-api' | 'json-fallback' | 'snapshot' };
type Failure = { ok: false; reason: 'not_found' | 'api_error' | 'bad_request'; error?: string };

function isRecruitmentDomain(domain: string): boolean {
  return !domain || domain === RECRUITMENT_DOMAIN_ID || domain === 'RAAS-v1' || domain === 'raas';
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ruleId: string }> },
): Promise<Response> {
  const { ruleId: raw } = await params;
  const ruleId = decodeURIComponent(raw ?? '').trim();
  const domain = new URL(req.url).searchParams.get('domain')?.trim() ?? '';

  if (!ruleId) {
    return NextResponse.json<Failure>(
      { ok: false, reason: 'bad_request', error: 'ruleId is required' },
      { status: 400 },
    );
  }

  // Non-recruitment domains (energy …): resolve the rule definition from the
  // domain's ontology (Allmeta live → in-repo snapshot), keyed by BOTH the
  // ontology id (e.g. "25") and the parsed business code (e.g. "CR-HYD-05") —
  // the recruitment sources below only know matchResume rules.
  if (!isRecruitmentDomain(domain)) {
    try {
      const findRule = (rules: Array<Record<string, unknown>>) =>
        toEngineRules(rules.map((r) => normalizeOntologyRule(r))).find(
          (r) => r.code === ruleId || r.id === ruleId,
        );

      const onto = await fetchDomainOntology(domain);
      const match = findRule(onto.rules as Array<Record<string, unknown>>);
      if (match) {
        return NextResponse.json<Success>({
          ok: true,
          rule: match.raw,
          source: onto.source === 'allmeta' ? 'ontology-api' : 'snapshot',
        });
      }

      // Live Allmeta serves runnable-domain rules under numeric ids with the
      // business code buried in the NAME ("RULE-INV-01 发票抬头/税号校验"), but
      // the rule-check engine evaluates the in-repo SNAPSHOT, so audit flags
      // reference the snapshot's business-code ids (费控 RULE-INV-01 / RULE-STD-01
      // …). When the live lookup misses, resolve the id against the snapshot —
      // it's keyed by that exact code and carries the full prompt/logic body.
      if (onto.source === 'allmeta' && hasSnapshot(domain)) {
        const snapMatch = findRule(loadSnapshotOntology(domain).rules as Array<Record<string, unknown>>);
        if (snapMatch) {
          return NextResponse.json<Success>({ ok: true, rule: snapMatch.raw, source: 'snapshot' });
        }
      }

      return NextResponse.json<Failure>(
        { ok: false, reason: 'not_found', error: `rule "${ruleId}" not found in domain ${domain}` },
        { status: 404 },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json<Failure>(
        { ok: false, reason: 'api_error', error: msg.slice(0, 200) },
        { status: 502 },
      );
    }
  }

  // Recruitment domain: resolve from the FULL domain ontology (ALL stages, raw
  // :Rule nodes) — the live Neo4j 原规则, the SAME source + domain the 总览 lists
  // (loadDomainRuleCatalog → fetchDomainOntology(ontoDomain)). We deliberately do
  // NOT use the matchResume action snapshot here: it only knows 简历匹配 rules
  // (~43) and its embedded standardizedLogicRule can drift from the rule node,
  // yet 总览 lets you click ANY stage's rule → the drawer must resolve all of
  // them. Bundled rules.json stays as the offline fallback (ALLMETA down).
  const ontoDomain = domain && domain.trim() ? domain : RECRUITMENT_DOMAIN_ID;
  const jsonRules = loadAllRules();
  const fromJson = jsonRules.find((r) => r.id === ruleId);

  const apiBase = process.env.ALLMETA_BASE_URL;
  const apiToken = process.env.ALLMETA_API_KEY;

  // ALLMETA 未配置 → 回退打包 JSON
  if (!apiBase || !apiToken) {
    if (fromJson) {
      return NextResponse.json<Success>({ ok: true, rule: fromJson, source: 'json-fallback' });
    }
    return NextResponse.json<Failure>(
      { ok: false, reason: 'not_found', error: `rule_id="${ruleId}" not in rules.json` },
      { status: 404 },
    );
  }

  // 优先 live ontology(fetchDomainOntology = /api/v1/ontology/rules 的生 :Rule
  // 节点,含**全部阶段**)→ 返回整条 live 规则(跟总览同源,id 或 业务 code 都能命中)。
  // API 失败 / 缺该 id 才回退打包 JSON。
  try {
    const onto = await fetchDomainOntology(ontoDomain);
    const match = toEngineRules(
      (onto.rules as Array<Record<string, unknown>>).map((r) => normalizeOntologyRule(r)),
    ).find((r) => r.id === ruleId || r.code === ruleId);
    if (match) {
      return NextResponse.json<Success>({
        ok: true,
        rule: match.raw,
        source: onto.source === 'allmeta' ? 'ontology-api' : 'snapshot',
      });
    }
    if (fromJson) {
      return NextResponse.json<Success>({ ok: true, rule: fromJson, source: 'json-fallback' });
    }
    return NextResponse.json<Failure>(
      { ok: false, reason: 'not_found', error: `rule_id="${ruleId}" not in domain ontology (${ontoDomain})` },
      { status: 404 },
    );
  } catch (err) {
    if (fromJson) {
      return NextResponse.json<Success>({ ok: true, rule: fromJson, source: 'json-fallback' });
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<Failure>(
      { ok: false, reason: 'api_error', error: errMsg.slice(0, 200) },
      { status: 502 },
    );
  }
}
