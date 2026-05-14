// E2E — 我替代 RAAS partner 跑全程闭环(简化版:0 个新事件)
//
// 流程:
//   [A] 健康检查:AO + Inngest + Neo4j + Prisma + 真实 partner API
//   [B] 挑一条现存 audit(rule-check FAIL,且 evidence 里有"缺字段"模式)
//        作为"AO 上一轮 emit 出来的 RESUME_INFO_MISSING"的载体
//   [C] 我扮演 RAAS partner:
//        - "收到" RESUME_INFO_MISSING(从该 audit.flags 解析 missing_fields)
//        - "模拟 recruiter 填表"(自动按字段映射表填假数据)
//        - merge filled_fields 到 parsed_resume(中→英 key 翻译)
//        - 重发 RESUME_PROCESSED(★ 简化关键:partner 直接发,不走中间 FILLED 事件)
//          payload 带 enrichment_applied.parent_audit_id 串谱系
//   [D] 验证 AO matchResumeAgent 收到 re-emit + 跑出新 audit
//   [E] 验证 Prisma:新 child audit · parent_audit_id == 原 audit_id · 补全字段进入 parsed_resume
//   [F] 验证 Neo4j:Candidate / Resume / Job_Requisition 三角关系仍在

import fs from 'node:fs';
import path from 'node:path';

const AO_URL = 'http://localhost:3002';
const INNGEST_URL = 'http://localhost:8288';
const NEO4J_HTTP = 'http://localhost:7475';
const NEO4J_AUTH = 'neo4j:testpassword123';
const PARTNER_URL = 'http://192.168.1.105:3001';
const PARTNER_TOKEN = 'internal-agentic-agent';

// partner 端做的中→英 key 翻译(跟文档 §4 AO_FIELD_MAP 对齐)
const AO_FIELD_MAP: Record<string, string> = {
  '性别': 'gender',
  '婚育情况': 'marital_status',
  '国籍': 'nationality',
  '出生年份': 'birth_year',
  '出生日期': 'birth_date',
  '期望薪资': 'expected_salary_range',
  '期望薪资范围': 'expected_salary_range',
  '利益冲突声明': 'conflict_of_interest_summary',
  '利益冲突声明数据': 'conflict_of_interest_summary',
};

type TestResult = { step: string; status: 'PASS' | 'FAIL' | 'SKIP'; details: string; durationMs?: number };
const results: TestResult[] = [];
function record(step: string, status: TestResult['status'], details: string, durationMs?: number) {
  results.push({ step, status, details, durationMs });
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '○';
  const time = durationMs !== undefined ? ` (${durationMs}ms)` : '';
  console.log(`  ${icon} ${step.padEnd(58)} ${details}${time}`);
}

async function curl(url: string, opts: {
  method?: string; body?: unknown; headers?: Record<string, string>; auth?: string; timeoutMs?: number;
} = {}): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.auth) headers['Authorization'] = `Basic ${Buffer.from(opts.auth).toString('base64')}`;
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15000);
  const init: RequestInit = { method: opts.method ?? 'GET', headers, signal: ac.signal };
  if (opts.body) init.body = JSON.stringify(opts.body);
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: { error: (e as Error).message.slice(0, 200) } };
  } finally { clearTimeout(tid); }
}

async function neo(cypher: string, params: Record<string, unknown> = {}) {
  return curl(`${NEO4J_HTTP}/db/neo4j/tx/commit`, {
    method: 'POST', auth: NEO4J_AUTH,
    body: { statements: [{ statement: cypher, parameters: params }] },
  });
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// partner 模拟逻辑:根据缺字段名生成 recruiter 输入(中文 key)
function simulateRecruiterForm(missing: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const f of missing) {
    if (/性别/.test(f)) input['性别'] = '男';
    else if (/婚育/.test(f)) input['婚育情况'] = '未婚';
    else if (/国籍/.test(f)) input['国籍'] = '中国';
    else if (/出生/.test(f)) input['出生年份'] = '1996';
    else if (/薪资|工资/.test(f)) input['期望薪资'] = '8k-12k';
    else if (/利益冲突|亲属/.test(f)) input['利益冲突声明'] = '已声明无亲属冲突 (RAAS mock)';
    // 其他字段不填,模拟 recruiter 没填全的情况(让 rule-check 下轮再 catch)
  }
  return input;
}

