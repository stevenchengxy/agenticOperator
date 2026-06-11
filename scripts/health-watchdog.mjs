#!/usr/bin/env node
// AO 存活探针 — 轮询关键服务,状态翻转时经 OpenClaw 网关推送企业微信,
// **并直写 AO 的 notification 表**(消息通知中心)。
//
// 设计约束(同 derive.ts 的承重原则):监控链路必须是确定性的、无 LLM —
// 智能层本身就是被监控对象。由 launchd 每 5 分钟拉起(见
// docs 集成说明 + ~/Library/LaunchAgents/com.ao.health-watchdog.plist)。
//
// 只在状态翻转时发消息:宕机报一次、恢复报一次(带宕机时长),不刷屏。
//
// 双写(2026-06-10):企微推送 + 直连 Postgres 写 notification 行。直写 DB
// 而不调 AO 的 API,因为被监控对象常常就是 AO 自己 — AO 挂了 API 不可用,
// 但 ao-postgres 容器独立存活;等 AO 回来,宕机/恢复记录已在通知中心里。
// 语义对齐 server/notifications/ingest.ts:宕机 = critical alert 按
// dedupeKey('watchdog.<key>')+status='firing' upsert;恢复 = 删旧 resolved
// 行 → firing 翻 resolved(同 lib/monitor/pg-read-port.ts markResolved 的
// 防唯一约束冲突顺序)+ 落一条带宕机时长的 info message。
// 已知缺口:OpenClaw 网关自身宕机时无法经它发送(只能落日志+通知中心),
// 由 Docker restart 策略兜底;网关恢复的翻转消息会正常补发。

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';

function env(k, d) {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : d;
}

const TARGETS = [
  { key: 'ao', name: 'Agentic Operator (:3002)', url: env('WATCH_AO_URL', 'http://localhost:3002/api/agents/health') },
  { key: 'inngest', name: 'Inngest (:8288)', url: env('WATCH_INNGEST_URL', 'http://localhost:8288/health') },
  { key: 'openclaw', name: 'OpenClaw 网关 (:18789)', url: env('WATCH_OPENCLAW_URL', 'http://127.0.0.1:18789/healthz') },
];

