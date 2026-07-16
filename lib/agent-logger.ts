// Per-agent step logger.
//
// 每个 agent 在 handler 顶端调 createAgentLogger({agent, runId, traceId});
// 之后 step.run 进入/退出 + 关键 input/output + 外部 API 调用都通过
// logger 写入 logs/<agent>-YYYY-MM-DD.log(JSON-lines)。
//
// 设计:
//   - 异步 fire-and-forget,不 await,不阻塞主流程;
//   - 内部 queue + serialized append,避免多个 step.run 并发写 fd 冲突;
//   - 失败 swallow + console.error,不污染 inngest run。
//
// 用 process.env.AO_LOG_DIR 可覆盖(默认 <repo root>/logs)。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { terminalLogEnabled } from '@/lib/terminal-log';
import { mirrorAgentFileLog } from '@/server/log/log-event';

const LOG_DIR = process.env.AO_LOG_DIR ?? path.join(process.cwd(), 'logs');

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = fs.mkdir(LOG_DIR, { recursive: true }).then(() => undefined);
  }
  return dirReady;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, jsonReplacer);
  } catch {
    return '"[unserializable]"';
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (typeof value === 'string' && value.length > 20000) {
    return value.slice(0, 20000) + `… [+${value.length - 20000} chars truncated]`;
  }
  return value;
}

// ──────────────────────────────────────────────────────────────────────
// Terminal echo — mirrors every event/apiCall line to stdout so the dev
// sees full input / output / response JSON live in the dev server log,
// not just buried in logs/*.log. The file write is the source of truth;
// the terminal line is a convenience preview. The AO_TERMINAL_LOG switch
// (see lib/terminal-log.ts) gates this; it's off by default in production.
// ──────────────────────────────────────────────────────────────────────

const TERMINAL_LOG_ENABLED = terminalLogEnabled;

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function colorForKind(kind: string): string {
  if (kind.includes('error') || kind.includes('failure') || kind.includes('failed')) return ANSI.red;
  if (kind.includes('done') || kind.endsWith('.ok') || kind.includes('passed')) return ANSI.green;
  if (kind.startsWith('emit.')) return ANSI.magenta;
  if (kind.startsWith('api.') || kind.startsWith('pg.')) return ANSI.yellow;
  return ANSI.cyan;
}

function shortAnchors(anchors?: Record<string, string | null | undefined>): string {
  if (!anchors) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(anchors)) {
    if (!v) continue;
    // Truncate UUIDs / long ids to first 8 chars for readability.
    const short = v.length > 24 ? `${v.slice(0, 8)}…` : v;
    parts.push(`${k.replace('_id', '')}=${short}`);
  }
  return parts.length ? ` ${ANSI.dim}${parts.join(' ')}${ANSI.reset}` : '';
}

function compactJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => {
      // Keep strings full for terminal — caller may need to see RoboHire
      // response in full. If too long for screen they can grep file log.
      return val;
    });
  } catch {
    return '"[unserializable]"';
  }
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '"[unserializable]"';
  }
}

function echoToTerminal(ctx: AgentLoggerCtx, kind: string, payload: unknown): void {
  if (!TERMINAL_LOG_ENABLED) return;
  const color = colorForKind(kind);
  const prefix = `${color}[${ctx.agent}/${kind}]${ANSI.reset}`;
  const anchors = shortAnchors(ctx.anchors);

  // api.* kinds carry {url, method, request, response, status, durationMs}.
  // Render as a multi-line block so request + response are scannable.
  const looksLikeApiCall =
    kind.startsWith('api.') &&
    payload != null &&
    typeof payload === 'object' &&
    ('request' in (payload as object) || 'response' in (payload as object));

  if (looksLikeApiCall) {
    const p = payload as Record<string, unknown>;
    const meta = `${p.method ?? '?'} ${p.url ?? '?'} → ${p.status ?? '-'} (${p.durationMs ?? '?'}ms)`;
    // eslint-disable-next-line no-console
    console.log(`${prefix}${anchors} ${ANSI.dim}${meta}${ANSI.reset}`);
    if (p.error) {
      // eslint-disable-next-line no-console
      console.log(`  ${ANSI.red}error:${ANSI.reset} ${p.error}`);
    }
    if (p.request !== undefined) {
      // eslint-disable-next-line no-console
      console.log(`  ${ANSI.dim}request:${ANSI.reset} ${prettyJson(p.request)}`);
    }
    if (p.response !== undefined) {
      // eslint-disable-next-line no-console
      console.log(`  ${ANSI.dim}response:${ANSI.reset} ${prettyJson(p.response)}`);
    }
    return;
  }

  // Default: single compact line, full JSON payload.
  // eslint-disable-next-line no-console
  console.log(`${prefix}${anchors} ${compactJson(payload)}`);
}

export type AgentLoggerCtx = {
  agent: string;
  runId: string;
  traceId?: string | null;
  /** 可选业务 anchor,补 candidate/jr/upload_id 方便后期查证。 */
  anchors?: Record<string, string | null | undefined>;
};

