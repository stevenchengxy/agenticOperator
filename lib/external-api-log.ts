// lib/external-api-log.ts
//
// 2026-05-26 — 通用外部 API in/out 落地 sink. 给 RoboHire / Allmeta(Neo4j) /
// partner-pg 共用. 直接同步 fs.appendFile + 同步 console.log echo,**不依赖
// AsyncLocalStorage** — Inngest step.run replay/retry 时 ALS context 会丢,
// 之前 currentLogger()?.apiCall(...) 在 step.run 内部静默 noop 把 RoboHire
// 响应吞了, 才有 2026-05-25 陈昊_前端简历.pdf "性别" 那条事故.
//
// 每条调用同时:
//   1. 写到 logs/<category>-YYYY-MM-DD.log 一行 JSON (in / out 都全)
//   2. 同步 echo 到 stdout — 多行可读, 大对象 indent
// 失败 swallow,不影响业务调用.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { terminalLogEnabled } from '@/lib/terminal-log';

const LOG_DIR = process.env.AO_LOG_DIR?.trim() || join(process.cwd(), 'logs');
const TERMINAL_ENABLED = terminalLogEnabled;

let dirEnsured = false;
function ensureDir(): void {
  if (dirEnsured) return;
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // 目录建不出来就不写,不阻塞 API
  }
}

function dayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type ApiLogCategory = 'robohire' | 'allmeta' | 'partner-pg' | 'rmhr';

export type ApiLogEntry = {
  category: ApiLogCategory;
  /** 操作名,e.g. "RoboHire.parseResume" / "Allmeta.PUT /instances/Candidate" / "pg.INSERT INTO candidate" */
  label: string;
  url?: string;
  method?: string;
  trace_id?: string | null;
  /** HTTP status / 0 / null. */
  status?: number | null;
  duration_ms?: number;
  /** 完整入参 — 1:1 dump, 不 cherry-pick. PDF 等二进制可以摘要(filename + bytes). */
  request?: unknown;
  /** 完整出参 — 1:1 dump. */
  response?: unknown;
  /** 失败时填. */
  error?: string;
  /** 任意补充. */
  meta?: Record<string, unknown>;
};

/**
 * 通用外部 API 调用日志记录器.
 * - 写 logs/<category>-YYYY-MM-DD.log (1 行 JSON, 字段全)
 * - 同时 echo 到 stdout (彩色 + multi-line for big objects)
 */
export function logApiCall(entry: ApiLogEntry): void {
  const ts = new Date().toISOString();
  const fileLine = JSON.stringify({ ts, ...entry }, jsonReplacer) + '\n';
  try {
    ensureDir();
    if (dirEnsured) {
      const file = join(LOG_DIR, `${entry.category}-${dayStamp()}.log`);
      appendFileSync(file, fileLine, 'utf8');
    }
  } catch (e) {
    // 日志写挂只 console.error 提示, 不传给 caller
    // eslint-disable-next-line no-console
    console.error(`[api-log:${entry.category}] write failed:`, (e as Error).message);
  }
  if (TERMINAL_ENABLED) echoToTerminal(entry, ts);
}

// ── Terminal echo ──────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function categoryColor(cat: ApiLogCategory): string {
  switch (cat) {
    case 'robohire':
      return ANSI.cyan;
    case 'allmeta':
      return ANSI.blue;
    case 'partner-pg':
      return ANSI.yellow;
    default:
      return ANSI.gray;
  }
}

function echoToTerminal(entry: ApiLogEntry, ts: string): void {
  const okMark = entry.error ? `${ANSI.red}✗${ANSI.reset}` : `${ANSI.green}✓${ANSI.reset}`;
  const catTag = `${categoryColor(entry.category)}[${entry.category}]${ANSI.reset}`;
  const tsTag = `${ANSI.dim}${ts}${ANSI.reset}`;
  const status = entry.status != null ? ` ${entry.status}` : '';
  const dur = entry.duration_ms != null ? ` ${entry.duration_ms}ms` : '';
  const trace = entry.trace_id ? ` ${ANSI.dim}trace=${entry.trace_id}${ANSI.reset}` : '';
  // 头一行: ✓ [robohire] 2026-05-26T... RoboHire.parseResume 200 423ms
  // eslint-disable-next-line no-console
  console.log(`${okMark} ${catTag} ${tsTag} ${entry.label}${status}${dur}${trace}`);

  if (entry.error) {
    // eslint-disable-next-line no-console
    console.log(`  ${ANSI.red}error:${ANSI.reset} ${entry.error}`);
  }
  if (entry.request !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`  ${ANSI.dim}request:${ANSI.reset} ${prettyJson(entry.request)}`);
  }
  if (entry.response !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`  ${ANSI.dim}response:${ANSI.reset} ${prettyJson(entry.response)}`);
  }
}

/** Pretty JSON, 多行;Buffer / pdf 二进制用 summary. */
function prettyJson(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'string') {
    if (v.length > 2000) return v.slice(0, 2000) + `…(+${v.length - 2000} chars)`;
    return v;
  }
  try {
    const s = JSON.stringify(v, jsonReplacer, 2);
    if (s.length > 4000) return s.slice(0, 4000) + `…(+${s.length - 4000} chars)`;
    return s;
  } catch {
    return String(v);
  }
}

/**
 * JSON.stringify replacer — 把 Buffer / Uint8Array 等二进制变成摘要,
 * 避免日志里塞 100KB+ base64 噪音.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    // Node Buffer
    if ((value as Buffer).constructor?.name === 'Buffer') {
      const buf = value as Buffer;
      return { __buffer_summary: true, byte_length: buf.byteLength };
    }
    // Uint8Array
    if (value instanceof Uint8Array) {
      return { __uint8array_summary: true, byte_length: value.byteLength };
    }
  }
  return value;
}
