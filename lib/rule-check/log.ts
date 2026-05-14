// Rule-check audit logger. Server-only.
//
// Appends timestamped lines to lib/rule-check/logs/YYYY-MM-DD.log so that every
// LLM call and every neo4j fetch made during a /rule-check run is traceable
// after the fact. The log is JSON-lines so it's grep-able and parseable.
//
// Usage:
//   import { ruleCheckLog } from "@/lib/rule-check/log";
//   ruleCheckLog.info("scenario.start", { scenario_id: "S02", model: "gemini-…" });
//   ruleCheckLog.data("graph.fetched", { candidate_id, slots: {…} });
//
// All writes are async-fire-and-forget — failures (e.g. disk full, perm denied)
// are swallowed and logged to stderr so they never break the actual eval flow.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.join(process.cwd(), 'lib', 'rule-check', 'logs');

function todayStamp(): string {
  // YYYY-MM-DD in local time (matches the user's expectation for filename).
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function logFilePath(): string {
  return path.join(LOG_DIR, `${todayStamp()}.log`);
}

let dirReady: Promise<void> | null = null;
async function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = fs.mkdir(LOG_DIR, { recursive: true }).then(() => undefined);
  }
  return dirReady;
}

async function append(line: string): Promise<void> {
  try {
    await ensureDir();
    await fs.appendFile(logFilePath(), line + '\n', { encoding: 'utf8' });
  } catch (err) {
    // Never let logging failure poison the eval. Surface to stderr for ops.
    console.error('[rule-check/log] failed to write:', (err as Error).message);
  }
}

function fmt(level: string, event: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const payload = data === undefined ? '' : ' ' + safeJson(data);
  return `${ts} [${level}] ${event}${payload}`;
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
  // Truncate huge strings (raw LLM output, prompt) at 20k chars so the log
  // stays readable. Anything truncated gets a marker.
  if (typeof value === 'string' && value.length > 20000) {
    return value.slice(0, 20000) + `… [+${value.length - 20000} chars truncated]`;
  }
  return value;
}

export const ruleCheckLog = {
  /** General info events: scenario start/end, classification, summary. */
  info(event: string, data?: unknown): void {
    void append(fmt('INFO', event, data));
  },
  /** Data dumps: graph context, LLM input/output, neo4j fetch results. */
  data(event: string, data?: unknown): void {
    void append(fmt('DATA', event, data));
  },
  /** Errors / runtime failures. */
  error(event: string, data?: unknown): void {
    void append(fmt('ERROR', event, data));
  },
  /** Returns the resolved log file path (used by tests + diagnostics). */
  currentLogFile(): string {
    return logFilePath();
  },
};