export interface AgentLogger {
  /** step.run 包裹:start/end/error 三相,end 带 ms。 */
  step<T>(stepId: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T>;
  /** 任意事件 — 写一行 JSON。 */
  event(kind: string, data?: unknown): void;
  /** 外部 API 调用 — URL + req + resp 三件套。  */
  apiCall(
    label: string,
    info: { url: string; method?: string; request?: unknown; response?: unknown; status?: number; durationMs?: number; error?: string },
  ): void;
  /** 当前日志文件路径(诊断用)。 */
  currentLogFile(): string;
  /** 归属上下文(agent/runId/traceId) — 外部调用 sink 落库时取归属用。null logger 无。 */
  readonly ctx?: AgentLoggerCtx;
}

export function createAgentLogger(ctx: AgentLoggerCtx): AgentLogger {
  const file = path.join(LOG_DIR, `${ctx.agent}-${todayStamp()}.log`);
  let chain: Promise<void> = Promise.resolve();

  const write = (kind: string, payload: unknown): void => {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        agent: ctx.agent,
        run_id: ctx.runId,
        trace_id: ctx.traceId ?? null,
        anchors: ctx.anchors ?? undefined,
        kind,
        payload,
      }, jsonReplacer) + '\n';
    chain = chain
      .then(() => ensureDir())
      .then(() => fs.appendFile(file, line, 'utf8'))
      .catch((err) => {
        console.error(`[agent-logger:${ctx.agent}] write failed:`, (err as Error).message);
      });
    // 2026-05-21 — mirror to terminal so the dev sees入参/出参/response JSON
    // without grepping log files. Compact one-line for normal events;
    // multi-line pretty-printed for api.* kinds (which carry request +
    // response objects that are most useful read top-to-bottom).
    echoToTerminal(ctx, kind, payload);
    // 2026-06-01 — bridge into the DB so the real agents (which log to files,
    // not Prisma) show up in the unified audit log (/api/log-events) and route
    // their errors into 消息通知. Fire-and-forget; never blocks the file write.
    void mirrorAgentFileLog({
      agent: ctx.agent,
      runId: ctx.runId,
      traceId: ctx.traceId,
      anchors: ctx.anchors,
      kind,
      payload,
    });
  };

  return {
    ctx,
    async step<T>(stepId: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
      const start = Date.now();
      write('step.start', { step_id: stepId, meta });
      try {
        const out = await fn();
        write('step.end', {
          step_id: stepId,
          duration_ms: Date.now() - start,
          // 默认不全量 dump 输出 — 调用方按需在 meta 里手动加 summary。
          output_summary: summarize(out),
        });
        return out;
      } catch (err) {
        write('step.error', {
          step_id: stepId,
          duration_ms: Date.now() - start,
          error: (err as Error).message,
          stack: (err as Error).stack?.split('\n').slice(0, 6).join('\n'),
        });
        throw err;
      }
    },
    event(kind, data) {
      write(kind, data);
    },
    apiCall(label, info) {
      write(`api.${label}`, info);
    },
    currentLogFile() {
      return file;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// AsyncLocalStorage-based current-logger context.
//
// Cross-cutting telemetry (every Postgres query, every allmeta HTTP call,
// every Neo4j write) shouldn't require explicit logger threading through
// every function signature in partner-pg/* and allmeta-*. Instead, each
// agent handler wraps its body with `runWithLogger(fileLogger, async () => …)`;
// every nested call can then read `currentLogger()` and emit apiCall events
// without knowing about logger plumbing.
//
// Outside an agent (UI diagnostics, tests, scripts), `currentLogger()` returns
// null → all logging is a silent no-op, no behavioral change.
// ──────────────────────────────────────────────────────────────────────

const loggerStorage = new AsyncLocalStorage<AgentLogger>();

export function runWithLogger<T>(logger: AgentLogger, fn: () => Promise<T> | T): Promise<T> | T {
  return loggerStorage.run(logger, fn);
}

export function currentLogger(): AgentLogger | null {
  return loggerStorage.getStore() ?? null;
}

/** No-op logger — 给没有 run context 的调用方(UI 诊断 / 测试)用。 */
export function createNullLogger(): AgentLogger {
  return {
    async step<T>(_stepId: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    event() {
      /* noop */
    },
    apiCall() {
      /* noop */
    },
    currentLogFile() {
      return '';
    },
  };
}

/** 取 output 的轻量摘要(对象列 keys + 长度;数组列 length;其它原样)。 */
function summarize(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return { _type: 'array', length: v.length };
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  // 小对象直接 inline,大的列 keys
  if (keys.length <= 6) {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const x = r[k];
      if (typeof x === 'string' && x.length > 200) out[k] = `${x.slice(0, 200)}… (+${x.length - 200})`;
      else if (Array.isArray(x)) out[k] = `[Array len=${x.length}]`;
      else if (x && typeof x === 'object') out[k] = `{${Object.keys(x as object).length} keys}`;
      else out[k] = x;
    }
    return out;
  }
  return { _type: 'object', keys };
}
