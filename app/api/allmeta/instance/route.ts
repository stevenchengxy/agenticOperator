// GET /api/allmeta/instance?label=<Label>&pk=<id>
//
// 反向代理 allmeta ontology API `/api/v1/ontology/instances/{label}/{pk}?domain=...`,
// 让浏览器侧 RuleCheckAuditDetailDrawer 的 "🛰️ Allmeta API 实时读 Neo4j" 面板能用。
// 之前 UI 调这条 route 但 route 不存在 → 永远 fetch_failed。
//
// 输出 shape 兼容 RuleCheckAuditDetailDrawer.tsx::AllmetaCardResponse:
//   { ok: true, label, pk_field, pk_value, instance, verify: { cypher, api_path, domain } }
//   { ok: false, reason, status?, details? }

import { NextResponse } from 'next/server';
import { getInstance, AllmetaApiError } from '@/lib/allmeta-client';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';

export const dynamic = 'force-dynamic';

const PK_FIELD_BY_LABEL: Record<string, string> = {
  Candidate: 'candidate_id',
  Resume: 'resume_id',
  Job_Requisition: 'job_requisition_id',
  Job_Posting: 'job_posting_id',
  Application: 'application_id',
  Candidate_Match_Result: 'candidate_match_result_id',
  Client: 'client_id',
  Employee: 'employee_id',
};

function cypherForLabel(label: string, pkField: string, pkValue: string): string {
  return `MATCH (n:${label} {${pkField}: '${pkValue.replace(/'/g, "\\'")}'}) RETURN n LIMIT 1`;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const label = (url.searchParams.get('label') ?? '').trim();
  const pk = (url.searchParams.get('pk') ?? '').trim();
  const domain = (url.searchParams.get('domain') ?? process.env.ALLMETA_DOMAIN ?? RECRUITMENT_DOMAIN_ID).trim();

  if (!label || !pk) {
    return NextResponse.json({ ok: false, reason: 'missing_label_or_pk' }, { status: 400 });
  }

  const pkField = PK_FIELD_BY_LABEL[label] ?? `${label.toLowerCase()}_id`;
  const apiPath = `/api/v1/ontology/instances/${encodeURIComponent(label)}/${encodeURIComponent(pk)}?domain=${encodeURIComponent(domain)}`;
  const verify = {
    cypher: cypherForLabel(label, pkField, pk),
    api_path: apiPath,
    domain,
  };

  try {
    const instance = await getInstance<Record<string, unknown>>(label, pk, { domain });
    if (!instance) {
      return NextResponse.json({
        ok: false,
        reason: 'not_found',
        verify,
      });
    }
    return NextResponse.json({
      ok: true,
      label,
      pk_field: pkField,
      pk_value: pk,
      instance,
      verify,
    });
  } catch (e) {
    const status = e instanceof AllmetaApiError ? e.status : 0;
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      ok: false,
      reason: 'allmeta_error',
      status,
      details: msg.slice(0, 400),
      verify,
    });
  }
}