// DB 探针目标 — 监控骨干自身也要有人盯(2026-06-11 审计:archiver 卡死、
// sweeper 死亡之前零信号,整个告警层可以静默熄灯)。
//   postgres : pg 连接本身(审计落库的地基)
//   archiver : inngest_archive_cursor.last_poll_at 新鲜度(30s 轮询,>10min=死)
//   sweeper  : service_heartbeat id='monitor-sweeper' 心跳(60s tick,>10min=死)
const DB_STALE_MS = Number(env('WATCH_DB_STALE_MS', '')) || 10 * 60_000;
const DB_TARGETS = [
  { key: 'postgres', name: '本地审计数据库 (ao-postgres)' },
  { key: 'archiver', name: 'Inngest 归档器 (npm run archive)' },
  { key: 'sweeper', name: '监控扫描器 (monitor-sweeper)' },
];
const STATE_FILE = env('WATCH_STATE_FILE', join(homedir(), '.ao-watchdog', 'state.json'));
const WECOM_TARGETS = (process.env.WECOM_ALERT_TARGETS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CONTAINER = env('OPENCLAW_GATEWAY_CONTAINER', 'openclaw-openclaw-gateway-1');
const DOCKER = env('DOCKER_BIN', '/usr/local/bin/docker');
// 与 server/db/index.ts 同默认 — launchd 的 plist 没配 DATABASE_URL 也能写。
const DATABASE_URL = env('DATABASE_URL', 'postgresql://ao:ao_local_pw@localhost:5433/ao');

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(s) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function sendWecom(text) {
  return new Promise((resolve) => {
    if (WECOM_TARGETS.length === 0) return resolve(false);
    let pending = WECOM_TARGETS.length;
    let okAll = true;
    for (const t of WECOM_TARGETS) {
      // 企微规则:target 必须是「给机器人发过消息」的原始大小写 userId/groupId。
      execFile(
        DOCKER,
        ['exec', '-i', CONTAINER, 'node', 'dist/index.js', 'message', 'send',
          '--channel', 'wecom', '--account', 'default', '--target', t, '-m', text],
        { timeout: 20_000 },
        (err) => {
          if (err) {
            okAll = false;
            console.error(`[watchdog] send to ${t} failed: ${err.message}`);
          }
          if (--pending === 0) resolve(okAll);
        },
      );
    }
  });
}

const fmtMin = (ms) => Math.max(1, Math.round(ms / 60_000));

// ─── DB 探针:postgres 连通性 + archiver/sweeper 心跳新鲜度 ─────────────
// 返回 { client, results }:client 为 null 表示 pg 不可达(此时 archiver/
// sweeper 状态不可知,跳过判定,不误报)。client 由调用方负责 end()。
async function probeDbTargets() {
  const [pgT, arT, swT] = DB_TARGETS;
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
  } catch (e) {
    console.error(`[watchdog] postgres unreachable: ${e.message}`);
    return { client: null, results: [{ t: pgT, up: false }] };
  }
  const results = [{ t: pgT, up: true }];
  try {
    // 新鲜度在 SQL 端算(EXTRACT EPOCH):Prisma 存的是 UTC 的 timestamp
    // without tz,node-pg 会按本地时区解析 — JS 端比较会差 8 小时误报。
    const a = await client.query(
      `SELECT EXTRACT(EPOCH FROM (now() - last_poll_at)) * 1000 AS age_ms FROM inngest_archive_cursor LIMIT 1`,
    );
    const aAge = a.rows[0]?.age_ms != null ? Number(a.rows[0].age_ms) : null;
    results.push({ t: arT, up: aAge != null && aAge < DB_STALE_MS });
    const s = await client.query(
      `SELECT EXTRACT(EPOCH FROM (now() - "lastHeartbeatAt")) * 1000 AS age_ms FROM service_heartbeat WHERE id = 'monitor-sweeper'`,
    );
    const sAge = s.rows[0]?.age_ms != null ? Number(s.rows[0].age_ms) : null;
    results.push({ t: swT, up: sAge != null && sAge < DB_STALE_MS });
  } catch (e) {
    console.error(`[watchdog] db-target probe failed: ${e.message}`);
  }
  return { client, results };
}

// ─── DB 对账恢复 — state 文件无关的兜底 ────────────────────────────────
// state.json 丢失/恢复写失败时,firing 的 watchdog.* 行会永挂(2026-06-11
// 审计)。以 DB 为权威:服务当前在线、却还有它的 firing 行 → 解除。
// 在 transitions 处理之后跑,本轮正常恢复的行已被翻掉,剩下的就是孤儿。
async function reconcileOrphanFiring(client, upKeys) {
  if (!client || upKeys.length === 0) return;
  try {
    const keys = upKeys.map((k) => `watchdog.${k}`);
    const r = await client.query(
      `SELECT "dedupeKey", title FROM notification WHERE status = 'firing' AND "dedupeKey" = ANY($1)`,
      [keys],
    );
    for (const row of r.rows) {
      await client.query(`DELETE FROM notification WHERE "dedupeKey" = $1 AND status = 'resolved'`, [row.dedupeKey]);
      await client.query(
        `UPDATE notification SET status = 'resolved', "readAt" = COALESCE("readAt", now())
         WHERE "dedupeKey" = $1 AND status = 'firing'`,
        [row.dedupeKey],
      );
      console.log(`[watchdog] reconciled orphan firing alert: ${row.dedupeKey}`);
    }
  } catch (e) {
    console.error(`[watchdog] reconcile failed: ${e.message}`);
  }
}

