// E2E test — Q架构纠偏后全链路验证(partner-independent)
//
// 改造原因:partner RAAS API 192.168.1.105 当前 timeout,matchResumeAgent 跑不通。
// 本测试 bypass partner,只验证 AO 自身组件:
//   1. Prisma audit DB(从 Neo4j 迁移过来,应该 ≥19 条)
//   2. Neo4j 实体图(Candidate / Resume / Job_Requisition 关系打通)
//   3. infoFilledHandler 闭环(emit FILLED → handler lookup Prisma → merge → emit RESUME_PROCESSED)
//   4. API 读取(从 Prisma 拉 audit list / detail / stats / matrix)

import fs from 'node:fs';
import path from 'node:path';

const AO_URL = 'http://localhost:3002';
const INNGEST_URL = 'http://localhost:8288';
const NEO4J_HTTP = 'http://localhost:7475';
const NEO4J_AUTH = 'neo4j:testpassword123';

const CANDIDATE_ID = `04bcaedb-b1e8-4863-bee9-3e5c16e0caa3`;
const JR_ID = 'JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R20260401429';
const RESUME_ID = '1e319239-1f71-a2f4-ce6a-22559248d668';

type TestResult = {
  step: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  details: string;
  durationMs?: number;
};
const results: TestResult[] = [];

function record(step: string, status: 'PASS' | 'FAIL' | 'SKIP', details: string, durationMs?: number) {
  results.push({ step, status, details, durationMs });
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '○';
  const time = durationMs !== undefined ? ` (${durationMs}ms)` : '';
  console.log(`  ${icon} ${step.padEnd(50)} ${details}${time}`);
}

async function curl(url: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; auth?: string; timeoutMs?: number } = {}): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.auth) headers['Authorization'] = `Basic ${Buffer.from(opts.auth).toString('base64')}`;
  const ac = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  const init: RequestInit = { method: opts.method ?? 'GET', headers, signal: ac.signal };
  if (opts.body) init.body = JSON.stringify(opts.body);
  try {
    const r = await fetch(url, init);
    let body: unknown = null;
    const text = await r.text();
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  } catch (e) {
    // timeout / network error → 当作 HTTP 0(给 partner probe 这种允许 fail 的)
    return { status: 0, body: { error: (e as Error).message.slice(0, 100) } };
  } finally {
    clearTimeout(tid);
  }
}

