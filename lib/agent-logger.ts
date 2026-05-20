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
  };

  return {
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