// ─── AO 消息通知中心直写 ────────────────────────────────────────────────
// 宕机:critical alert,(dedupeKey,'firing') upsert,重复宕机只 bump count;
// 恢复:firing 翻 resolved(先删旧 resolved 行防唯一约束冲突)+ info message。
// 失败只 console.error,绝不影响企微推送链路。client 来自 probeDbTargets,
// 为 null(pg 不可达)时直接放弃落库 — 企微链路照常。
async function recordInAoCenter(client, transitions) {
  if (transitions.length === 0 || !client) return false;
  try {
    for (const tr of transitions) {
      const key = `watchdog.${tr.key}`;
      if (!tr.up) {
        await client.query(
          `INSERT INTO notification
             (id, kind, severity, category, source, title, body,
              "dedupeKey", status, disposition, "shouldNotify", "notifiedAt", "notifyChannel")
           VALUES ($1,'alert','critical','system','存活探针',$2,$3,$4,'firing','needs_human',true,now(),'in_app')
           ON CONFLICT ("dedupeKey", status)
           DO UPDATE SET count = notification.count + 1, "lastSeenAt" = now(),
                         title = EXCLUDED.title, body = EXCLUDED.body, "shouldNotify" = true`,
          [
            randomUUID(),
            `${tr.name} 不可达`,
            `存活探针检测到 ${tr.name} 不可达${tr.firstSeen ? '(首次检测)' : ''}。已尝试经 OpenClaw 网关推送企业微信;请检查对应进程/终端是否退出。`,
            key,
          ],
        );
      } else {
        await client.query(
          `DELETE FROM notification WHERE "dedupeKey" = $1 AND status = 'resolved'`,
          [key],
        );
        await client.query(
          `UPDATE notification SET status = 'resolved', "readAt" = COALESCE("readAt", now())
           WHERE "dedupeKey" = $1 AND status = 'firing'`,
          [key],
        );
        await client.query(
          `INSERT INTO notification
             (id, kind, severity, category, source, title, body, disposition, "shouldNotify")
           VALUES ($1,'message','info','system','存活探针',$2,$3,'info_only',false)`,
          [
            randomUUID(),
            `${tr.name} 已恢复`,
            `${tr.name} 已恢复,宕机约 ${tr.downMins} 分钟。`,
          ],
        );
      }
    }
    return true;
  } catch (e) {
    console.error(`[watchdog] AO notification write failed: ${e.message}`);
    return false;
  }
}

const now = Date.now();
const state = loadState();
const results = [];
for (const t of TARGETS) results.push({ t, up: await probe(t.url) });
const dbProbe = await probeDbTargets();
results.push(...dbProbe.results);

const transitions = [];
for (const { t, up } of results) {
  const prev = state[t.key];
  if (!prev) {
    // 首次见到这个目标:落基线;若一上来就是宕的,也要报。
    state[t.key] = { up, since: now };
    if (!up) transitions.push({ key: t.key, name: t.name, up: false, firstSeen: true });
    continue;
  }
  if (prev.up !== up) {
    transitions.push({
      key: t.key,
      name: t.name,
      up,
      downMins: up ? fmtMin(now - prev.since) : undefined,
    });
    state[t.key] = { up, since: now };
  }
}
saveState(state);

const summary = results.map(({ t, up }) => `${up ? '✓' : '✗'} ${t.key}`).join(' · ');
console.log(`[watchdog] ${new Date(now).toISOString()} ${summary}`);

if (transitions.length > 0) {
  const lines = transitions.map((tr) =>
    tr.up
      ? `🟢 ${tr.name} 已恢复(宕机约 ${tr.downMins} 分钟)`
      : `🔴 ${tr.name} 不可达${tr.firstSeen ? '(首次检测)' : ''}`,
  );
  const [sent, recorded] = await Promise.all([
    sendWecom(`🛡 AO 存活探针\n${lines.join('\n')}`),
    recordInAoCenter(dbProbe.client, transitions),
  ]);
  console.log(`[watchdog] transition alert sent=${sent} aoCenter=${recorded}: ${lines.join(' | ')}`);
}

// 对账兜底:本轮在线的服务若 DB 里还挂着 firing 行(state 丢失等),解除之。
await reconcileOrphanFiring(
  dbProbe.client,
  results.filter((r) => r.up).map((r) => r.t.key),
);
if (dbProbe.client) await dbProbe.client.end().catch(() => {});
