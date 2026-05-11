// 把 resume-parser-agent (默认 :3020/api/inngest) 手动注册到 Inngest dev server。
//
// 使用场景:
//   1. docker-compose 跑 inngest 时,docker-compose.inngest.yml 已经 -u 自动同步,
//      正常不需要跑这个脚本。
//   2. 用 `npm run inngest:dev`(本地 inngest-cli)启动时,CLI 默认只 autodiscovery
//      3000/8888 之类的端口,3020 扫不到 — 启动后手动 `npm run register` 一次即可。
//   3. 远程/LAN 开发(Inngest CLI 跑在另一台机器):通过 env 覆盖默认 localhost。
//
// Env:
//   INNGEST_BASE_URL  Inngest dev server 地址(默认 http://localhost:8288)
//   AO_LAN_IP         SDK host(默认 localhost。LAN 远程开发时填实际 IP)
//   AO_PORT           SDK 端口(默认 3020)

const INNGEST = process.env.INNGEST_BASE_URL ?? 'http://localhost:8288';
const AO_LAN_IP = process.env.AO_LAN_IP ?? 'localhost';
const AO_PORT = process.env.AO_PORT ?? '3020';

const url = `http://${AO_LAN_IP}:${AO_PORT}/api/inngest`;

(async () => {
  console.log(`[register] inngest=${INNGEST}`);
  console.log(`[register] this app url=${url}`);

  const r = await fetch(`${INNGEST}/fn/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  const text = await r.text();
  console.log(`[register] HTTP ${r.status}`);
  console.log(text);

  if (!r.ok) process.exit(1);
})().catch((e) => {
  console.error('[register] FAIL:', e);
  process.exit(1);
});
