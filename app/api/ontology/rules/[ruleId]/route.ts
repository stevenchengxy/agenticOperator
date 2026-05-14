// GET /api/ontology/rules/[ruleId]
//
// 单条规则查询 — 给前端 audit drawer 点 rule_flag 展开"完整规则定义"用。
// 优先 Neo4j 直查(跟用户灌入的 schema 同步),fallback 到 lib/rule-check/rules.json。
//
// 返回 source 字段让前端能显示数据来源(neo4j-direct vs json-fallback)。

import { NextResponse } from 'next/server';

import { fetchSingleRule } from '@/lib/rule-check/ontology-source';
import type { Rule } from '@/lib/rule-check/types';

export const dynamic = 'force-dynamic';

export type OntologyRuleResponse =
  | {
      ok: true;
      rule: Rule;
      source: 'ontology-api' | 'json-fallback';
    }
  | { ok: false; reason: 'not_found' | 'error'; error?: string };

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ ruleId: string }> },
) {
  const { ruleId } = await ctx.params;
  try {
    const result = await fetchSingleRule(ruleId);
    if (!result) {
      return NextResponse.json<OntologyRuleResponse>(
        { ok: false, reason: 'not_found' },
        { status: 404 },
      );
    }
    return NextResponse.json<OntologyRuleResponse>({
      ok: true,
      rule: result.rule,
      source: result.source,
    });
  } catch (e) {
    return NextResponse.json<OntologyRuleResponse>(
      {
        ok: false,
        reason: 'error',
        error: (e as Error).message.slice(0, 300),
      },
      { status: 500 },
    );
  }
}
