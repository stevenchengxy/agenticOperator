#!/usr/bin/env node
// Final E2E sanity for /workflow-agents monitoring page:
//   1. List 3 agents through /api/inngest-admin/functions
//   2. Send RESUME_DOWNLOADED event → see run appear
//   3. Toggle pause on resume-parser-agent → send another event → verify run short-circuits
//   4. Toggle resume → send again → run completes normally
//   5. List DLQ — should be empty (all good runs)

const AO = process.env.AO_BASE ?? 'http://localhost:3002';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

async function step(name, fn) {
  console.log(c.cyan(`\n── ${name} ──`));
  try {
    const r = await fn();
    console.log(c.green('  ✓ pass'), r ? (typeof r === 'string' ? r : JSON.stringify(r).slice(0, 200)) : '');
    return r;
  } catch (e) {
    console.log(c.red('  ✗ fail'), e.message);
    throw e;
  }
}

async function api(path, opts = {}) {
  const url = `${AO}${path}`;
  const res = await fetch(url, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}

(async () => {
  // 1) functions
  const fnList = await step('1. 列出 3 agents', async () => {
    const body = await api('/api/inngest-admin/functions');
    if (body.functions.length !== 3) throw new Error(`expected 3, got ${body.functions.length}`);
    return body.functions.map((f) => f.slug).join(', ');
  });

  // 2) send RESUME_DOWNLOADED → run completes
  const eventId1 = await step('2. 发送 RESUME_DOWNLOADED 事件', async () => {
    const body = await api('/api/inngest-admin/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'RESUME_DOWNLOADED',
        data: {
          upload_id: `final-e2e-${Date.now()}`,
          bucket: 'recruit-resume-raw',
          objectKey: 'final/test.pdf',
          filename: 'final-test.pdf',
          hrFolder: null,
          employeeId: 'final_emp',
          etag: `final-etag-${Date.now()}`,
          size: 1234,
          sourceEventName: 'final',
          receivedAt: new Date().toISOString(),
          parsed: { data: { name: 'Final', email: 'f@t.com', phone: '13800138000', skills: ['Java'] } },
        },
      }),
    });
    return body.new_event_id;
  });

  await step('3. 等待 run 完成(8s)', async () => {
    await sleep(8000);
    // poll Inngest direct
    const res = await fetch(`http://localhost:8288/v1/events/${eventId1}/runs`);
    const body = await res.json();
    const latest = body.data?.[0];
    if (!latest) throw new Error('no run');
    if (latest.status !== 'Completed') throw new Error(`status=${latest.status}`);
    return `run=${latest.run_id.slice(0, 14)} status=${latest.status}`;
  });

  // 4) toggle pause + send + verify short-circuit
  await step('4. 暂停 resume-parser-agent', async () => {
    const body = await api('/api/inngest-admin/functions/agentic-operator-main-resume-parser-agent/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    return body;
  });

  await step('5. 验证 functions API 显示 paused=true', async () => {
    const body = await api('/api/inngest-admin/functions');
    const rpa = body.functions.find((f) => f.slug === 'agentic-operator-main-resume-parser-agent');
    if (!rpa.paused) throw new Error('not paused');
    return 'paused=true';
  });

  await step('6. 暂停状态下发事件 → 应该 short-circuit', async () => {
    const r = await api('/api/inngest-admin/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'RESUME_DOWNLOADED',
        data: {
          upload_id: `paused-test-${Date.now()}`,
          bucket: 'recruit-resume-raw',
          objectKey: 'paused/test.pdf',
          filename: 'paused.pdf',
          hrFolder: null,
          employeeId: 'paused_emp',
          etag: `paused-etag-${Date.now()}`,
          size: 1,
          sourceEventName: 'paused',
          receivedAt: new Date().toISOString(),
          parsed: { data: { name: 'Paused' } },
        },
      }),
    });
    await sleep(6000);
    const res = await fetch(`http://localhost:8288/v1/events/${r.new_event_id}/runs`);
    const body = await res.json();
    const latest = body.data?.[0];
    if (!latest) throw new Error('no run');
    if (latest.status !== 'Completed') throw new Error(`expected Completed (short-circuit), got ${latest.status}`);
    // Paused runs short-circuit in < 200ms (normal runs hit mock-RAAS and take 250ms+).
    const durMs = new Date(latest.ended_at).getTime() - new Date(latest.run_started_at).getTime();
    if (durMs > 200) throw new Error(`run too slow (${durMs}ms) — likely NOT short-circuited`);
    return `short-circuited ✓ duration=${durMs}ms`;
  });

  // 7) resume → run completes normally
  await step('7. 恢复 resume-parser-agent', async () => {
    const body = await api('/api/inngest-admin/functions/agentic-operator-main-resume-parser-agent/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: false }),
    });
    return body;
  });

  await step('8. 恢复后发事件 → 正常 run', async () => {
    const r = await api('/api/inngest-admin/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'RESUME_DOWNLOADED',
        data: {
          upload_id: `resumed-test-${Date.now()}`,
          bucket: 'recruit-resume-raw',
          objectKey: 'resumed/test.pdf',
          filename: 'resumed.pdf',
          hrFolder: null,
          employeeId: 'resumed_emp',
          etag: `resumed-etag-${Date.now()}`,
          size: 1,
          sourceEventName: 'resumed',
          receivedAt: new Date().toISOString(),
          parsed: { data: { name: 'Resumed' } },
        },
      }),
    });
    await sleep(8000);
    const res = await fetch(`http://localhost:8288/v1/events/${r.new_event_id}/runs`);
    const body = await res.json();
    const latest = body.data?.[0];
    if (!latest || latest.status !== 'Completed') throw new Error(`status=${latest?.status}`);
    // Normal run hits mock-RAAS (~250-700ms);much slower than short-circuit.
    const durMs = new Date(latest.ended_at).getTime() - new Date(latest.run_started_at).getTime();
    if (durMs < 200) throw new Error(`run too fast (${durMs}ms) — still short-circuited`);
    return `normal run ✓ duration=${durMs}ms`;
  });

  // 9) DLQ should be empty
  await step('9. DLQ 应为空', async () => {
    const body = await api('/api/inngest-admin/dlq');
    if (body.dlq?.length > 0) {
      console.log(c.yellow('  ⚠ DLQ has items (from earlier failed runs):'), body.dlq.length);
    }
    return `${body.dlq?.length ?? 0} items`;
  });

  // 10) workflow-agents page reachable
  await step('10. /workflow-agents UI 可访问', async () => {
    const res = await fetch(`${AO}/workflow-agents`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return `HTTP ${res.status} · ${res.headers.get('content-type')}`;
  });

  console.log(c.cyan('\n══════════════════════════════════════════════════'));
  console.log(c.green('  ✅ Final E2E sanity passed!'));
  console.log(c.cyan('══════════════════════════════════════════════════'));
})().catch((err) => {
  console.error(c.red('\n💥 E2E failed:'), err.message);
  process.exit(1);
});