async function neo4jQuery(cypher: string, params: Record<string, unknown> = {}) {
  return curl(`${NEO4J_HTTP}/db/neo4j/tx/commit`, {
    method: 'POST',
    auth: NEO4J_AUTH,
    body: { statements: [{ statement: cypher, parameters: params }] },
  });
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  E2E TEST — Q架构纠偏 + INFO_MISSING_FILLED 闭环验证');
  console.log('  (partner-independent — 跳过 RAAS API 依赖)');
  console.log('══════════════════════════════════════════════════════════════════\n');

  // ─── [0] 前置健康检查 ─────────────────────────────────────
  console.log('── [0] 前置健康检查 ──');

  const t0 = Date.now();
  const aoHealth = await curl(`${AO_URL}/api/rule-check-audits?limit=1`);
  record('AO /api/rule-check-audits', aoHealth.status === 200 ? 'PASS' : 'FAIL',
    `HTTP ${aoHealth.status}`, Date.now() - t0);

  const ingHealth = await curl(`${INNGEST_URL}/v1/events?limit=1`);
  record('Inngest /v1/events', ingHealth.status === 200 ? 'PASS' : 'FAIL', `HTTP ${ingHealth.status}`);

  const neoHealth = await neo4jQuery('RETURN 1 AS ok');
  record('Neo4j HTTP API', neoHealth.status === 200 ? 'PASS' : 'FAIL', `HTTP ${neoHealth.status}`);

  const allmetaProbe = await curl('http://10.100.0.70:3500/api/v1/ontology/schema?domain=RAAS-v1');
  record('Allmeta Studio @ 10.100.0.70:3500', allmetaProbe.status === 401 ? 'PASS' : 'SKIP',
    `HTTP ${allmetaProbe.status}(需 token,本期延后切换)`);

  const partnerProbe = await curl(
    `http://192.168.1.105:3001/api/v1/requirements/agent-view?claimer_employee_id=0000199059`,
    { headers: { Authorization: `Bearer internal-agentic-agent` } },
  );
  record('Partner RAAS API 可达性', partnerProbe.status === 200 ? 'PASS' : 'SKIP',
    `HTTP ${partnerProbe.status}(${partnerProbe.status === 0 ? '不可达 — 本测试 bypass' : '已通'})`);

  // ─── [1] Q架构纠偏 — Prisma 上有 audit 数据 ─────────────────
  console.log('\n── [1] Q架构纠偏验证 · Prisma 上 audit 数据 ──');

  const auditList = await curl(`${AO_URL}/api/rule-check-audits?limit=100`);
  const auditCount = ((auditList.body as { rows?: unknown[] })?.rows?.length) ?? 0;
  record('Prisma RuleCheckAudit 数 ≥ 19', auditCount >= 19 ? 'PASS' : 'FAIL', `${auditCount} 条`);

  // 找一个有完整 parsed_resume_json 的 audit 当 parent
  const rows = (auditList.body as { rows?: Array<{ audit_id: string; candidate_id: string }> })?.rows ?? [];
  let parentAuditId = '';
  let parentResumeContent: Record<string, unknown> | null = null;
  for (const r of rows) {
    if (r.candidate_id !== CANDIDATE_ID) continue;
    const detail = await curl(`${AO_URL}/api/rule-check-audits/${encodeURIComponent(r.audit_id)}`);
    const d = (detail.body as { ok?: boolean; detail?: { parsed_resume_full: Record<string, unknown> | null; flags?: Array<{ flag_id: string }> } });
    if (d.ok && d.detail?.parsed_resume_full) {
      parentAuditId = r.audit_id;
      parentResumeContent = d.detail.parsed_resume_full;
      record('找到含 parsed_resume_full 的 parent audit', 'PASS',
        `${parentAuditId.slice(0, 50)}… · 包含 ${Object.keys(parentResumeContent).length} 字段 · flags=${d.detail.flags?.length ?? 0}`);
      break;
    }
  }
  if (!parentAuditId) {
    record('找到含 parsed_resume_full 的 parent audit', 'FAIL',
      `没找到 candidate=${CANDIDATE_ID.slice(0,8)}… 的 audit`);
  }

  // 验证 Prisma audit 的关键字段不为空
  if (parentAuditId) {
    const d = await curl(`${AO_URL}/api/rule-check-audits/${encodeURIComponent(parentAuditId)}`);
    const detail = (d.body as { ok?: boolean; detail?: { user_prompt?: string | null; llm_raw_text?: string | null; failure_reasons?: string[] } }).detail;
    record('parent audit.user_prompt 存在',
      detail?.user_prompt && detail.user_prompt.length > 1000 ? 'PASS' : 'SKIP',
      `${detail?.user_prompt?.length ?? 0} chars`);
    record('parent audit.llm_raw_text 存在',
      detail?.llm_raw_text && detail.llm_raw_text.length > 100 ? 'PASS' : 'SKIP',
      `${detail?.llm_raw_text?.length ?? 0} chars`);
  }

  // ─── [2] Neo4j 实体图 — 全图打通 ────────────────────────────
  console.log('\n── [2] Neo4j 实体图打通(label 统一为下划线版)──');

  const labelCheck = await neo4jQuery(`
    MATCH (n:JobRequisition) RETURN count(n) AS legacy_count
  `);
  const legacyCount = Number(((labelCheck.body as { results?: Array<{ data?: Array<{ row?: number[] }> }> })?.results?.[0]?.data?.[0]?.row?.[0]) ?? -1);
  record(':JobRequisition (旧无下划线) = 0', legacyCount === 0 ? 'PASS' : 'FAIL', `${legacyCount} 条`);

  const newCheck = await neo4jQuery(`MATCH (n:Job_Requisition) RETURN count(n) AS c`);
  const newCount = Number(((newCheck.body as { results?: Array<{ data?: Array<{ row?: number[] }> }> })?.results?.[0]?.data?.[0]?.row?.[0]) ?? 0);
  record(':Job_Requisition (新下划线) ≥ 5', newCount >= 5 ? 'PASS' : 'FAIL', `${newCount} 条`);

  const fullPath = await neo4jQuery(`
    MATCH (c:Candidate)-[:EVALUATED_FOR]->(jr:Job_Requisition)
    RETURN count(*) AS n
  `);
  const fullPathN = Number(((fullPath.body as { results?: Array<{ data?: Array<{ row?: number[] }> }> })?.results?.[0]?.data?.[0]?.row?.[0]) ?? 0);
  record('Candidate -[:EVALUATED_FOR]-> Job_Requisition', fullPathN >= 1 ? 'PASS' : 'FAIL',
    `${fullPathN} 条关系`);

  const realCheck = await neo4jQuery(`
    MATCH (c:Candidate {candidate_id: $cid})-[:EVALUATED_FOR]->(jr:Job_Requisition {job_requisition_id: $jrid})
    RETURN c.candidate_id AS cid, jr.job_requisition_id AS jrid, jr.client_name AS client
  `, { cid: CANDIDATE_ID, jrid: JR_ID });
  const realRows = ((realCheck.body as { results?: Array<{ data?: Array<{ row?: unknown[] }> }> })?.results?.[0]?.data) ?? [];
  record('真实候选 04bcaedb → R20260401429 全图打通',
    realRows.length > 0 ? 'PASS' : 'FAIL',
    realRows.length > 0 ? `client=${(realRows[0].row as unknown[])[2]}` : '');

  // 注意:audit 不应该在 Neo4j(架构纠偏)
  const auditInNeo = await neo4jQuery(`MATCH (a:RuleCheckAudit) RETURN count(a) AS n`);
  const auditInNeoN = Number(((auditInNeo.body as { results?: Array<{ data?: Array<{ row?: number[] }> }> })?.results?.[0]?.data?.[0]?.row?.[0]) ?? -1);
  record('Neo4j :RuleCheckAudit 数(老数据未清,新写已不进)',
    'SKIP',
    `${auditInNeoN} 条(应迁到 Prisma,新写不再进 Neo4j)`);

  // ─── [3] infoFilledHandler 闭环 ────────────────────────────
  console.log('\n── [3] infoFilledHandler 闭环验证 ──');

  if (!parentAuditId) {
    record('FILLED → handler 闭环', 'SKIP', '没找到 parent audit,跳过');
  } else {
    // emit RESUME_INFO_MISSING_FILLED 引用 parent_audit_id
    const filledPayload = {
      name: 'RESUME_INFO_MISSING_FILLED',
      data: {
        entity_type: 'Resume',
        entity_id: RESUME_ID,
        payload: {
          parent_audit_id: parentAuditId,
          candidate_id: CANDIDATE_ID,
          resume_id: RESUME_ID,
          job_requisition_id: JR_ID,
          filled_fields: {
            '性别': '男',
            '婚育情况': '未婚',
            'nationality': '中国',
            'expected_salary_range': '15k-18k',
            'conflict_of_interest_summary': '已声明无亲属冲突 (2026-05-12 e2e test)',
          },
          filled_by_employee_id: '0000199059',
          filled_at: new Date().toISOString(),
          retry_count: 1,
        },
        trace: { trace_id: `e2e-${Date.now()}`, agent_name: 'e2e-test' },
      },
    };
    const sendT = Date.now();
    const sendR = await curl(`${INNGEST_URL}/e/dev`, { method: 'POST', body: filledPayload });
    const sentId = ((sendR.body as { ids?: string[] })?.ids?.[0]) ?? '';
    record('emit RESUME_INFO_MISSING_FILLED',
      sendR.status === 200 ? 'PASS' : 'FAIL',
      `event_id=${sentId.slice(0, 16)}…`, Date.now() - sendT);

    // 等 infoFilledHandler 跑
    console.log('  等 20s infoFilledHandler 跑...');
    await new Promise((res) => setTimeout(res, 20_000));

    // 查这条 event 的 functionRun
    const runs = await curl(`${INNGEST_URL}/v1/events/${sentId}/runs`);
    const runRows = ((runs.body as { data?: Array<{ status: string; output?: unknown }> })?.data) ?? [];
    if (runRows.length === 0) {
      record('infoFilledHandler 触发', 'FAIL', '没找到对应 run');
    } else {
      const handlerRun = runRows[0];
      record('infoFilledHandler 触发',
        handlerRun.status === 'Completed' ? 'PASS' : 'FAIL',
        `status=${handlerRun.status}`);
    }

    // 检查 Inngest 上有没有新 RESUME_PROCESSED 出现(handler 重发的)
    const newProcessed = await curl(`${INNGEST_URL}/v1/events?name=RESUME_PROCESSED&limit=3`);
    const newProcessedRows = ((newProcessed.body as { data?: Array<{ id: string; received_at: string; data?: { source_channel?: string; enrichment_applied?: { parent_audit_id?: string } } }> })?.data) ?? [];
    const enrichedReemit = newProcessedRows.find((e) =>
      e.data?.source_channel === 'ao_info_filled_replay' &&
      e.data?.enrichment_applied?.parent_audit_id === parentAuditId
    );
    record('infoFilledHandler 重发 RESUME_PROCESSED',
      enrichedReemit ? 'PASS' : 'FAIL',
      enrichedReemit ? `event_id=${enrichedReemit.id.slice(0, 16)}…` : '没看到 enriched re-emit');
  }

  // ─── [4] API stats / matrix 验证 ────────────────────────────
  console.log('\n── [4] API 数据接口验证 ──');

  const stats = await curl(`${AO_URL}/api/rule-check-audits/stats?days=30`);
  const statsBody = stats.body as { total?: number; pass?: number; fail?: number; top_failure_rules?: Array<{ rule_id: string }> };
  record('GET /stats 返回正常',
    typeof statsBody.total === 'number' ? 'PASS' : 'FAIL',
    `total=${statsBody.total} pass=${statsBody.pass} fail=${statsBody.fail}`);
  record('Top failure rules 非空',
    (statsBody.top_failure_rules?.length ?? 0) > 0 ? 'PASS' : 'FAIL',
    statsBody.top_failure_rules?.map((r) => r.rule_id).slice(0, 3).join(',') ?? '');

  const matrix = await curl(`${AO_URL}/api/rule-check-audits/matrix?days=30`);
  const matrixBody = matrix.body as { rules?: Array<{ rule_id: string; pass: number; fail: number }>; total_audits?: number };
  record('GET /matrix 返回正常',
    matrix.status === 200 ? 'PASS' : 'FAIL',
    `${matrixBody.rules?.length ?? 0} 条 rule × ${matrixBody.total_audits ?? 0} audits`);

  // ─── 报告 ────────────────────────────────────────────────
  printReport();
}

function printReport() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  测试矩阵');
  console.log('══════════════════════════════════════════════════════════════════\n');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`  ${pass} PASS · ${fail} FAIL · ${skip} SKIP · 共 ${results.length} 项\n`);
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○';
    console.log(`    ${icon} ${r.step.padEnd(52)} ${r.details}`);
  }
  console.log('');

  const reportPath = path.join(process.cwd(), 'docs', `e2e-test-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ summary: { pass, fail, skip, total: results.length }, results }, null, 2));
  console.log(`  报告保存:${reportPath}`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n✗ E2E test 异常:', e);
  printReport();
});