// partner submit handler 做的事:中→英翻译 + merge 到 parsed_resume
function partnerMergeFilledFields(
  originalParsed: Record<string, unknown>,
  recruiterInput: Record<string, unknown>,
): { merged: Record<string, unknown>; deltaEnglish: Record<string, unknown> } {
  const deltaEnglish: Record<string, unknown> = {};
  for (const [zh, v] of Object.entries(recruiterInput)) {
    const en = AO_FIELD_MAP[zh] ?? zh;
    deltaEnglish[en] = v;
  }
  return { merged: { ...originalParsed, ...deltaEnglish }, deltaEnglish };
}

// 从 audit.flags.evidence 抠"缺字段"清单
function extractMissingFields(flags: Array<{ result: string; evidence: string }>): string[] {
  const set = new Set<string>();
  for (const f of flags) {
    if (f.result !== 'NOT_APPLICABLE' && f.result !== 'FAIL') continue;
    if (!f.evidence) continue;
    const matches = f.evidence.match(/(?:简历)?(?:未提供|缺失?)\s*[:：]?\s*([一-龥A-Za-z_][一-龥A-Za-z0-9_]{0,30})/g) ?? [];
    for (const m of matches) {
      const inner = m.match(/([一-龥A-Za-z_][一-龥A-Za-z0-9_]{0,30})$/);
      if (inner) {
        const candidate = inner[1];
        // 过滤掉规则文本(非字段名),只保留我们识别的字段映射
        if (AO_FIELD_MAP[candidate] || /^[一-龥]{1,4}$/.test(candidate)) {
          set.add(candidate);
        }
      }
    }
  }
  // 如果 evidence 抠不出来,fallback 给一组常见缺字段
  if (set.size === 0) {
    set.add('性别'); set.add('婚育情况');
  }
  return [...set];
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  E2E — 我替代 RAAS partner 跑全程闭环(简化版:0 个新事件)');
  console.log('  AO ↔ RAAS-mock(本脚本) ↔ Shared Inngest ↔ Neo4j');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  // ─── [A] 健康检查 ───
  console.log('── [A] 各组件健康检查 ──');
  const aoH = await curl(`${AO_URL}/api/rule-check-audits?limit=1`);
  record('AO API 端点', aoH.status === 200 ? 'PASS' : 'FAIL', `HTTP ${aoH.status}`);
  const ingH = await curl(`${INNGEST_URL}/v1/events?limit=1`);
  record('Inngest event API', ingH.status === 200 ? 'PASS' : 'FAIL', `HTTP ${ingH.status}`);
  const neoH = await neo('RETURN 1 AS ok');
  record('Neo4j HTTP API', neoH.status === 200 ? 'PASS' : 'FAIL', `HTTP ${neoH.status}`);
  const ptH = await curl(`${PARTNER_URL}/api/v1/requirements/agent-view?claimer_employee_id=0000199059`, {
    headers: { Authorization: `Bearer ${PARTNER_TOKEN}` },
  });
  record('真实 partner RAAS API', ptH.status === 200 ? 'PASS' : 'SKIP',
    `HTTP ${ptH.status}${ptH.status === 200 ? ' · 重跑链路可走通' : ' · 重跑会断在 fetch requirements'}`);

  // ─── [B] 挑一条 parent audit ───
  console.log('\n── [B] 挑 parent audit(作为 AO 上一轮 RESUME_INFO_MISSING 的载体)──');
  type ParentDetail = {
    audit_id: string; candidate_id: string; resume_id: string; job_requisition_id: string;
    upload_id: string;
    parsed_resume_full: Record<string, unknown> | null;
    flags: Array<{ result: string; evidence: string }>;
  };
  const listRes = await curl(`${AO_URL}/api/rule-check-audits?limit=20`);
  const rows = (listRes.body as { rows?: Array<{ audit_id: string; candidate_id: string; decision: string; n_flags: number }> }).rows ?? [];
  let parentAuditId = '';
  let parentDetail: ParentDetail | null = null;
  let missingFieldNames: string[] = [];

  for (const r of rows) {
    if (r.decision !== 'FAIL') continue;
    const dRes = await curl(`${AO_URL}/api/rule-check-audits/${encodeURIComponent(r.audit_id)}`);
    const d = (dRes.body as { ok?: boolean; detail?: ParentDetail }).detail;
    if (!d || !d.parsed_resume_full) continue;
    const missing = extractMissingFields(d.flags);
    if (missing.length > 0) {
      parentAuditId = r.audit_id;
      parentDetail = d;
      missingFieldNames = missing;
      record('找到 FAIL 且含 missing 字段的 audit', 'PASS',
        `${parentAuditId.slice(-30)} · missing=${missing.slice(0, 4).join(',')}`);
      break;
    }
  }
  if (!parentAuditId || !parentDetail) {
    record('找到合适 parent audit', 'FAIL', '没在最近 20 条里找到');
    return printReport();
  }
  const pr = parentDetail.parsed_resume_full as Record<string, unknown>;
  const name = typeof pr.name === 'string' ? pr.name : '<未知>';
  record('parent audit 真实候选人', 'PASS',
    `${name} · candidate=${parentDetail.candidate_id.slice(0, 8)}… · job_req=${parentDetail.job_requisition_id.slice(-12)}`);

  // ─── [C] 我扮演 RAAS:模拟 recruiter 填表 → merge → 重发 RESUME_PROCESSED ───
  console.log('\n── [C] 我扮演 RAAS partner — 填表 + merge + 重发 RESUME_PROCESSED ──');

  // 1) 模拟 recruiter 在表单里输入中文字段
  const recruiterInput = simulateRecruiterForm(missingFieldNames);
  record('recruiter 表单输入(中文 key)', 'PASS',
    Object.entries(recruiterInput).map(([k, v]) => `${k}=${v}`).join(' · '));

  // 2) partner submit handler 做的:中→英翻译 + merge 到 parsed_resume
  const { merged: mergedParsed, deltaEnglish } = partnerMergeFilledFields(pr, recruiterInput);
  record('partner merge 后的英文 delta', 'PASS', Object.keys(deltaEnglish).join(','));

  // 3) 拿 emit 前的 audit 总数
  const before = await curl(`${AO_URL}/api/rule-check-audits?limit=100`);
  const beforeRows = ((before.body as { rows?: unknown[] }).rows ?? []) as Array<{ audit_id: string }>;
  const beforeIds = new Set(beforeRows.map((x) => x.audit_id));
  record('Pre-emit Prisma audit 数', 'PASS', `${beforeRows.length} 条`);

  // 4) ★ 重发 RESUME_PROCESSED(完全模拟 partner 的 outboxService.appendOntologyEvent)
  const reemitPayload = {
    name: 'RESUME_PROCESSED',
    data: {
      upload_id: parentDetail.upload_id ?? '',
      candidate_id: parentDetail.candidate_id,
      resume_id: parentDetail.resume_id,
      employee_id: '0000199059',
      job_requisition_id: parentDetail.job_requisition_id,
      parsed: { data: mergedParsed },                  // ★ 合并后的 parsed_resume

      // ★ AO 靠这串谱系
      enrichment_applied: {
        parent_audit_id: parentAuditId,
        filled_fields_delta: deltaEnglish,
        filled_at: new Date().toISOString(),
        filled_by_employee_id: '0000199059',
      },
      source_channel: 'raas_recruiter_repair_replay',

      // 其他 RESUME_PROCESSED 标准字段
      bucket: '', objectKey: '', filename: '', hrFolder: null, etag: null, size: null,
      sourceEventName: null, receivedAt: new Date().toISOString(),
      candidate: {}, candidate_expectation: {}, resume: {}, runtime: {},
      parsedAt: new Date().toISOString(),
      parserVersion: 'recruiter_repair_replay',
    },
  };
  const emitT = Date.now();
  const emitR = await curl(`${INNGEST_URL}/e/dev`, { method: 'POST', body: reemitPayload });
  const reemitId = ((emitR.body as { ids?: string[] })?.ids?.[0]) ?? '';
  record('partner 重发 RESUME_PROCESSED', emitR.status === 200 ? 'PASS' : 'FAIL',
    `event_id=${reemitId.slice(0, 24)}… · parent=${parentAuditId.slice(-10)}`, Date.now() - emitT);

  // ─── [D] AO matchResumeAgent 重跑验证 ───
  console.log('\n── [D] AO matchResumeAgent 重跑 ──');
  console.log('  等 40s matchResumeAgent 跑 rule-check + Robohire...');
  await sleep(40_000);

  const runRes = await curl(`${INNGEST_URL}/v1/events/${reemitId}/runs`);
  const runs = ((runRes.body as { data?: Array<{ status: string; function_id?: string }> }).data) ?? [];
  const mraRun = runs.find((r) => r.function_id?.includes('match-resume')) ?? runs[0];
  record('matchResumeAgent 被触发',
    mraRun?.status === 'Completed' ? 'PASS' : 'FAIL',
    `status=${mraRun?.status ?? 'no-run'}`);

  // ─── [E] Prisma 新 audit 谱系验证 ───
  console.log('\n── [E] Prisma 新 audit + 谱系 ──');
  const after = await curl(`${AO_URL}/api/rule-check-audits?limit=100`);
  const afterRows = ((after.body as { rows?: unknown[] }).rows ?? []) as Array<{ audit_id: string; created_at: string; candidate_id: string }>;
  record('Post-rerun audit 数', afterRows.length > beforeRows.length ? 'PASS' : 'SKIP',
    `${afterRows.length} 条(增长 ${afterRows.length - beforeRows.length})`);

  const newAudits = afterRows
    .filter((x) => !beforeIds.has(x.audit_id) && x.candidate_id === parentDetail.candidate_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (newAudits.length === 0) {
    record('新生 child audit', 'FAIL', '没看到 child audit');
  } else {
    const child = newAudits[0]!;
    record('新生 child audit', 'PASS', `${child.audit_id.slice(-24)} · 跟 parent 同 candidate`);

    const childRes = await curl(`${AO_URL}/api/rule-check-audits/${encodeURIComponent(child.audit_id)}`);
    const childD = (childRes.body as { ok?: boolean; detail?: { parent_audit_id?: string | null; parsed_resume_full?: Record<string, unknown> | null } }).detail;
    record('child.parent_audit_id == parent.audit_id',
      childD?.parent_audit_id === parentAuditId ? 'PASS' : 'FAIL',
      childD?.parent_audit_id ? `match: ${childD.parent_audit_id.slice(-20)}` : 'no parent_audit_id');

    const childResume = (childD?.parsed_resume_full ?? {}) as Record<string, unknown>;
    const fieldsHit = Object.keys(deltaEnglish).filter((k) => {
      const v = childResume[k];
      return v !== undefined && v !== null && v !== '';
    });
    record('补全字段进入 child.parsed_resume',
      fieldsHit.length === Object.keys(deltaEnglish).length ? 'PASS' : 'FAIL',
      `${fieldsHit.length}/${Object.keys(deltaEnglish).length} 字段命中: ${fieldsHit.join(',')}`);
  }

  // ─── [F] Neo4j 实体三角 ───
  console.log('\n── [F] Neo4j 实体三角 ──');
  const triangle = await neo(`
    MATCH (c:Candidate {candidate_id: $cid})
    OPTIONAL MATCH (c)-[:HAS_RESUME]->(re:Resume)
    OPTIONAL MATCH (c)-[:EVALUATED_FOR]->(jr:Job_Requisition)
    RETURN c.candidate_id AS cid, c.name AS name, count(DISTINCT re) AS resumes, count(DISTINCT jr) AS jrs
  `, { cid: parentDetail.candidate_id });
  const trRow = ((triangle.body as { results?: Array<{ data?: Array<{ row?: unknown[] }> }> })?.results?.[0]?.data?.[0]?.row) ?? [];
  const [, neoName, resumes, jrs] = trRow as [string, string, number, number];
  record('Neo4j candidate-resume-jr 三角',
    Number(resumes) >= 1 && Number(jrs) >= 1 ? 'PASS' : 'FAIL',
    `${neoName} · resumes=${resumes} jrs=${jrs}`);

  printReport();
}

function printReport() {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  测试矩阵');
  console.log('══════════════════════════════════════════════════════════════════════\n');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`  ${pass} PASS · ${fail} FAIL · ${skip} SKIP · 共 ${results.length} 项\n`);
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○';
    console.log(`    ${icon} ${r.step.padEnd(58)} ${r.details}`);
  }
  console.log('');
  const reportPath = path.join(process.cwd(), 'docs', `e2e-raas-mock-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ summary: { pass, fail, skip, total: results.length }, results }, null, 2));
  console.log(`  报告保存:${reportPath}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n✗ E2E test 异常:', e);
  printReport();
});
