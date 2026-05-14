// GET /api/allmeta/instance?label=Candidate&pk=04bcaedb-...
//
// 给 drawer UI 用 — 实时经 Allmeta API 读 Neo4j 实例数据。
// 证明:Allmeta 路径通 + 节点真的在 Neo4j(带可粘 Cypher)。

import { NextResponse } from 'next/server';
import { getInstance, buildVerifyCypher, getAllmetaPublicConfig } from '@/lib/allmeta-client';

export const dynamic = 'force-dynamic';

const PK_FIELD: Record<string, string> = {
  Candidate: 'candidate_id',
  Resume: 'resume_id',
  Job_Requisition: 'job_requisition_id',
  Candidate_Match_Result: 'candidate_match_result_id',
  Candidate_Expectation: 'candidate_expectation_id',
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const label = searchParams.get('label');
  const pk = searchParams.get('pk');

  if (!label || !pk) {
    return NextResponse.json(
      { ok: false, reason: 'bad_request', details: 'label + pk required' },
      { status: 400 },
    );
  }

  const pkField = PK_FIELD[label];
  if (!pkField) {
    return NextResponse.json(
      { ok: false, reason: 'unknown_label', details: label },
      { status: 400 },
    );
  }

  const r = await getInstance(label, pk);
  const allmetaConfig = getAllmetaPublicConfig();
  const cypher = buildVerifyCypher(label, pkField, pk);

  if (!r.ok) {
    return NextResponse.json({
      ok: false,
      reason: r.reason,
      status: r.status,
      details: r.details,
      verify: {
        cypher,
        api_path: `GET ${allmetaConfig.base}/api/v1/ontology/instances/${label}/${encodeURIComponent(pk)}?domain=${allmetaConfig.domain}`,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    label,
    pk_field: pkField,
    pk_value: pk,
    instance: r.data,
    verify: {
      cypher,
      api_path: `GET ${allmetaConfig.base}/api/v1/ontology/instances/${label}/${encodeURIComponent(pk)}?domain=${allmetaConfig.domain}`,
      domain: allmetaConfig.domain,
    },
  });
}
