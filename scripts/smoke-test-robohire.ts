// scripts/smoke-test-robohire.ts
//
// 手工跑一次真实 RoboHire 直连,验证 key + 网络 + payload 解析。
// CI 不跑(会扣 quota)。开发者上 PR-2 时跑一次。
//
// 跑法: npx tsx --env-file=.env.local scripts/smoke-test-robohire.ts <path-to-pdf>

import fs from 'node:fs';
import { parseResumeDirect, matchResumeDirect } from '../lib/robohire-client';

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: smoke-test-robohire.ts <path-to-pdf>');
    process.exit(1);
  }
  const pdf = fs.readFileSync(pdfPath);
  console.log(`[smoke] reading ${pdfPath} (${pdf.length} bytes)`);

  console.log('[smoke] calling parseResumeDirect...');
  const t0 = Date.now();
  const parsed = await parseResumeDirect(pdf, 'smoke.pdf', { traceId: 'smoke-trace-1' });
  console.log(
    `[smoke] parse OK in ${Date.now() - t0}ms · cached=${parsed.cached} · name="${parsed.data.name}" · requestId=${parsed.requestId}`,
  );

  console.log('[smoke] calling matchResumeDirect...');
  const t1 = Date.now();
  const match = await matchResumeDirect(
    {
      resume: `${parsed.data.name}\n${parsed.data.summary ?? ''}\nSkills: ${(parsed.data.skills ?? []).join(', ')}`,
      jd: 'We are hiring a Senior Frontend Developer with React expertise.',
    },
    { traceId: 'smoke-trace-1' },
  );
  console.log(
    `[smoke] match OK in ${Date.now() - t1}ms · score=${match.data.matchScore} · rec=${match.data.recommendation} · requestId=${match.requestId}`,
  );

  console.log('[smoke] ✅ both calls succeeded');
}

main().catch((e) => {
  console.error('[smoke] ❌ failed:', e);
  process.exit(1);
});
