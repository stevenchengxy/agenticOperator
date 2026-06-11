// 把真实 run 的 RESUME_PROCESSED 事件**发进 Inngest dev server**(替代 RAAS 发事件),
// 让真实的 ruleCheck agent 真正跑一遍 —— 事件流转(/events · /live)和监控页面
// (/monitor)都能看到这条 run。不碰 RAAS 入站,只是「我们自己」把事件投进去。
//
// 跑:`npm run emit:real-run`
//
// 注意:rule-check agent 在 step 'list-requirements' 里直读 partner Postgres 取 JR。
// 若 partner-pg(同事的 192.168.1.102)不可达,这一步会失败 → Inngest 重试 → run
// 标失败。事件流转 + 监控条目仍可见(失败也是可见的);partner-pg 恢复后再发就会
// 完整成功(bg=CDG → 抓取 10-42 → PASS)。

import { inngest } from '../server/inngest/client';
import { realResumeProcessedEvent, REAL_ANCHORS } from '../server/inngest/agents/__fixtures__/real-run-chensiying';

(async () => {
  const evt = realResumeProcessedEvent();
  const result = await inngest.send({ name: evt.name, data: evt.data as Record<string, unknown> });
  console.log(`[emit] ✅ 已发 ${evt.name} 进 Inngest`);
  console.log(`  event ids: ${JSON.stringify(result.ids)}`);
  console.log(`  candidate=陈思 · candidate_id=${REAL_ANCHORS.candidate_id}`);
  console.log(`  JR=${REAL_ANCHORS.job_requisition_id}`);
  console.log('');
  console.log('观察事件流转 + 监控:');
  console.log('  - AO 监控页:http://localhost:3002/monitor  (或 /live · /events)');
  console.log('  - Inngest dev:http://localhost:8288/stream  (事件流) · /runs (run 详情)');
  console.log('');
  console.log('⚠ 若 partner-pg(192.168.1.102)不可达,run 会在 list-requirements 步失败');
  console.log('  (取不到 JR)。这条 run 仍会出现在监控里(失败状态)。');
  process.exit(0);
})().catch((e) => {
  console.error('[emit] FAIL:', e);
  process.exit(1);
});
