#!/usr/bin/env node
// Realistic E2E for /monitor evidence trail:
//   1) REQUIREMENT_LOGGED  → Create JD Agent          → Allmeta:Job_Requisition
//   2) RESUME_DOWNLOADED   → Resume Parser Agent      → Allmeta:Candidate / Resume / Candidate_Expectation
//   3) RESUME_PROCESSED    → Match Resume Agent       → Allmeta:Candidate_Match_Result
//
// Verifies:
//   - All 3 agents complete
//   - AgentStepEvidence rows captured (per run)
//   - Allmeta returns 200 and emits Cypher hints
//   - flow grouping works (jr:* + upload:*)

const INNGEST = process.env.INNGEST_BASE ?? 'http://localhost:8288';
const AO      = process.env.AO_BASE      ?? 'http://localhost:3002';

const RUN_TAG  = `2026-05-15-${Date.now().toString(36).slice(-5)}`;
const JR_ID    = `jr_e2e_${RUN_TAG}`;
const UPLOAD   = `upload_e2e_${RUN_TAG}`;
const CAND_ID  = `cand_${RUN_TAG}`;
const RESUME_ID= `resume_${RUN_TAG}`;

const C = {
  cyan:  s => `\x1b[36m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red:   s => `\x1b[31m${s}\x1b[0m`,
  yellow:s => `\x1b[33m${s}\x1b[0m`,
  gray:  s => `\x1b[90m${s}\x1b[0m`,
  bold:  s => `\x1b[1m${s}\x1b[0m`,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function send(name, data) {
  const r = await fetch(`${INNGEST}/e/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  const j = await r.json();
  return j.ids?.[0] ?? null;
}

async function waitForRun(eventId, timeoutSec) {
  const until = Date.now() + timeoutSec * 1000;
  while (Date.now() < until) {
    const r = await fetch(`${INNGEST}/v1/events/${eventId}/runs`);
    const b = await r.json();
    const runs = b.data ?? [];
    const latest = runs[runs.length - 1];
    if (latest && ['Completed', 'Failed', 'Cancelled'].includes(latest.status)) {
      return latest;
    }
    if (latest) process.stdout.write(C.gray(`  · ${latest.status.toLowerCase()}\n`));
    await sleep(2000);
  }
  return { status: 'TIMEOUT', run_id: null };
}

async function fetchEvidence(runId) {
  const r = await fetch(`${AO}/api/inngest-admin/runs/${runId}/evidence`);
  return r.json();
}

async function fetchFlow(flowId) {
  const r = await fetch(`${AO}/api/inngest-admin/flows/${encodeURIComponent(flowId)}/evidence`);
  return r.json();
}

// ─────────────────────────────────────────────────
// Realistic payloads
// ─────────────────────────────────────────────────

const JD_REQUIREMENT_EVENT = {
  entity_type: 'Job_Requisition',
  entity_id: JR_ID,
  event_id: `evt_req_${RUN_TAG}`,
  payload: {
    job_requisition_id: JR_ID,
    client_id: 'bytedance_2026',
    raw_input_data: {
      job_requisition_id: JR_ID,
      client_id: 'bytedance_2026',
      client_job_title: '高级 Java 后端工程师',
      client_job_type: '研发',
      client_department_id: 'dept_infra_2026',
      sd_org_name: '字节跳动 - 基础架构部',
      city: '北京',
      recruitment_type: '社招',
      expected_level: '高级',
      priority: '高',
      headcount: 2,
      salary_range: '35-60k',
      first_interview_format: '线下',
      job_responsibility: '负责字节跳动核心业务后端服务的设计与开发,优化高并发场景下的稳定性与性能',
      job_requirement: '5 年以上 Java 后端开发经验,熟悉 Spring Boot、MySQL、Redis、Kafka、分布式系统;有大流量服务设计经验',
    },
  },
  trace: { trace_id: `trace_${RUN_TAG}`, request_id: `req_${RUN_TAG}` },
};

const RESUME_DOWNLOADED_EVENT = {
  upload_id: UPLOAD,
  bucket: 'recruit-resume-raw',
  objectKey: `2026/05/${UPLOAD}.pdf`,
  filename: '张明远-Java后端工程师-2026.pdf',
  hrFolder: null,
  employeeId: '0000199059',
  etag: `etag_${RUN_TAG}`,
  size: 245678,
  sourceEventName: 'real_test',
  receivedAt: new Date().toISOString(),
  parsed: {
    data: {
      name: '张明远',
      email: 'zhangmy.dev@example.com',
      phone: '13812345678',
      location: '北京',
      summary: '8 年 Java 后端开发经验,曾在腾讯、阿里巴巴负责核心业务系统,熟悉分布式系统设计与高并发优化',
      experience: [
        {
          title: 'Java 高级研发工程师',
          company: '阿里巴巴',
          startDate: '2022-03',
          endDate: '2026-04',
          description: '负责淘宝交易核心链路,日均订单亿级,主导多次大促保障',
        },
        {
          title: 'Java 后端工程师',
          company: '腾讯',
          startDate: '2018-07',
          endDate: '2022-02',
          description: '微信支付后台,负责账户体系与对账系统',
        },
      ],
      education: [
        { degree: '硕士', field: '计算机科学', institution: '北京大学', graduationYear: '2018' },
        { degree: '本科', field: '软件工程', institution: '华中科技大学', graduationYear: '2015' },
      ],
      skills: ['Java', 'Spring Boot', 'MySQL', 'Redis', 'Kafka', 'Dubbo', '分布式系统', 'JVM 调优'],
      certifications: ['阿里云 ACP', 'Oracle Java SE 11'],
    },
  },
};

const RESUME_PROCESSED_EVENT = {
  upload_id: UPLOAD,
  objectKey: `2026/05/${UPLOAD}.pdf`,
  filename: '张明远-Java后端工程师-2026.pdf',
  bucket: 'recruit-resume-raw',
  hrFolder: null,
  employeeId: '0000199059',
  etag: `etag_${RUN_TAG}`,
  size: 245678,
  sourceEventName: 'real_test',
  receivedAt: new Date().toISOString(),
  candidate_id: CAND_ID,
  resume_id: RESUME_ID,
  job_requisition_id: JR_ID,
  parsed: {
    data: {
      name: '张明远',
      email: 'zhangmy.dev@example.com',
      phone: '13812345678',
      summary: '8 年 Java 后端开发经验',
      experience: [
        { title: 'Java 高级研发工程师', company: '阿里巴巴', startDate: '2022-03', endDate: '2026-04' },
      ],
      skills: ['Java', 'Spring Boot', 'MySQL', 'Redis', 'Kafka'],
    },
  },
  candidate: {
    candidate_id: CAND_ID,
    name: '张明远',
    email: 'zhangmy.dev@example.com',
    phone: '13812345678',
  },
  candidate_expectation: {
    candidate_id: CAND_ID,
    expected_city: '北京',
    expected_salary_min: 40000,
    expected_salary_max: 70000,
  },
  resume: {
    resume_id: RESUME_ID,
    candidate_id: CAND_ID,
    parsed_at: new Date().toISOString(),
  },
  parsedAt: new Date().toISOString(),
  parserVersion: 'v7-pull-model@2026-05-08',
};

// ─────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────

function summarizeEvidence(rows) {
  if (!rows || rows.length === 0) return { count: 0, allmeta: 0, raas: 0, errors: 0, byKind: {} };
  const byKind = {};
  let allmeta = 0, raas = 0, errors = 0;
  for (const r of rows) {
    byKind[r.step_kind] = (byKind[r.step_kind] ?? 0) + 1;
    if (r.step_kind === 'allmeta_write') allmeta++;
    if (r.external_call?.startsWith('RAAS')) raas++;
    if (r.error_message) errors++;
  }
  return { count: rows.length, allmeta, raas, errors, byKind };
}

(async () => {
  console.log(C.bold(C.cyan('\n╔════════════════════════════════════════════════════════╗')));
  console.log(C.bold(C.cyan('║  Realistic E2E — 3 PRA agents → Allmeta → Neo4j        ║')));
  console.log(C.bold(C.cyan('╚════════════════════════════════════════════════════════╝')));
  console.log(C.gray(`  run_tag = ${RUN_TAG}`));
  console.log(C.gray(`  JR_ID   = ${JR_ID}`));
  console.log(C.gray(`  UPLOAD  = ${UPLOAD}`));
  console.log(C.gray(`  CAND    = ${CAND_ID}\n`));

  // ── 1) REQUIREMENT_LOGGED → Create JD Agent
  console.log(C.cyan('━━━ 1) REQUIREMENT_LOGGED → createJdAgent'));
  const eid1 = await send('REQUIREMENT_LOGGED', JD_REQUIREMENT_EVENT);
  console.log(C.gray(`  event id: ${eid1}`));
  const r1 = await waitForRun(eid1, 90);
  const s1 = r1.status === 'Completed' ? C.green('✓') : C.red('✗');
  console.log(`  ${s1} status=${r1.status} run=${r1.run_id?.slice(0, 14)}`);
  let ev1 = { evidence: [] };
  if (r1.run_id) {
    ev1 = await fetchEvidence(r1.run_id);
    const sum = summarizeEvidence(ev1.evidence);
    console.log(C.gray(`    evidence: ${sum.count} rows · allmeta=${sum.allmeta} raas=${sum.raas} err=${sum.errors}`));
    console.log(C.gray(`    by kind: ${JSON.stringify(sum.byKind)}`));
  }

  // ── 2) RESUME_DOWNLOADED → Resume Parser Agent
  console.log(C.cyan('\n━━━ 2) RESUME_DOWNLOADED → resumeParserAgent'));
  const eid2 = await send('RESUME_DOWNLOADED', RESUME_DOWNLOADED_EVENT);
  console.log(C.gray(`  event id: ${eid2}`));
  const r2 = await waitForRun(eid2, 90);
  const s2 = r2.status === 'Completed' ? C.green('✓') : C.red('✗');
  console.log(`  ${s2} status=${r2.status} run=${r2.run_id?.slice(0, 14)}`);
  let ev2 = { evidence: [] };
  if (r2.run_id) {
    ev2 = await fetchEvidence(r2.run_id);
    const sum = summarizeEvidence(ev2.evidence);
    console.log(C.gray(`    evidence: ${sum.count} rows · allmeta=${sum.allmeta} raas=${sum.raas} err=${sum.errors}`));
    console.log(C.gray(`    by kind: ${JSON.stringify(sum.byKind)}`));
  }

  // ── 3) RESUME_PROCESSED → Match Resume Agent
  console.log(C.cyan('\n━━━ 3) RESUME_PROCESSED → matchResumeAgent'));
  const eid3 = await send('RESUME_PROCESSED', RESUME_PROCESSED_EVENT);
  console.log(C.gray(`  event id: ${eid3}`));
  const r3 = await waitForRun(eid3, 90);
  const s3 = r3.status === 'Completed' ? C.green('✓') : C.red('✗');
  console.log(`  ${s3} status=${r3.status} run=${r3.run_id?.slice(0, 14)}`);
  let ev3 = { evidence: [] };
  if (r3.run_id) {
    ev3 = await fetchEvidence(r3.run_id);
    const sum = summarizeEvidence(ev3.evidence);
    console.log(C.gray(`    evidence: ${sum.count} rows · allmeta=${sum.allmeta} raas=${sum.raas} err=${sum.errors}`));
    console.log(C.gray(`    by kind: ${JSON.stringify(sum.byKind)}`));
  }

  // ── Flow-level grouping
  console.log(C.cyan('\n━━━ Flow-level grouping (the candidate-card view)'));
  for (const flow of [`jr:${JR_ID}`, `upload:${UPLOAD}`]) {
    const fr = await fetchFlow(flow);
    const total = fr.meta?.totalRows ?? 0;
    const runCount = fr.meta?.runCount ?? 0;
    console.log(`  ${flow.padEnd(45)} → ${total} evidence rows in ${runCount} run(s)`);
  }

  // ── Listing of Allmeta writes (Cypher hints)
  console.log(C.cyan('\n━━━ Allmeta writes (Cypher hints captured)'));
  const allRows = [...(ev1.evidence ?? []), ...(ev2.evidence ?? []), ...(ev3.evidence ?? [])];
  const writes = allRows.filter(r => r.step_kind === 'allmeta_write');
  if (writes.length === 0) {
    console.log(C.yellow('  (no Allmeta writes captured)'));
  } else {
    for (const w of writes) {
      const ok = w.error_message ? C.red('✗') : C.green('✓');
      console.log(`  ${ok} ${w.allmeta_label?.padEnd(28)} pk=${(w.allmeta_pk_value ?? '?').padEnd(28)} ${w.duration_ms}ms`);
      if (w.allmeta_neo4j) console.log(C.gray(`      ${w.allmeta_neo4j.slice(0, 110)}`));
      if (w.error_message) console.log(C.red(`      err: ${w.error_message.slice(0, 200)}`));
    }
  }

  // ── Summary
  console.log(C.bold(C.cyan('\n━━━ Summary')));
  console.log(`  Create JD Agent:      ${r1.status} · evidence=${ev1.evidence?.length ?? 0}`);
  console.log(`  Resume Parser Agent:  ${r2.status} · evidence=${ev2.evidence?.length ?? 0}`);
  console.log(`  Match Resume Agent:   ${r3.status} · evidence=${ev3.evidence?.length ?? 0}`);
  console.log(C.gray(`\n  Monitor URLs to open:`));
  console.log(C.gray(`    ${AO}/monitor/flows/${encodeURIComponent('jr:' + JR_ID)}`));
  console.log(C.gray(`    ${AO}/monitor/flows/${encodeURIComponent('upload:' + UPLOAD)}`));

  const ok = [r1, r2, r3].every(r => r.status === 'Completed');
  process.exit(ok ? 0 : 1);
})();
