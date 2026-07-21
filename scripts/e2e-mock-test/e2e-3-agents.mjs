#!/usr/bin/env node
// E2E tests for the 3 real PRA agents — Node version (macOS-friendly).

const INNGEST = process.env.INNGEST_BASE ?? 'http://localhost:8288';
const GQL = `${INNGEST}/v0/gql`;

const colors = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendEvent(name, data) {
  const res = await fetch(`${INNGEST}/e/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  const body = await res.json();
  return body.ids?.[0] ?? body.error ?? '?';
}

async function listRunsForEvent(eventId) {
  // Inngest REST API: /v1/events/:id/runs (correct + simple)
  const res = await fetch(`${INNGEST}/v1/events/${eventId}/runs`);
  const body = await res.json();
  return body.data ?? [];
}

async function waitForRunByEvent(eventId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastStatus = null;
  let lastRunId = null;
  while (Date.now() < deadline) {
    const runs = await listRunsForEvent(eventId);
    if (runs.length > 0) {
      const latest = runs[runs.length - 1];
      lastRunId = latest.run_id;
      lastStatus = latest.status;
      if (['Completed', 'Failed', 'Cancelled'].includes(latest.status)) {
        return { runID: latest.run_id, status: latest.status, output: latest.output };
      }
      process.stdout.write(colors.gray(`  run ${latest.run_id.slice(0, 12)}... status=${latest.status}\n`));
    }
    await sleep(2000);
  }
  return { runID: lastRunId, status: lastStatus ?? 'TIMEOUT' };
}

async function runTest(name, eventName, eventData, timeoutSec = 60) {
  console.log(colors.cyan('\n════════════════════════════════════════════════════════'));
  console.log(colors.cyan(`  E2E: ${name}`));
  console.log(colors.cyan(`  trigger: ${eventName}`));
  console.log(colors.cyan('════════════════════════════════════════════════════════'));
  const eventId = await sendEvent(eventName, eventData);
  console.log(`  emitted event id: ${eventId}`);
  const result = await waitForRunByEvent(eventId, timeoutSec);
  if (result.status === 'Completed') {
    console.log(colors.green(`  ✅ PASS · run=${result.runID} · status=${result.status}`));
  } else if (result.status === 'Failed') {
    console.log(colors.red(`  ⚠ FAIL · run=${result.runID} · status=${result.status} — check Inngest dashboard for error`));
  } else {
    console.log(colors.red(`  ⚠ TIMEOUT/UNKNOWN · status=${result.status}`));
  }
  return result;
}

// ─────────────────────────────────────────────────────────
// Run all 3 E2E tests
// ─────────────────────────────────────────────────────────

(async () => {
  const e2e1 = await runTest(
    'Resume Parser Agent',
    'RESUME_DOWNLOADED',
    {
      upload_id: 'e2e-rpa-test-001',
      bucket: 'recruit-resume-raw',
      objectKey: 'e2e/test-resume.pdf',
      filename: 'e2e-test-resume.pdf',
      hrFolder: null,
      employeeId: 'e2e_employee_001',
      etag: 'e2e-mock-etag-001',
      size: 12345,
      sourceEventName: 'test',
      receivedAt: '2026-05-14T15:00:00Z',
      parsed: {
        data: {
          name: 'E2E 测试候选人',
          email: 'e2e@test.com',
          phone: '13800138001',
          location: '北京',
          summary: 'E2E 测试用候选人简历',
          experience: [
            { title: '高级研发工程师', company: '字节跳动', startDate: '2022-01', endDate: '2024-12', description: 'Java 后端开发' },
          ],
          education: [{ degree: '本科', field: '计算机', institution: '清华大学', graduationYear: '2021' }],
          skills: ['Java', 'MySQL', 'Redis'],
        },
      },
    },
    45,
  );

  const e2e2 = await runTest(
    'Create JD Agent (workflow node 4)',
    'REQUIREMENT_LOGGED',
    {
      entity_type: 'Job_Requisition',
      entity_id: 'e2e-jr-test-001',
      event_id: 'e2e-evt-jr-001',
      payload: {
        job_requisition_id: 'e2e-jr-test-001',
        client_id: 'e2e-client-001',
        raw_input_data: {
          prompt: '招聘一名 Java 高级研发工程师,北京,5年经验,薪资 30-50k',
          language: 'zh',
        },
      },
      trace: { trace_id: 'e2e-trace-001', request_id: 'e2e-req-001' },
    },
    90,
  );

  const e2e3 = await runTest(
    'Match Resume Agent (workflow node 10)',
    'RESUME_PROCESSED',
    {
      upload_id: 'e2e-mra-test-001',
      objectKey: 'e2e/test-resume-2.pdf',
      filename: 'e2e-test-resume-2.pdf',
      bucket: 'recruit-resume-raw',
      hrFolder: null,
      employeeId: 'e2e_employee_002',
      etag: 'e2e-mock-etag-002',
      size: 12345,
      sourceEventName: 'test',
      receivedAt: '2026-05-14T15:00:00Z',
      candidate_id: 'e2e-cand-mra-001',
      resume_id: 'e2e-resume-mra-001',
      job_requisition_id: 'e2e-jr-test-001',
      parsed: {
        data: {
          name: 'E2E MRA 测试',
          email: 'mra@test.com',
          phone: '13800138002',
          summary: 'Java 工程师',
          experience: [{ title: 'Java 研发', company: '腾讯', startDate: '2020-01', endDate: '2024-06' }],
          skills: ['Java', 'Spring', 'MySQL'],
        },
      },
      candidate: {},
      candidate_expectation: {},
      resume: {},
      parsedAt: '2026-05-14T15:00:00Z',
      parserVersion: 'v7-pull-model@2026-05-08',
    },
    90,
  );

  console.log(colors.cyan('\n════════════════════════════════════════════════════════'));
  console.log(colors.cyan('  Summary'));
  console.log(colors.cyan('════════════════════════════════════════════════════════'));
  console.log(`  E2E 1 (resume-parser-agent):   ${e2e1.status} · run=${e2e1.runID?.slice(0, 14)}`);
  console.log(`  E2E 2 (create-jd-agent):       ${e2e2.status} · run=${e2e2.runID?.slice(0, 14)}`);
  console.log(`  E2E 3 (match-resume-agent):    ${e2e3.status} · run=${e2e3.runID?.slice(0, 14)}`);

  const allPassed = [e2e1, e2e2, e2e3].every((r) => r.status === 'Completed');
  process.exit(allPassed ? 0 : 1);
})();
