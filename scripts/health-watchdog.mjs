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

// ─── AO 消息通知中心直写 ────────────────────────────────────────────────
// 宕机:critical alert,(dedupeKey,'firing') upsert,重复宕机只 bump count;
// 恢复:firing 翻 resolved(先删旧 resolved 行防唯一约束冲突)+ info message。
// 失败只 console.error,绝不影响企微推送链路。
async function recordInAoCenter(transitions) {
  if (transitions.length === 0) return false;
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
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
          `UPDATE notification SET status = 'resolved' WHERE "dedupeKey" = $1 AND status = 'firing'`,
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
  } finally {
    await client.end().catch(() => {});
  }
}

const now = Date.now();
const state = loadState();
const results = [];
for (const t of TARGETS) results.push({ t, up: await probe(t.url) });

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
    recordInAoCenter(transitions),
  ]);
  console.log(`[watchdog] transition alert sent=${sent} aoCenter=${recorded}: ${lines.join(' | ')}`);
}
