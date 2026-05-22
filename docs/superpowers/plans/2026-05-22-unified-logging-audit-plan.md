# Unified Logging & Traceable Audit — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate AO's three parallel log/audit paths (`AuditLog`, `AgentActivity`, file JSONL) into a single `LogEvent` table + one `logger` entry point + a 6-page minimalist `/audit/*` UI, so any agent / event / LLM call / external API call can be drilled down by `runId × traceId × eventInstanceId × candidate_id / job_requisition_id`.

**Architecture:** Additive — new `LogEvent` Prisma model + new `server/log/logger.ts` writer. Existing `AuditLog` / `AgentActivity` tables and APIs are **untouched**; dual-write happens behind the new logger. New `/audit/*` UI reads only `LogEvent`. Zero-touch agent coverage via `wrapInngestHandler`. LLM gateway gains automatic prompt/response/cost capture. Old `lib/agent-logger.ts` and `server/agent-logger.ts` become re-export shims so legacy call-sites keep working.

**Tech Stack:** Prisma + SQLite (existing) · Next.js 16 App Router + React 19 · Tailwind v4 (CSS-var design tokens in `app/globals.css`) · vitest (`vitest run`) · TypeScript 5 · Inngest 4.

**Reference design doc:** [`docs/superpowers/specs/2026-05-22-unified-logging-audit-design.md`](../specs/2026-05-22-unified-logging-audit-design.md) (committed `bbe13c1`). All section references below (`§N`) point into that spec.

**Working policy:**
- Work directly on `main` (per project memory: no worktrees on AO).
- Every commit uses `git commit -m "…" -- <files>` pathspec form (per memory: pre-commit hook re-stages everything otherwise).
- Each task ends with a commit. No "save up commits" batching.
- For UI tasks: start `npm run dev` and click through the route in a browser before checking the step complete (per CLAUDE.md).
- Reference the design doc when in doubt — don't re-litigate decisions here.

---

## File Structure

### New files (24)

**Server / writer:**
- `server/log/logger.ts` — unified `AgentLogger` factory + 3 sinks (DB / file JSONL / terminal ANSI)
- `server/log/price-table.ts` — 5 model LLM USD/1K prices
- `server/log/cost.ts` — `computeCost(model, usage)`
- `server/log/traceable.ts` — `assertTraceable(ctx)` + `untraceable()` helper
- `server/log/logger.test.ts`
- `server/log/cost.test.ts`
- `server/inngest/wrap-handler.ts` — `wrapInngestHandler(meta, handler)`
- `server/inngest/wrap-handler.test.ts`

**API:**
- `app/api/logs/route.ts` — GET unified query
- `app/api/logs/route.test.ts`
- `app/api/logs/aggregates/route.ts` — GET aggregates
- `app/api/logs/aggregates/route.test.ts`
- `app/api/logs/[id]/route.ts` — GET single (with full payload)
- `app/api/logs/[id]/route.test.ts`

**UI — pages:**
- `app/audit/layout.tsx`
- `app/audit/page.tsx` (overview — rewrite)
- `app/audit/stream/page.tsx`
- `app/audit/events/page.tsx`
- `app/audit/agents/page.tsx`
- `app/audit/agents/[short]/page.tsx`
- `app/audit/llm/page.tsx`
- `app/audit/runs/[id]/page.tsx`

**UI — components:**
- `components/audit/AuditNav.tsx`
- `components/audit/OverviewContent.tsx`
- `components/audit/StreamContent.tsx`
- `components/audit/EventsContent.tsx`
- `components/audit/AgentsContent.tsx`
- `components/audit/AgentDetailContent.tsx`
- `components/audit/LlmContent.tsx`
- `components/audit/RunContent.tsx`
- `components/audit/LogRowDrawer.tsx`
- `components/audit/JumpButton.tsx`

### Modified files (14)

- `prisma/schema.prisma` — add `LogEvent` model
- `lib/agent-logger.ts` — re-export shim (delete body, point at `server/log/logger.ts`)
- `server/agent-logger.ts` — re-export shim (keep `ensureWorkflowRun`/`markRunComplete` here; logger fns re-exported)
- `server/em/persistence.ts` — `writeAudit` adds LogEvent dual-write
- `lib/manage/audit.ts` — `writeManageAudit` adds LogEvent dual-write
- `server/llm/gateway.ts` — `chatComplete` calls `currentLogger()?.llmCall(...)`
- `server/inngest/agents/create-jd-agent.ts` — wrap with `wrapInngestHandler`
- `server/inngest/agents/match-resume-agent.ts` — same
- `server/inngest/agents/rule-check-agent.ts` — same
- `server/inngest/agents/resume-parser-agent.ts` — same
- `server/inngest/agents/stub-factory.ts` — same (single change covers all stub agents)
- `lib/i18n.tsx` — +30 `audit_*` keys (zh + en)
- `components/shared/LeftNav.tsx` — keep `/audit` as single nav item (sub-nav lives inside `/audit` layout per spec §7.2)
- `components/live/RealRunDetail.tsx`, `components/monitor/RunDetailContent.tsx`, `components/monitor/FailureDetailContent.tsx`, `components/fleet/AgentDetailPanel.tsx`, `components/events/EventInstancesTab.tsx` — add `<JumpButton/>` (P3 §5)

### Deleted files (1)

- `components/audit/AuditContent.tsx` — replaced by per-sub-page components (delete in P3)

---

## Env vars

Add to `.env.example` (no value set by default — sane defaults in code):

```bash
# Unified logging
LOG_EVENT_WRITE=1                 # 1=write LogEvent table; 0=skip (rollback switch)
LOG_FILE_JSONL=1                  # 1=also write logs/<agent>-<date>.log; 0=skip
LOG_LLM_BODIES=heads              # full | heads | none — prompt/response capture
AO_LOG_DIR=                       # override file log dir (default <repo>/logs)
AO_TERMINAL_LOG=1                 # 1=ANSI echo to stdout (existing var)
```

---

## Chunk 1 — Schema + Writer foundation (P0a)

Creates the data plumbing. After this chunk, **`LogEvent` table exists** and **`server/log/logger.ts` can write to it**, but no production caller uses the new logger yet.

### Task 1: Add `LogEvent` Prisma model

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Edit `prisma/schema.prisma`** — append the model below to the file (after the last existing model):

```prisma
// =====================================================================
// Unified logging (spec 2026-05-22)
// =====================================================================
model LogEvent {
  id                   String   @id @default(cuid())
  ts                   DateTime @default(now())
  level                String   // debug | info | notice | warn | error | critical
  category             String   // event_publish | agent_lifecycle | agent_step
                                // | tool_call | llm_call | api_call | db_call
                                // | manage_action | system
  source               String   // ws | em | manage | system | external | raas
  process              String   // next | inngest | raas-bridge | <external-pid>

  // Correlation keys (sparse). At least one of runId / traceId /
  // eventInstanceId must be present for a row to be "traceable" —
  // see server/log/traceable.ts.
  agent                String?
  runId                String?
  traceId              String?
  eventInstanceId      String?
  eventName            String?
  anchorsJson          String?

  // Payload (max 256 KB; truncated marker appended)
  message              String
  payloadJson          String?
  payloadDigest        String?
  durationMs           Int?
  status               String?  // ok | err | warn | pending

  // LLM-specific (only set when category=llm_call)
  llmModel             String?
  llmPromptTokens      Int?
  llmCompletionTokens  Int?
  llmTotalTokens       Int?
  llmCostUsd           Float?
  llmFinishReason      String?

  @@index([ts])
  @@index([agent, ts])
  @@index([runId, ts])
  @@index([traceId, ts])
  @@index([eventInstanceId])
  @@index([eventName, ts])
  @@index([category, ts])
  @@index([level, ts])
}
```

- [ ] **Step 2: Run prisma push to materialize the table**

Run: `npm run db:push`
Expected: `🚀 Your database is now in sync with your Prisma schema.` and `Generated Prisma Client`. No data loss prompt (additive change).

- [ ] **Step 3: Verify table exists via Prisma Studio or SQLite CLI**

Run: `sqlite3 data/ao.db ".schema LogEvent"`
Expected: full `CREATE TABLE "LogEvent" (...)` with the index lines.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(schema): add LogEvent table for unified logging" -- prisma/schema.prisma
```

---

### Task 2: Implement `server/log/price-table.ts` + `cost.ts`

**Files:**
- Create: `server/log/price-table.ts`
- Create: `server/log/cost.ts`
- Create: `server/log/cost.test.ts`

- [ ] **Step 1: Write `server/log/cost.test.ts`** (failing test first)

```typescript
import { describe, it, expect } from 'vitest';
import { computeCost } from './cost';

describe('computeCost', () => {
  it('returns null for unknown model', () => {
    expect(computeCost('mystery-model', { prompt_tokens: 100, completion_tokens: 50 })).toBeNull();
  });

  it('returns 0 when usage is missing', () => {
    expect(computeCost('google/gemini-3-flash-preview', undefined)).toBe(0);
  });

  it('computes gemini-3-flash cost correctly', () => {
    // 1000 prompt @ $0.000075/1K + 1000 completion @ $0.00030/1K = $0.000075 + $0.000300 = $0.000375
    const cost = computeCost('google/gemini-3-flash-preview', {
      prompt_tokens: 1000,
      completion_tokens: 1000,
    });
    expect(cost).toBeCloseTo(0.000375, 6);
  });

  it('computes gpt-4o cost correctly', () => {
    // 1000 prompt @ $0.0025/1K + 1000 completion @ $0.01/1K = $0.0025 + $0.01 = $0.0125
    const cost = computeCost('openai/gpt-4o', {
      prompt_tokens: 1000,
      completion_tokens: 1000,
    });
    expect(cost).toBeCloseTo(0.0125, 6);
  });

  it('handles missing completion_tokens', () => {
    const cost = computeCost('openai/gpt-4o-mini', { prompt_tokens: 2000 });
    // 2000 @ $0.00015/1K = $0.0003, completion=0
    expect(cost).toBeCloseTo(0.0003, 6);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run server/log/cost.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/log/price-table.ts`**

```typescript
// LLM model prices in USD per 1K tokens.
// Add new models here; unlisted models → cost=null (UI shows "—").
export type ModelPrice = { prompt: number; completion: number };

export const PRICE_TABLE: Record<string, ModelPrice> = {
  'google/gemini-3-flash-preview': { prompt: 0.000075, completion: 0.00030 },
  'openai/gpt-4o-mini':            { prompt: 0.000150, completion: 0.00060 },
  'openai/gpt-4o':                 { prompt: 0.00250,  completion: 0.01000 },
  'anthropic/claude-opus-4-7':     { prompt: 0.01500,  completion: 0.07500 },
  'anthropic/claude-sonnet-4-6':   { prompt: 0.00300,  completion: 0.01500 },
};
```

- [ ] **Step 4: Write `server/log/cost.ts`**

```typescript
import { PRICE_TABLE } from './price-table';

export type LlmUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

/**
 * Compute USD cost for an LLM call.
 * Returns null when the model is not in PRICE_TABLE; 0 when usage absent.
 */
export function computeCost(model: string, usage: LlmUsage | undefined): number | null {
  const price = PRICE_TABLE[model];
  if (!price) return null;
  if (!usage) return 0;
  const p = (usage.prompt_tokens ?? 0) / 1000;
  const c = (usage.completion_tokens ?? 0) / 1000;
  return p * price.prompt + c * price.completion;
}
```

- [ ] **Step 5: Run test, expect pass**

Run: `npx vitest run server/log/cost.test.ts`
Expected: PASS — 5 passed.

- [ ] **Step 6: Commit**

```bash
git add server/log/price-table.ts server/log/cost.ts server/log/cost.test.ts
git commit -m "feat(log): LLM price table + computeCost helper" -- server/log/price-table.ts server/log/cost.ts server/log/cost.test.ts
```

---

### Task 3: Implement `server/log/traceable.ts`

**Files:**
- Create: `server/log/traceable.ts`

(Pure helper — no separate test file; will be exercised by logger tests in Task 4.)

- [ ] **Step 1: Write `server/log/traceable.ts`**

```typescript
// "Traceable" = a LogEvent row has at least one of runId, traceId, or
// eventInstanceId. Per spec §2 / §5.8, this is the contract that makes
// audit logs reverse-lookupable. We don't crash on violation — we warn
// (so untraced rows still land, but are flagged).

export type TraceableCtx = {
  runId?: string | null;
  traceId?: string | null;
  eventInstanceId?: string | null;
};

export function isTraceable(ctx: TraceableCtx): boolean {
  return !!(ctx.runId || ctx.traceId || ctx.eventInstanceId);
}

/**
 * Returns { level, messagePrefix } adjustment for a write call.
 * - Traceable → no change ({ levelOverride: null, messagePrefix: '' })
 * - Untraceable → ({ levelOverride: 'warn', messagePrefix: '[untraceable] ' })
 *   and emits a one-line console.warn so dev can spot the leak.
 */
export function untraceable(ctx: TraceableCtx, kind: string, agent?: string | null): {
  levelOverride: 'warn' | null;
  messagePrefix: string;
} {
  if (isTraceable(ctx)) return { levelOverride: null, messagePrefix: '' };
  // eslint-disable-next-line no-console
  console.warn(`[logger] untraceable write from ${agent ?? '<no-agent>'}/${kind}`);
  return { levelOverride: 'warn', messagePrefix: '[untraceable] ' };
}
```

- [ ] **Step 2: Commit**

```bash
git add server/log/traceable.ts
git commit -m "feat(log): traceable guard for LogEvent writes" -- server/log/traceable.ts
```

---

### Task 4: Implement `server/log/logger.ts` (core)

This is the **central file**. It exports `createAgentLogger`, `runWithLogger`, `currentLogger`, `createNullLogger` — the same API surface as both old loggers (so shims work), plus new typed methods.

**Files:**
- Create: `server/log/logger.ts`
- Create: `server/log/logger.test.ts`

- [ ] **Step 1: Write `server/log/logger.test.ts`** — covers the contract, not implementation details. Failing first.

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/server/db';
import {
  createAgentLogger,
  runWithLogger,
  currentLogger,
  createNullLogger,
} from './logger';

describe('logger', () => {
  beforeEach(async () => {
    await prisma.logEvent.deleteMany({});
  });

  it('createNullLogger returns a no-op logger that does not write', async () => {
    const log = createNullLogger();
    log.event('foo', { x: 1 });
    log.apiCall('test', { url: 'http://x', method: 'GET', status: 200 });
    // small delay so any async write would land
    await new Promise(r => setTimeout(r, 50));
    const rows = await prisma.logEvent.findMany({});
    expect(rows).toHaveLength(0);
  });

  it('writes a LogEvent row with traceable ctx', async () => {
    const log = createAgentLogger({
      agent: 'matchResume',
      runId: 'run-1',
      traceId: 'trace-1',
      eventName: 'MATCH_RULE_CHECK_PASSED',
      anchors: { candidate_id: 'c-1' },
    });
    log.event('test.event', { foo: 'bar' });
    await new Promise(r => setTimeout(r, 100));
    const rows = await prisma.logEvent.findMany({ where: { agent: 'matchResume' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: 'matchResume',
      runId: 'run-1',
      traceId: 'trace-1',
      eventName: 'MATCH_RULE_CHECK_PASSED',
      category: 'agent_lifecycle',
      level: 'info',
      message: 'test.event',
    });
    expect(JSON.parse(rows[0].anchorsJson!)).toEqual({ candidate_id: 'c-1' });
    expect(JSON.parse(rows[0].payloadJson!)).toEqual({ foo: 'bar' });
  });

  it('flags untraceable writes with level=warn and [untraceable] prefix', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createAgentLogger({ agent: 'ghost' }); // no run/trace/event id
    log.event('orphan.write', { x: 1 });
    await new Promise(r => setTimeout(r, 100));
    const rows = await prisma.logEvent.findMany({ where: { agent: 'ghost' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe('warn');
    expect(rows[0].message).toMatch(/^\[untraceable\] /);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('untraceable write from ghost/orphan.write'));
    warnSpy.mockRestore();
  });

  it('llmCall writes category=llm_call with cost from price table', async () => {
    const log = createAgentLogger({ agent: 'jd', runId: 'r-2' });
    log.llmCall({
      model: 'google/gemini-3-flash-preview',
      toolName: 'LLM.generateJD',
      promptMessages: [{ role: 'user', content: 'hi' }],
      responseText: 'hello',
      usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
      durationMs: 200,
      finishReason: 'stop',
    });
    await new Promise(r => setTimeout(r, 100));
    const rows = await prisma.logEvent.findMany({ where: { runId: 'r-2' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'llm_call',
      llmModel: 'google/gemini-3-flash-preview',
      llmPromptTokens: 1000,
      llmCompletionTokens: 1000,
      llmTotalTokens: 2000,
      llmFinishReason: 'stop',
      durationMs: 200,
    });
    expect(rows[0].llmCostUsd).toBeCloseTo(0.000375, 6);
  });

  it('apiCall writes category=api_call', async () => {
    const log = createAgentLogger({ agent: 'jd', runId: 'r-3' });
    log.apiCall('robohire.generate', {
      url: 'http://robohire/x',
      method: 'POST',
      status: 200,
      durationMs: 500,
      request: { a: 1 },
      response: { ok: true },
    });
    await new Promise(r => setTimeout(r, 100));
    const rows = await prisma.logEvent.findMany({ where: { runId: 'r-3' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('api_call');
    expect(rows[0].durationMs).toBe(500);
    expect(rows[0].status).toBe('ok');
  });

  it('currentLogger returns the logger inside runWithLogger', async () => {
    const log = createAgentLogger({ agent: 'x', runId: 'r-4' });
    expect(currentLogger()).toBeNull();
    await runWithLogger(log, async () => {
      expect(currentLogger()).toBe(log);
    });
    expect(currentLogger()).toBeNull();
  });

  it('LOG_EVENT_WRITE=0 disables DB writes', async () => {
    const old = process.env.LOG_EVENT_WRITE;
    process.env.LOG_EVENT_WRITE = '0';
    const log = createAgentLogger({ agent: 'silenced', runId: 'r-5' });
    log.event('skip.me', {});
    await new Promise(r => setTimeout(r, 100));
    const rows = await prisma.logEvent.findMany({ where: { agent: 'silenced' } });
    expect(rows).toHaveLength(0);
    process.env.LOG_EVENT_WRITE = old;
  });

  it('truncates payloads > 256 KB with marker and still computes digest from full content', async () => {
    const log = createAgentLogger({ agent: 'big', runId: 'r-6' });
    const huge = 'x'.repeat(300_000); // 300 KB
    log.event('big.payload', { blob: huge });
    await new Promise(r => setTimeout(r, 100));
    const rows = await prisma.logEvent.findMany({ where: { runId: 'r-6' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].payloadJson?.length).toBeLessThan(260_000); // truncated
    expect(rows[0].payloadJson).toContain('truncated');
    expect(rows[0].payloadDigest).toMatch(/^[a-f0-9]{16}$/);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run server/log/logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/log/logger.ts`**

```typescript
// Unified logger — single write surface for all of AO's logging.
//
// Three sinks fired in parallel per call:
//   1. LogEvent table (Prisma) — the new canonical store; fire-and-forget
//   2. logs/<agent>-<date>.log JSONL — kept for tail -f / grep workflow
//   3. Terminal ANSI echo (stdout) — dev visibility
//
// All sinks are wrapped in try/catch; a sink failure surfaces a console.warn
// but never throws into the caller (logging is non-load-bearing).
//
// Per spec §5.1.
//
// API surface mirrors lib/agent-logger.ts (file-JSONL flavor) + server/agent-logger.ts
// (AgentActivity flavor) so the two existing modules can re-export from here as shims.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { prisma } from '@/server/db';
import { computeCost, type LlmUsage } from './cost';
import { untraceable, isTraceable } from './traceable';

// ── Config ────────────────────────────────────────────────────────────
const LOG_EVENT_WRITE = () => process.env.LOG_EVENT_WRITE !== '0';
const LOG_FILE_JSONL = () => process.env.LOG_FILE_JSONL !== '0';
const TERMINAL_LOG = () => process.env.AO_TERMINAL_LOG !== '0';
const LOG_DIR = () => process.env.AO_LOG_DIR ?? path.join(process.cwd(), 'logs');
const LOG_LLM_BODIES = () => (process.env.LOG_LLM_BODIES ?? 'heads') as 'full' | 'heads' | 'none';
const PROCESS_TAG = () => process.env.AO_PROCESS_TAG ?? 'next';
const MAX_PAYLOAD_BYTES = 256 * 1024;

// ── Types ─────────────────────────────────────────────────────────────
export type AgentLoggerCtx = {
  agent?: string;
  nodeId?: string;
  runId?: string | null;
  traceId?: string | null;
  eventInstanceId?: string | null;
  eventName?: string | null;
  anchors?: Record<string, string | null | undefined>;
};

export type ApiCallInfo = {
  url: string;
  method?: string;
  request?: unknown;
  response?: unknown;
  status?: number;
  durationMs?: number;
  error?: string;
};

export type DbCallInfo = {
  query: string;
  params?: unknown;
  rows?: number;
  durationMs?: number;
  error?: string;
};

export type LlmCallInfo = {
  model: string;
  toolName: string;
  promptMessages: unknown;
  responseText: string;
  usage?: LlmUsage;
  durationMs: number;
  finishReason?: string;
  meta?: Record<string, unknown>;
};

export interface AgentLogger {
  event(kind: string, data?: unknown): void;
  step<T>(name: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T>;
  error(kind: string, err: unknown, meta?: Record<string, unknown>): void;
  apiCall(label: string, info: ApiCallInfo): void;
  dbCall(label: string, info: DbCallInfo): void;
  llmCall(info: LlmCallInfo): void;
  manageAction(action: string, data: unknown): void;
  emPublish(eventName: string, data: unknown): void;
  child(extra: Partial<AgentLoggerCtx>): AgentLogger;
  currentLogFile(): string;
  readonly ctx: Readonly<AgentLoggerCtx>;
}

// ── Helpers ───────────────────────────────────────────────────────────
function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, jsonReplacer) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}

function maybeTruncate(jsonStr: string): { stored: string; digest: string } {
  const digest = createHash('sha256').update(jsonStr).digest('hex').slice(0, 16);
  if (jsonStr.length <= MAX_PAYLOAD_BYTES) return { stored: jsonStr, digest };
  const head = jsonStr.slice(0, MAX_PAYLOAD_BYTES);
  return {
    stored: `${head}… +${jsonStr.length - MAX_PAYLOAD_BYTES} bytes truncated`,
    digest,
  };
}

function trimLlmBodies(promptMessages: unknown, responseText: string): {
  prompt: unknown;
  response: string;
} {
  const mode = LOG_LLM_BODIES();
  if (mode === 'full') return { prompt: promptMessages, response: responseText };
  if (mode === 'none') return { prompt: '[omitted]', response: '[omitted]' };
  // heads
  const promptStr = safeJson(promptMessages);
  const promptHead = promptStr.length > 500 ? `${promptStr.slice(0, 500)}… +${promptStr.length - 500} chars truncated` : promptStr;
  const respHead = responseText.length > 500 ? `${responseText.slice(0, 500)}… +${responseText.length - 500} chars truncated` : responseText;
  return { prompt: promptHead, response: respHead };
}

// ── Terminal echo (compact one-liner) ─────────────────────────────────
const ANSI = {
  reset: '\x1b[0m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m',
};
function colorForLevel(level: string): string {
  if (level === 'error' || level === 'critical') return ANSI.red;
  if (level === 'warn') return ANSI.yellow;
  if (level === 'notice') return ANSI.magenta;
  if (level === 'debug') return ANSI.dim;
  return ANSI.cyan;
}
function echoTerminal(level: string, agent: string | undefined, kind: string, payloadStr: string): void {
  if (!TERMINAL_LOG()) return;
  const color = colorForLevel(level);
  const tag = `${color}[${agent ?? '?'}/${kind}]${ANSI.reset}`;
  const compact = payloadStr.length > 240 ? `${payloadStr.slice(0, 240)}…` : payloadStr;
  // eslint-disable-next-line no-console
  console.log(`${tag} ${ANSI.dim}${compact}${ANSI.reset}`);
}

// ── File JSONL sink ───────────────────────────────────────────────────
let fileChain: Promise<void> = Promise.resolve();
let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirReady) dirReady = fs.mkdir(LOG_DIR(), { recursive: true }).then(() => undefined);
  return dirReady;
}
function appendJsonl(agent: string | undefined, row: object): void {
  if (!LOG_FILE_JSONL()) return;
  const file = path.join(LOG_DIR(), `${agent ?? 'system'}-${todayStamp()}.log`);
  const line = JSON.stringify(row, jsonReplacer) + '\n';
  fileChain = fileChain
    .then(() => ensureDir())
    .then(() => fs.appendFile(file, line, 'utf8'))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[logger:file] write failed: ${(err as Error).message}`);
    });
}

// ── DB sink ───────────────────────────────────────────────────────────
type LogWrite = {
  level: string; category: string; source: string;
  ctx: AgentLoggerCtx;
  message: string;
  payload?: unknown;
  durationMs?: number;
  status?: string;
  llm?: {
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: number | null;
    finishReason?: string;
  };
};

function writeDb(w: LogWrite): void {
  if (!LOG_EVENT_WRITE()) return;
  const payloadStr = w.payload === undefined ? null : safeJson(w.payload);
  const { stored, digest } = payloadStr ? maybeTruncate(payloadStr) : { stored: null as string | null, digest: null as string | null };
  const guard = untraceable(w.ctx, w.message.split('|')[0] ?? w.message, w.ctx.agent ?? null);
  const finalLevel = guard.levelOverride ?? w.level;
  const finalMessage = `${guard.messagePrefix}${w.message}`.slice(0, 240);

  prisma.logEvent.create({
    data: {
      level: finalLevel,
      category: w.category,
      source: w.ctx.eventName?.startsWith('manage.') ? 'manage' : (w.source || 'system'),
      process: PROCESS_TAG(),
      agent: w.ctx.agent ?? null,
      runId: w.ctx.runId ?? null,
      traceId: w.ctx.traceId ?? null,
      eventInstanceId: w.ctx.eventInstanceId ?? null,
      eventName: w.ctx.eventName ?? null,
      anchorsJson: w.ctx.anchors && Object.keys(w.ctx.anchors).length ? safeJson(w.ctx.anchors) : null,
      message: finalMessage,
      payloadJson: stored,
      payloadDigest: digest,
      durationMs: w.durationMs ?? null,
      status: w.status ?? null,
      llmModel: w.llm?.model ?? null,
      llmPromptTokens: w.llm?.promptTokens ?? null,
      llmCompletionTokens: w.llm?.completionTokens ?? null,
      llmTotalTokens: w.llm?.totalTokens ?? null,
      llmCostUsd: w.llm?.costUsd ?? null,
      llmFinishReason: w.llm?.finishReason ?? null,
    },
  }).catch((err: Error) => {
    // eslint-disable-next-line no-console
    console.warn(`[logger:db] insert failed (${w.message}): ${err.message}`);
  });
}

// ── ALS context ───────────────────────────────────────────────────────
const loggerStorage = new AsyncLocalStorage<AgentLogger>();

export function runWithLogger<T>(logger: AgentLogger, fn: () => Promise<T> | T): Promise<T> | T {
  return loggerStorage.run(logger, fn);
}
export function currentLogger(): AgentLogger | null {
  return loggerStorage.getStore() ?? null;
}

// ── Null logger ───────────────────────────────────────────────────────
export function createNullLogger(): AgentLogger {
  const ctx: AgentLoggerCtx = {};
  return {
    ctx,
    async step<T>(_name: string, fn: () => Promise<T>): Promise<T> { return fn(); },
    event() {}, error() {}, apiCall() {}, dbCall() {}, llmCall() {},
    manageAction() {}, emPublish() {},
    child() { return createNullLogger(); },
    currentLogFile() { return ''; },
  };
}

// ── Factory ───────────────────────────────────────────────────────────
export function createAgentLogger(ctx: AgentLoggerCtx): AgentLogger {
  const bound: AgentLoggerCtx = { ...ctx };
  const file = path.join(LOG_DIR(), `${bound.agent ?? 'system'}-${todayStamp()}.log`);

  function fanOut(level: string, category: string, kind: string, payload: unknown, extra?: Partial<LogWrite>): void {
    const payloadStr = safeJson(payload);
    appendJsonl(bound.agent, {
      ts: new Date().toISOString(),
      agent: bound.agent,
      run_id: bound.runId ?? null,
      trace_id: bound.traceId ?? null,
      event_instance_id: bound.eventInstanceId ?? null,
      event_name: bound.eventName ?? null,
      anchors: bound.anchors ?? undefined,
      level, category, kind, payload,
    });
    echoTerminal(level, bound.agent, kind, payloadStr);
    writeDb({
      level, category, source: extra?.source ?? 'ws',
      ctx: bound, message: kind, payload,
      durationMs: extra?.durationMs, status: extra?.status, llm: extra?.llm,
    });
  }

  const logger: AgentLogger = {
    ctx: bound,
    async step<T>(name, fn, meta) {
      const start = Date.now();
      fanOut('info', 'agent_step', `step.start|${name}`, { step: name, meta });
      try {
        const out = await fn();
        fanOut('info', 'agent_step', `step.end|${name}`, { step: name, duration_ms: Date.now() - start }, {
          durationMs: Date.now() - start, status: 'ok',
        });
        return out;
      } catch (e) {
        fanOut('error', 'agent_step', `step.error|${name}`, {
          step: name, duration_ms: Date.now() - start,
          error: (e as Error).message, stack: (e as Error).stack?.split('\n').slice(0, 6).join('\n'),
        }, { durationMs: Date.now() - start, status: 'err' });
        throw e;
      }
    },
    event(kind, data) {
      fanOut('info', 'agent_lifecycle', kind, data);
    },
    error(kind, err, meta) {
      fanOut('error', 'agent_lifecycle', kind, {
        ...(meta ?? {}),
        error: (err as Error)?.message ?? String(err),
        stack: (err as Error)?.stack?.split('\n').slice(0, 6).join('\n'),
      }, { status: 'err' });
    },
    apiCall(label, info) {
      const level = info.error ? 'error' : 'info';
      fanOut(level, 'api_call', `api.${label}`, info, {
        durationMs: info.durationMs, status: info.error ? 'err' : 'ok',
      });
    },
    dbCall(label, info) {
      const level = info.error ? 'error' : 'info';
      fanOut(level, 'db_call', `db.${label}`, info, {
        durationMs: info.durationMs, status: info.error ? 'err' : 'ok',
      });
    },
    llmCall(info) {
      const trimmed = trimLlmBodies(info.promptMessages, info.responseText);
      const costUsd = computeCost(info.model, info.usage);
      fanOut('info', 'llm_call', `llm.${info.toolName}`, {
        model: info.model,
        prompt: trimmed.prompt,
        response: trimmed.response,
        usage: info.usage,
        finishReason: info.finishReason,
        meta: info.meta,
      }, {
        durationMs: info.durationMs, status: 'ok',
        llm: {
          model: info.model,
          promptTokens: info.usage?.prompt_tokens,
          completionTokens: info.usage?.completion_tokens,
          totalTokens: info.usage?.total_tokens,
          costUsd,
          finishReason: info.finishReason,
        },
      });
    },
    manageAction(action, data) {
      fanOut('notice', 'manage_action', action, data, { source: 'manage' });
    },
    emPublish(eventName, data) {
      fanOut('info', 'event_publish', `em.publish|${eventName}`, data, { source: 'em' });
    },
    child(extra) {
      return createAgentLogger({ ...bound, ...extra, anchors: { ...(bound.anchors ?? {}), ...(extra.anchors ?? {}) } });
    },
    currentLogFile() { return file; },
  };
  return logger;
}

// Re-export for shims
export { isTraceable };
```

- [ ] **Step 4: Run test, expect pass**

Run: `npx vitest run server/log/logger.test.ts`
Expected: PASS — 8 passed. If any DB-write race fails intermittently, increase the `setTimeout` in the failing test from 100→200ms (Prisma sqlite is fast but the `.catch` chain is async).

- [ ] **Step 5: Commit**

```bash
git add server/log/logger.ts server/log/logger.test.ts
git commit -m "feat(log): unified server/log/logger.ts with 3 sinks" -- server/log/logger.ts server/log/logger.test.ts
```

---

### Task 5: Convert old loggers to re-export shims

The two existing `createAgentLogger`s are now duplicates of the new logger's API. Replace their bodies with re-exports so call-sites in agents / cross-cutting clients keep working unchanged.

**Files:**
- Modify: `lib/agent-logger.ts` (lines 1-300, full rewrite)
- Modify: `server/agent-logger.ts` (replace logger fns; keep `ensureWorkflowRun` and `markRunComplete`)

- [ ] **Step 1: Rewrite `lib/agent-logger.ts`** to a shim:

```typescript
// Shim — delegates to server/log/logger.ts.
//
// Pre-2026-05-22 this file held a file-JSONL flavored logger. Spec
// 2026-05-22 (unified-logging-audit-design.md) consolidated it into
// server/log/logger.ts. This shim keeps existing imports working.
//
// Old API kept verbatim:
//   - createAgentLogger({ agent, runId, traceId, anchors })
//   - runWithLogger(logger, fn)
//   - currentLogger()
//   - createNullLogger()
//   - AgentLogger / AgentLoggerCtx types

export {
  createAgentLogger,
  runWithLogger,
  currentLogger,
  createNullLogger,
} from '@/server/log/logger';

export type {
  AgentLogger,
  AgentLoggerCtx,
  ApiCallInfo,
  DbCallInfo,
  LlmCallInfo,
} from '@/server/log/logger';
```

- [ ] **Step 2: Rewrite `server/agent-logger.ts`** — keep the workflow-run lifecycle fns, re-export logger:

```typescript
// Shim for logger functions; the WorkflowRun lifecycle helpers
// (ensureWorkflowRun, markRunComplete) remain here as their natural home.
//
// Pre-2026-05-22 this file held an AgentActivity-flavored logger. Spec
// 2026-05-22 (unified-logging-audit-design.md) consolidated it into
// server/log/logger.ts.

import { prisma } from './db';

export {
  createAgentLogger,
  runWithLogger,
  currentLogger,
  createNullLogger,
} from '@/server/log/logger';

export type {
  AgentLogger,
  AgentLoggerCtx,
} from '@/server/log/logger';

// LoggerLike — minimal shape used by chatComplete instrumentation hooks.
export type LoggerLike = {
  tool?(narrative: string, metadata?: Record<string, unknown>): Promise<void>;
  anomaly?(narrative: string, metadata?: Record<string, unknown>): Promise<void>;
};

// ── WorkflowRun lifecycle (kept here per pre-existing pattern) ──────

export type RunLifecycleInput = {
  runId: string;
  triggerEvent: string;
  triggerData?: { client?: string; jdId?: string } | Record<string, unknown>;
};

export async function ensureWorkflowRun(opts: RunLifecycleInput): Promise<void> {
  try {
    await prisma.workflowRun.upsert({
      where: { id: opts.runId },
      create: {
        id: opts.runId,
        triggerEvent: opts.triggerEvent,
        triggerData: JSON.stringify(opts.triggerData ?? {}),
        status: 'running',
      },
      update: { lastActivityAt: new Date() },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[ensureWorkflowRun] failed for run ${opts.runId}: ${(e as Error).message}`);
  }
}

export async function markRunComplete(
  runId: string,
  status: 'completed' | 'failed' | 'suspended' = 'completed',
  reason?: string,
): Promise<void> {
  try {
    await prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status,
        completedAt: status === 'completed' || status === 'failed' ? new Date() : null,
        suspendedReason: status === 'suspended' ? (reason ?? null) : null,
        lastActivityAt: new Date(),
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[markRunComplete] failed for run ${runId}: ${(e as Error).message}`);
  }
}
```

⚠️ **IMPORTANT**: The old `server/agent-logger.ts` had `AgentLogger.log/event/tool/decision/anomaly/error/hitl/done` methods that wrote to `AgentActivity`. The new logger doesn't have these — it writes to `LogEvent`. **However**, several agents and tests call those methods. To preserve behavior we need a temporary back-compat layer that ALSO writes AgentActivity rows.

- [ ] **Step 3: Add back-compat methods to `server/log/logger.ts`** — append these methods to the `AgentLogger` interface and the factory's returned object so old call-sites stay working AND dual-write to AgentActivity.

Edit `server/log/logger.ts`:

```typescript
// Add to AgentLogger interface (before child/currentLogFile):
  /** @deprecated — kept for back-compat. Use event/error/apiCall instead. */
  log(type: string, narrative: string, metadata?: Record<string, unknown>): Promise<void>;
  /** @deprecated */
  tool(narrative: string, metadata?: Record<string, unknown>): Promise<void>;
  /** @deprecated */
  decision(narrative: string, metadata?: Record<string, unknown>): Promise<void>;
  /** @deprecated */
  anomaly(narrative: string, metadata?: Record<string, unknown>): Promise<void>;
  /** @deprecated — use error(kind, err) */
  done(narrative: string, metadata?: Record<string, unknown>): Promise<void>;
  /** @deprecated */
  hitl(narrative: string, metadata?: Record<string, unknown>): Promise<void>;
```

And in the factory implementation, add:

```typescript
    // ── Back-compat (writes both AgentActivity AND LogEvent) ──
    async log(type, narrative, metadata) {
      await writeAgentActivity(bound, type, narrative, metadata);
      fanOut('info', mapTypeToCategory(type), `${type}|${narrative.slice(0, 80)}`, { narrative, metadata });
    },
    async tool(narrative, metadata) { return this.log('tool', narrative, metadata); },
    async decision(narrative, metadata) { return this.log('decision', narrative, metadata); },
    async anomaly(narrative, metadata) { return this.log('anomaly', narrative, metadata); },
    async done(narrative, metadata) { return this.log('agent_complete', narrative, metadata); },
    async hitl(narrative, metadata) { return this.log('hitl', narrative, metadata); },
```

And add helpers at the bottom of the file:

```typescript
function mapTypeToCategory(type: string): string {
  if (type === 'tool') return 'tool_call';
  if (type === 'anomaly' || type === 'agent_error') return 'agent_lifecycle';
  if (type === 'hitl') return 'agent_lifecycle';
  if (type.startsWith('step.')) return 'agent_step';
  return 'agent_lifecycle';
}

import { byWsId } from '@/lib/agent-mapping'; // (move to top of file)

async function writeAgentActivity(
  ctx: AgentLoggerCtx,
  type: string,
  narrative: string,
  metadata: Record<string, unknown> | undefined,
): Promise<void> {
  try {
    const canonical = (ctx.nodeId && byWsId(ctx.nodeId)?.short) ?? ctx.agent ?? 'system';
    await prisma.agentActivity.create({
      data: {
        runId: ctx.runId ?? null,
        nodeId: ctx.nodeId ?? ctx.agent ?? 'system',
        agentName: canonical,
        type, narrative,
        metadata: metadata ? safeJson(metadata) : null,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[logger:agentActivity] failed (${type}): ${(e as Error).message}`);
  }
}
```

- [ ] **Step 4: Run the full test suite to ensure no regressions**

Run: `npm test`
Expected: all existing tests pass (especially `lib/allmeta-client.test.ts`, `lib/agent-mapping.test.ts`, `server/inngest/agents/*.test.ts`, `app/api/runs/[id]/route.test.ts`).
If failures: most likely a stale import of `createAgentLogger` from a deleted symbol — re-add it to the shim and re-run.

- [ ] **Step 5: Smoke-test runtime — start dev server and trigger one agent**

Run (in one terminal): `npm run dev`
Then publish a test event:

```bash
curl -X POST http://localhost:3002/api/inngest-events \
  -H 'Content-Type: application/json' \
  -d '{"name":"SCHEDULED_SYNC","data":{"client_rms_system_id":"test"}}'
```

Then check both old and new rows landed:

```bash
sqlite3 data/ao.db "SELECT COUNT(*) FROM AgentActivity WHERE createdAt > datetime('now','-1 minute');"
sqlite3 data/ao.db "SELECT COUNT(*) FROM LogEvent WHERE ts > datetime('now','-1 minute');"
```

Expected: both > 0. If LogEvent is 0 → check `LOG_EVENT_WRITE` env (must not be `0`).

- [ ] **Step 6: Commit**

```bash
git add lib/agent-logger.ts server/agent-logger.ts server/log/logger.ts
git commit -m "refactor(log): old loggers become shims over server/log/logger" -- lib/agent-logger.ts server/agent-logger.ts server/log/logger.ts
```

---

## Chunk 2 — Dual-write integration (P0b)

Wires EM publish, Manage actions, and LLM gateway into the new logger. Existing call-sites use `currentLogger()` (ALS), so most wiring is at the *cross-cutting* layer.

### Task 6: EM publish dual-write

**Files:**
- Modify: `server/em/persistence.ts:108-135` (the `writeAudit` fn)
- Modify: `server/em/persistence.test.ts` (if exists; otherwise extend `server/em/publish.test.ts`)

- [ ] **Step 1: Extend `server/em/publish.test.ts`** with a new assertion:

```typescript
it('writes both AuditLog and LogEvent for each publish', async () => {
  await prisma.auditLog.deleteMany({});
  await prisma.logEvent.deleteMany({});

  await em.publish('TEST_EVENT', { foo: 'bar' }, {
    source: 'ws',
    traceId: 'trace-em-1',
  });

  await new Promise(r => setTimeout(r, 100));

  const audits = await prisma.auditLog.findMany({ where: { traceId: 'trace-em-1' } });
  const logs = await prisma.logEvent.findMany({ where: { traceId: 'trace-em-1' } });
  expect(audits).toHaveLength(1);
  expect(logs).toHaveLength(1);
  expect(logs[0].category).toBe('event_publish');
  expect(logs[0].source).toBe('em');
  expect(logs[0].eventName).toBe('TEST_EVENT');
  expect(logs[0].payloadDigest).toBe(audits[0].payloadDigest);
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run server/em/publish.test.ts`
Expected: FAIL — no LogEvent row.

- [ ] **Step 3: Modify `server/em/persistence.ts::writeAudit`**:

```typescript
import { currentLogger, createAgentLogger } from '@/server/log/logger';

export async function writeAudit(input: {
  eventName: string;
  traceId: string;
  source: string;
  payload: unknown;
}): Promise<void> {
  const payloadJson = safeJson(input.payload);
  const digest = createHash("sha256").update(payloadJson).digest("hex").slice(0, 32);
  await prisma.auditLog.create({
    data: {
      eventName: input.eventName,
      traceId: input.traceId,
      payload: payloadJson,
      payloadDigest: digest,
      source: input.source,
    },
  });

  // Dual-write to LogEvent (spec 2026-05-22 §5.5)
  const log = currentLogger() ?? createAgentLogger({
    agent: 'em',
    traceId: input.traceId,
    eventName: input.eventName,
  });
  log.emPublish(input.eventName, {
    source: input.source,
    payloadDigest: digest,
    payload: input.payload,
  });
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npx vitest run server/em/publish.test.ts`
Expected: PASS — all tests (existing + new).

- [ ] **Step 5: Commit**

```bash
git add server/em/persistence.ts server/em/publish.test.ts
git commit -m "feat(em): dual-write LogEvent on em.publish" -- server/em/persistence.ts server/em/publish.test.ts
```

---

### Task 7: Manage action dual-write

**Files:**
- Modify: `lib/manage/audit.ts`
- Create or extend: `lib/manage/audit.test.ts`

- [ ] **Step 1: Read current `lib/manage/audit.ts`** to find the `writeManageAudit` function.

Run: `cat lib/manage/audit.ts`

- [ ] **Step 2: Write the failing test** in `lib/manage/audit.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { writeManageAudit } from './audit';

describe('writeManageAudit dual-write', () => {
  beforeEach(async () => {
    await prisma.auditLog.deleteMany({});
    await prisma.logEvent.deleteMany({});
  });

  it('writes both AuditLog (action=manage.*) and LogEvent (category=manage_action)', async () => {
    await writeManageAudit({
      action: 'manage.run.pause',
      traceId: 'run-xyz',
      payload: { reason: 'user pressed pause' },
      actor: 'steven',
    });
    await new Promise(r => setTimeout(r, 100));
    const audits = await prisma.auditLog.findMany({ where: { traceId: 'run-xyz' } });
    const logs = await prisma.logEvent.findMany({ where: { traceId: 'run-xyz' } });
    expect(audits).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0].category).toBe('manage_action');
    expect(logs[0].source).toBe('manage');
    expect(logs[0].message).toContain('manage.run.pause');
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `npx vitest run lib/manage/audit.test.ts`
Expected: FAIL — LogEvent row missing.

- [ ] **Step 4: Modify `lib/manage/audit.ts::writeManageAudit`** — add the dual-write:

```typescript
// after the existing prisma.auditLog.create(...)
const log = currentLogger() ?? createAgentLogger({
  agent: 'manage',
  traceId: input.traceId,
  eventName: input.action,
});
log.manageAction(input.action, {
  actor: input.actor,
  payload: input.payload,
});
```

Add the imports at top:

```typescript
import { currentLogger, createAgentLogger } from '@/server/log/logger';
```

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run lib/manage/audit.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full test suite to confirm no regressions in `app/api/manage/**`**

Run: `npm test -- app/api/manage`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/manage/audit.ts lib/manage/audit.test.ts
git commit -m "feat(manage): dual-write LogEvent on writeManageAudit" -- lib/manage/audit.ts lib/manage/audit.test.ts
```

---

### Task 8: LLM gateway captures prompt/response/cost

**Files:**
- Modify: `server/llm/gateway.ts:200-280` (the `chatComplete` fn, after the completion call)
- Modify: `server/llm/gateway.test.ts`

- [ ] **Step 1: Read `server/llm/gateway.ts::chatComplete`** to find where `completion` is returned and `usage` is unpacked.

Run: `grep -n "completion.usage\|lastUsage" server/llm/gateway.ts`

- [ ] **Step 2: Extend `server/llm/gateway.test.ts`** with:

```typescript
import { runWithLogger, createAgentLogger } from '@/server/log/logger';
import { prisma } from '@/server/db';

it('writes a llm_call LogEvent when called inside runWithLogger', async () => {
  await prisma.logEvent.deleteMany({ where: { category: 'llm_call' } });
  const log = createAgentLogger({ agent: 'jd', runId: 'r-llm-1', traceId: 't-llm-1' });

  // gateway.test.ts already mocks the openai client — reuse that setup.
  // mock to return a fake completion with usage:
  mockChatCreate.mockResolvedValue({
    choices: [{ message: { content: 'fake response' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });

  await runWithLogger(log, async () => {
    await chatComplete({
      messages: [{ role: 'user', content: 'hi' }],
      toolName: 'TestCall',
    });
  });

  await new Promise(r => setTimeout(r, 100));
  const rows = await prisma.logEvent.findMany({ where: { runId: 'r-llm-1', category: 'llm_call' } });
  expect(rows).toHaveLength(1);
  expect(rows[0].llmPromptTokens).toBe(100);
  expect(rows[0].llmCompletionTokens).toBe(50);
  expect(rows[0].llmTotalTokens).toBe(150);
  expect(rows[0].llmFinishReason).toBe('stop');
});
```

(If `mockChatCreate` setup differs from current file — read the current test first and adapt the mock pattern.)

- [ ] **Step 3: Run, expect failure**

Run: `npx vitest run server/llm/gateway.test.ts`
Expected: FAIL — no llm_call row.

- [ ] **Step 4: Modify `server/llm/gateway.ts::chatComplete`** — after the final `completion` is built and before `return`:

```typescript
import { currentLogger } from '@/server/log/logger';

// (inside chatComplete, after lastUsage / finishReason / text are known and durationMs computed)
const log = currentLogger();
if (log) {
  log.llmCall({
    model: gateway.model,
    toolName: opts.toolName ?? 'chat',
    promptMessages: opts.messages,
    responseText: text,
    usage: lastUsage,
    durationMs,
    finishReason,
  });
}
```

(`opts.toolName` will need adding to the chatComplete options shape; default `'chat'` if absent.)

Look for the existing `ChatCompleteResult` type at `server/llm/gateway.ts:55` and the `chatComplete` signature — add `toolName?: string` to its `opts` type.

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run server/llm/gateway.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify withLlmTelemetry callers (jd-generator, robohire-shape) also produce llm_call rows** — they call into `chatComplete` indirectly. Read briefly:

Run: `grep -n "chatComplete\|client.chat.completions" server/llm/jd-generator.ts server/llm/robohire-shape.ts`

If those call `client.chat.completions.create` DIRECTLY (bypassing `chatComplete`), they also need `currentLogger()?.llmCall(...)` calls. Add them at the point of the existing `withLlmTelemetry` block (just inside the `try` after `completion` is awaited).

For each direct-call site, add:

```typescript
const log = currentLogger();
if (log) {
  log.llmCall({
    model: gateway.model,
    toolName: '<NAME from existing withLlmTelemetry call>',
    promptMessages: messagesPassedToCreate,
    responseText: completion.choices[0]?.message?.content ?? '',
    usage: completion.usage,
    durationMs: Date.now() - t0,
    finishReason: completion.choices[0]?.finish_reason,
  });
}
```

- [ ] **Step 7: Commit**

```bash
git add server/llm/gateway.ts server/llm/gateway.test.ts server/llm/jd-generator.ts server/llm/robohire-shape.ts
git commit -m "feat(llm): capture prompt/response/usage/cost into LogEvent" -- server/llm/gateway.ts server/llm/gateway.test.ts server/llm/jd-generator.ts server/llm/robohire-shape.ts
```

---

## Chunk 3 — Coverage via wrapInngestHandler (P1)

Guarantees `handler.start/end/error` are written for every Inngest function with one line of change per agent.

### Task 9: Implement `wrapInngestHandler`

**Files:**
- Create: `server/inngest/wrap-handler.ts`
- Create: `server/inngest/wrap-handler.test.ts`

- [ ] **Step 1: Write `server/inngest/wrap-handler.test.ts`**:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { wrapInngestHandler } from './wrap-handler';

describe('wrapInngestHandler', () => {
  beforeEach(async () => {
    await prisma.logEvent.deleteMany({});
  });

  it('writes handler.start + handler.end for a successful run', async () => {
    const handler = wrapInngestHandler(
      { agent: 'testAgent', nodeId: '99' },
      async (ctx, log) => {
        log.event('did.work', { x: 1 });
        return { ok: true };
      },
    );

    const result = await handler({
      event: { name: 'TEST_EVENT', data: { _runId: 'r-wrap-1', candidate_id: 'c1' } },
      runId: 'inngest-run-1',
    } as any);

    expect(result).toEqual({ ok: true });
    await new Promise(r => setTimeout(r, 100));
    const rows = await prisma.logEvent.findMany({ where: { agent: 'testAgent' }, orderBy: { ts: 'asc' } });
    const messages = rows.map(r => r.message);
    expect(messages).toContain('handler.start');
    expect(messages).toContain('handler.end');
    expect(messages).toContain('did.work');
    expect(rows[0].runId).toBe('r-wrap-1');
    expect(JSON.parse(rows[0].anchorsJson!)).toMatchObject({ candidate_id: 'c1' });
  });

  it('writes handler.error and rethrows on failure', async () => {
    const handler = wrapInngestHandler(
      { agent: 'testAgent' },
      async () => { throw new Error('boom'); },
    );

    await expect(handler({
      event: { name: 'TEST_EVENT', data: { _runId: 'r-wrap-2' } },
      runId: 'inngest-run-2',
    } as any)).rejects.toThrow('boom');

    await new Promise(r => setTimeout(r, 100));
    const rows = await prisma.logEvent.findMany({ where: { agent: 'testAgent', runId: 'r-wrap-2' } });
    const messages = rows.map(r => r.message);
    expect(messages).toContain('handler.start');
    expect(messages).toContain('handler.error');
    expect(rows.find(r => r.message === 'handler.error')?.level).toBe('error');
  });

  it('propagates currentLogger to nested calls', async () => {
    const { currentLogger } = await import('@/server/log/logger');
    let captured: ReturnType<typeof currentLogger> = null;
    const handler = wrapInngestHandler(
      { agent: 'testAgent' },
      async () => {
        captured = currentLogger();
        return 'ok';
      },
    );
    await handler({
      event: { name: 'X', data: { _runId: 'r-wrap-3' } },
      runId: 'r-3',
    } as any);
    expect(captured).not.toBeNull();
    expect(captured!.ctx.agent).toBe('testAgent');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run server/inngest/wrap-handler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/inngest/wrap-handler.ts`**:

```typescript
// Wraps an Inngest handler so every invocation gets:
//   - createAgentLogger(...) bound to runId + traceId + eventInstanceId + anchors
//   - runWithLogger(...) so currentLogger() works for any nested call
//   - handler.start / handler.end / handler.error LogEvent rows
//
// Per spec 2026-05-22 §5.3.

import { createAgentLogger, runWithLogger, type AgentLogger } from '@/server/log/logger';

type InngestCtxLike = {
  event: { name: string; id?: string; data?: Record<string, unknown> };
  runId?: string;
};

export function wrapInngestHandler<R>(
  meta: { agent: string; nodeId?: string },
  handler: (ctx: InngestCtxLike & { step?: unknown; logger?: unknown }, log: AgentLogger) => Promise<R>,
) {
  return async (ctx: InngestCtxLike & { step?: unknown; logger?: unknown }): Promise<R> => {
    const eventData = (ctx.event.data ?? {}) as Record<string, unknown>;
    const runId =
      (typeof eventData._runId === 'string' && eventData._runId) ||
      (typeof ctx.runId === 'string' && ctx.runId) ||
      (typeof ctx.event.id === 'string' && ctx.event.id) ||
      null;
    const traceId =
      (typeof eventData.runtime_context === 'object' &&
        eventData.runtime_context !== null &&
        typeof (eventData.runtime_context as Record<string, unknown>).trace_id === 'string'
        ? (eventData.runtime_context as Record<string, unknown>).trace_id as string
        : null) ||
      (typeof eventData._traceId === 'string' ? eventData._traceId : null);
    const eventInstanceId =
      typeof eventData._eventInstanceId === 'string' ? eventData._eventInstanceId : null;
    const anchors = pickAnchors(eventData);

    const log = createAgentLogger({
      agent: meta.agent,
      nodeId: meta.nodeId,
      runId,
      traceId,
      eventName: ctx.event.name,
      eventInstanceId,
      anchors,
    });

    return runWithLogger(log, async () => {
      log.event('handler.start', { event: ctx.event.name });
      try {
        const out = await handler(ctx, log);
        log.event('handler.end', { ok: true });
        return out;
      } catch (e) {
        log.error('handler.error', e);
        throw e;
      }
    }) as Promise<R>;
  };
}

function pickAnchors(data: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ['candidate_id', 'job_requisition_id', 'upload_id', 'client_id', 'jdId']) {
    const v = data[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run server/inngest/wrap-handler.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/inngest/wrap-handler.ts server/inngest/wrap-handler.test.ts
git commit -m "feat(inngest): wrapInngestHandler for auto handler.* logging" -- server/inngest/wrap-handler.ts server/inngest/wrap-handler.test.ts
```

---

### Task 10: Wrap real agents (create-jd, match-resume, rule-check, resume-parser)

**Files:**
- Modify: `server/inngest/agents/create-jd-agent.ts`
- Modify: `server/inngest/agents/match-resume-agent.ts`
- Modify: `server/inngest/agents/rule-check-agent.ts`
- Modify: `server/inngest/agents/resume-parser-agent.ts`

For each file, the change is **purely additive at the handler wrapper level** — the existing handler body keeps its `fileLogger` and `runWithLogger(fileLogger, …)` block. The wrapper writes handler.start/end/error in addition to whatever the body already does. (Cleanup of the body's `runWithLogger` to use the wrapper's logger comes in P4; out of scope for this plan.)

- [ ] **Step 1: Modify `server/inngest/agents/create-jd-agent.ts`** — wrap the inngest function handler:

Find the existing pattern:
```typescript
export const createJdAgent = inngest.createFunction(
  { id: '...', triggers: [...] },
  async ({ event, step, logger, runId }) => { ... }
);
```

Change to:
```typescript
import { wrapInngestHandler } from '@/server/inngest/wrap-handler';

export const createJdAgent = inngest.createFunction(
  { id: '...', triggers: [...] },
  wrapInngestHandler({ agent: 'createJD', nodeId: '4' }, async ({ event, step, logger, runId }) => {
    // body unchanged
    ...
  })
);
```

Look up the canonical `nodeId` for each agent in `lib/agent-mapping.ts`:

| Agent file | `agent` short | `nodeId` |
|---|---|---|
| create-jd-agent | createJD | 4 |
| match-resume-agent | matchResume | 10-2 |
| rule-check-agent | ruleCheck | 10-1 |
| resume-parser-agent | resumeParser | 8 |

(Confirm these by `grep -n "wsId" lib/agent-mapping.ts` before editing — values come from `AGENT_MAP`.)

- [ ] **Step 2: Same for match-resume-agent.ts, rule-check-agent.ts, resume-parser-agent.ts**

- [ ] **Step 3: Smoke-test — publish events to each agent and check LogEvent**

Run dev server: `npm run dev`

Then publish (one per agent):

```bash
curl -X POST http://localhost:3002/api/inngest-events \
  -H 'Content-Type: application/json' \
  -d '{"name":"REQUIREMENT_LOGGED","data":{"requirement_id":"r1","client_id":"c1","_runId":"smoke-1"}}'
```

After ~5 seconds:

```bash
sqlite3 data/ao.db "SELECT agent, message FROM LogEvent WHERE runId='smoke-1' ORDER BY ts;"
```

Expected: rows starting with `handler.start`, ending with `handler.end` (or `handler.error`).

- [ ] **Step 4: Run vitest to confirm no regressions in agent tests**

Run: `npm test -- server/inngest/agents`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/inngest/agents/create-jd-agent.ts server/inngest/agents/match-resume-agent.ts server/inngest/agents/rule-check-agent.ts server/inngest/agents/resume-parser-agent.ts
git commit -m "feat(agents): wrap 4 real agents with wrapInngestHandler" -- server/inngest/agents/create-jd-agent.ts server/inngest/agents/match-resume-agent.ts server/inngest/agents/rule-check-agent.ts server/inngest/agents/resume-parser-agent.ts
```

---

### Task 11: Wrap stub-factory (covers all stub agents at once)

**Files:**
- Modify: `server/inngest/agents/stub-factory.ts:65-95` (the `inngest.createFunction` block inside `createStubAgent`)

- [ ] **Step 1: Edit `stub-factory.ts`** — wrap the inner function:

```typescript
import { wrapInngestHandler } from '@/server/inngest/wrap-handler';

// inside createStubAgent, change:
return inngest.createFunction(
  { id: fnId, name: meta.short, triggers },
  wrapInngestHandler({ agent: meta.short, nodeId: meta.wsId }, async ({ event, step }) => {
    // existing body unchanged
    ...
  })
);
```

- [ ] **Step 2: Run stub-factory tests**

Run: `npm test -- server/inngest/agents/stub-factory.test.ts`
Expected: PASS.

- [ ] **Step 3: Smoke test — trigger a stub agent**

Run dev server: `npm run dev`

```bash
curl -X POST http://localhost:3002/api/inngest-events \
  -H 'Content-Type: application/json' \
  -d '{"name":"REQUIREMENT_SYNCED","data":{"_runId":"stub-smoke-1","requirement_id":"r","client_id":"c"}}'
```

Then:

```bash
sqlite3 data/ao.db "SELECT agent, category, message FROM LogEvent WHERE runId='stub-smoke-1' ORDER BY ts;"
```

Expected: handler.start + agent_lifecycle rows + handler.end.

- [ ] **Step 4: Commit**

```bash
git add server/inngest/agents/stub-factory.ts
git commit -m "feat(agents): wrap stub-factory with wrapInngestHandler" -- server/inngest/agents/stub-factory.ts
```

---

## Chunk 4 — Query APIs (P2)

Three endpoints all read from `LogEvent`. Built before UI so the UI can be implemented against real responses.

### Task 12: `GET /api/logs` — generic search

**Files:**
- Create: `app/api/logs/route.ts`
- Create: `app/api/logs/route.test.ts`

- [ ] **Step 1: Write `app/api/logs/route.test.ts`**:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { GET } from './route';

async function seed() {
  await prisma.logEvent.deleteMany({});
  await prisma.logEvent.createMany({
    data: [
      { level: 'info',  category: 'agent_lifecycle', source: 'ws', process: 'next',
        agent: 'matchResume', runId: 'r-1', traceId: 't-1', message: 'handler.start' },
      { level: 'error', category: 'api_call',        source: 'ws', process: 'next',
        agent: 'matchResume', runId: 'r-1', traceId: 't-1', message: 'api.robohire.match', status: 'err' },
      { level: 'info',  category: 'llm_call',        source: 'ws', process: 'next',
        agent: 'createJD',    runId: 'r-2', traceId: 't-2', message: 'llm.LLM.generateJD',
        llmModel: 'google/gemini-3-flash-preview', llmTotalTokens: 500 },
    ],
  });
}

function makeReq(qs: string): Request {
  return new Request(`http://localhost/api/logs?${qs}`);
}

describe('GET /api/logs', () => {
  beforeEach(seed);

  it('returns all rows when no filter, ordered by ts desc', async () => {
    const r = await GET(makeReq(''));
    const j = await r.json();
    expect(j.rows.length).toBeGreaterThanOrEqual(3);
    expect(j.total).toBeGreaterThanOrEqual(3);
  });

  it('filters by agent', async () => {
    const r = await GET(makeReq('agent=matchResume'));
    const j = await r.json();
    expect(j.rows.every((row: any) => row.agent === 'matchResume')).toBe(true);
  });

  it('filters by runId', async () => {
    const r = await GET(makeReq('runId=r-2'));
    const j = await r.json();
    expect(j.rows).toHaveLength(1);
    expect(j.rows[0].llmModel).toBe('google/gemini-3-flash-preview');
  });

  it('filters by level (comma list)', async () => {
    const r = await GET(makeReq('level=error,critical'));
    const j = await r.json();
    expect(j.rows.every((row: any) => ['error','critical'].includes(row.level))).toBe(true);
  });

  it('returns payloadPreview not payloadJson in rows', async () => {
    const r = await GET(makeReq(''));
    const j = await r.json();
    for (const row of j.rows) {
      expect(row).not.toHaveProperty('payloadJson');
      expect(row).toHaveProperty('hasFullPayload');
    }
  });

  it('clamps limit to 500', async () => {
    const r = await GET(makeReq('limit=9999'));
    const j = await r.json();
    expect(j.rows.length).toBeLessThanOrEqual(500);
  });

  it('full-text q searches message', async () => {
    const r = await GET(makeReq('q=robohire'));
    const j = await r.json();
    expect(j.rows.length).toBeGreaterThan(0);
    expect(j.rows[0].message).toContain('robohire');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run app/api/logs/route.test.ts`
Expected: FAIL — route not found.

- [ ] **Step 3: Write `app/api/logs/route.ts`**:

```typescript
// GET /api/logs — unified query over LogEvent (spec 2026-05-22 §6.1)
//
// Filters: agent / runId / traceId / eventInstanceId / eventName / category / level
//          / since / until / anchor.<key> / q (full-text)
// Pagination: cursor (opaque, encodes ts+id) + limit (max 500)

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export type LogRow = {
  id: string;
  ts: string;
  level: string;
  category: string;
  source: string;
  process: string;
  agent: string | null;
  runId: string | null;
  traceId: string | null;
  eventInstanceId: string | null;
  eventName: string | null;
  anchors: Record<string, string> | null;
  message: string;
  durationMs: number | null;
  status: string | null;
  payloadPreview: string | null;
  hasFullPayload: boolean;
  llmModel: string | null;
  llmTotalTokens: number | null;
  llmCostUsd: number | null;
};

export type LogsResponse = {
  rows: LogRow[];
  nextCursor: string | null;
  total: number;
  fetchedAt: string;
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = clamp(Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT), 1, MAX_LIMIT);
  const where: Record<string, unknown> = {};

  const eq = (key: string, param: string) => {
    const v = url.searchParams.get(param);
    if (v) where[key] = v;
  };
  eq('agent', 'agent');
  eq('runId', 'runId');
  eq('traceId', 'traceId');
  eq('eventInstanceId', 'eventInstanceId');
  eq('eventName', 'eventName');
  eq('category', 'category');

  const level = url.searchParams.get('level');
  if (level) where.level = { in: level.split(',').map(s => s.trim()) };

  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  if (since || until) {
    const ts: Record<string, Date> = {};
    if (since) ts.gte = new Date(since);
    if (until) ts.lte = new Date(until);
    where.ts = ts;
  }

  // anchor.<key>=<value> — applies to anchorsJson via LIKE
  const anchorClauses: Array<Record<string, unknown>> = [];
  for (const [k, v] of url.searchParams.entries()) {
    if (!k.startsWith('anchor.') || !v) continue;
    const key = k.slice('anchor.'.length);
    // SQLite has no JSON_EXTRACT in Prisma filters; use contains on the raw JSON.
    anchorClauses.push({ anchorsJson: { contains: `"${key}":"${v}"` } });
  }
  if (anchorClauses.length) where.AND = anchorClauses;

  const q = url.searchParams.get('q');
  if (q) {
    where.OR = [
      { message: { contains: q } },
      { payloadJson: { contains: q } },
    ];
  }

  // Cursor — opaque base64 of ISO ts + id
  const cursor = url.searchParams.get('cursor');
  let cursorWhere: Record<string, unknown> | null = null;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
        ts: string; id: string;
      };
      cursorWhere = {
        OR: [
          { ts: { lt: new Date(decoded.ts) } },
          { AND: [{ ts: new Date(decoded.ts) }, { id: { lt: decoded.id } }] },
        ],
      };
    } catch {
      // ignore malformed cursor
    }
  }
  const finalWhere = cursorWhere ? { AND: [where, cursorWhere] } : where;

  const [items, total] = await Promise.all([
    prisma.logEvent.findMany({
      where: finalWhere as never,
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true, ts: true, level: true, category: true, source: true, process: true,
        agent: true, runId: true, traceId: true, eventInstanceId: true, eventName: true,
        anchorsJson: true, message: true, durationMs: true, status: true,
        payloadJson: true, llmModel: true, llmTotalTokens: true, llmCostUsd: true,
      },
    }),
    prisma.logEvent.count({ where: where as never }),
  ]);

  const trimmed = items.slice(0, limit);
  const nextCursor =
    items.length > limit && trimmed[trimmed.length - 1]
      ? Buffer.from(JSON.stringify({
          ts: trimmed[trimmed.length - 1].ts.toISOString(),
          id: trimmed[trimmed.length - 1].id,
        })).toString('base64')
      : null;

  const rows: LogRow[] = trimmed.map(r => ({
    id: r.id,
    ts: r.ts.toISOString(),
    level: r.level,
    category: r.category,
    source: r.source,
    process: r.process,
    agent: r.agent,
    runId: r.runId,
    traceId: r.traceId,
    eventInstanceId: r.eventInstanceId,
    eventName: r.eventName,
    anchors: r.anchorsJson ? safeParse(r.anchorsJson) : null,
    message: r.message,
    durationMs: r.durationMs,
    status: r.status,
    payloadPreview: r.payloadJson ? r.payloadJson.slice(0, 200) : null,
    hasFullPayload: !!r.payloadJson,
    llmModel: r.llmModel,
    llmTotalTokens: r.llmTotalTokens,
    llmCostUsd: r.llmCostUsd,
  }));

  const body: LogsResponse = {
    rows, nextCursor, total,
    fetchedAt: new Date().toISOString(),
  };
  return NextResponse.json(body);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function safeParse(s: string): Record<string, string> | null {
  try { return JSON.parse(s) as Record<string, string>; } catch { return null; }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run app/api/logs/route.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add app/api/logs/route.ts app/api/logs/route.test.ts
git commit -m "feat(api): GET /api/logs unified query" -- app/api/logs/route.ts app/api/logs/route.test.ts
```

---

### Task 13: `GET /api/logs/aggregates`

**Files:**
- Create: `app/api/logs/aggregates/route.ts`
- Create: `app/api/logs/aggregates/route.test.ts`

- [ ] **Step 1: Write the test** (`app/api/logs/aggregates/route.test.ts`):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { GET } from './route';

async function seed() {
  await prisma.logEvent.deleteMany({});
  const base = new Date('2026-05-22T10:00:00Z');
  for (let i = 0; i < 5; i++) {
    await prisma.logEvent.create({ data: {
      ts: new Date(base.getTime() + i * 60_000),
      level: 'info', category: 'llm_call', source: 'ws', process: 'next',
      agent: 'createJD', runId: 'r-a', message: 'llm',
      llmModel: 'google/gemini-3-flash-preview', llmTotalTokens: 100, llmCostUsd: 0.0001,
      durationMs: 200,
    }});
  }
  for (let i = 0; i < 3; i++) {
    await prisma.logEvent.create({ data: {
      ts: new Date(base.getTime() + i * 60_000),
      level: 'error', category: 'api_call', source: 'ws', process: 'next',
      agent: 'matchResume', runId: 'r-b', message: 'api',
      status: 'err', durationMs: 500,
    }});
  }
}

function makeReq(qs: string): Request {
  return new Request(`http://localhost/api/logs/aggregates?${qs}`);
}

describe('GET /api/logs/aggregates', () => {
  beforeEach(seed);

  it('400 when groupBy missing', async () => {
    const r = await GET(makeReq('since=2026-05-22T00:00:00Z&until=2026-05-22T23:59:59Z'));
    expect(r.status).toBe(400);
  });

  it('groupBy=model sums tokens', async () => {
    const r = await GET(makeReq('since=2026-05-22T00:00:00Z&until=2026-05-22T23:59:59Z&groupBy=model&metric=tokens'));
    const j = await r.json();
    expect(j.groups).toContainEqual({ key: 'google/gemini-3-flash-preview', value: 500, n: 5 });
  });

  it('groupBy=agent counts rows', async () => {
    const r = await GET(makeReq('since=2026-05-22T00:00:00Z&until=2026-05-22T23:59:59Z&groupBy=agent&metric=count'));
    const j = await r.json();
    const keys = j.groups.map((g: any) => g.key);
    expect(keys).toContain('createJD');
    expect(keys).toContain('matchResume');
  });

  it('groupBy=hour buckets correctly', async () => {
    const r = await GET(makeReq('since=2026-05-22T00:00:00Z&until=2026-05-22T23:59:59Z&groupBy=hour&metric=count'));
    const j = await r.json();
    expect(j.groups.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run app/api/logs/aggregates/route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `app/api/logs/aggregates/route.ts`**:

```typescript
// GET /api/logs/aggregates — derived stats (spec §6.2)
//
// Required: since, until, groupBy
// Optional: metric (count | tokens | cost | avg_latency | p95_latency | err_rate)
//           filter.agent / filter.category / filter.level

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

type GroupBy = 'model' | 'agent' | 'event' | 'hour' | 'category' | 'level';
type Metric = 'count' | 'tokens' | 'cost' | 'avg_latency' | 'p95_latency' | 'err_rate';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  const groupBy = url.searchParams.get('groupBy') as GroupBy | null;
  const metric = (url.searchParams.get('metric') ?? 'count') as Metric;

  if (!since || !until || !groupBy) {
    return NextResponse.json(
      { error: 'BAD_REQUEST', message: 'since, until, groupBy all required' },
      { status: 400 },
    );
  }

  const where: Record<string, unknown> = {
    ts: { gte: new Date(since), lte: new Date(until) },
  };
  const filterAgent = url.searchParams.get('filter.agent');
  if (filterAgent) where.agent = filterAgent;
  const filterCategory = url.searchParams.get('filter.category');
  if (filterCategory) where.category = filterCategory;
  const filterLevel = url.searchParams.get('filter.level');
  if (filterLevel) where.level = filterLevel;

  // Pull a generous slice (cap 50k for safety) and aggregate in app code.
  // SQLite GROUP BY is fine but the per-metric logic is simpler in TS.
  const rows = await prisma.logEvent.findMany({
    where: where as never,
    take: 50_000,
    select: {
      ts: true, agent: true, eventName: true, category: true, level: true,
      llmModel: true, llmTotalTokens: true, llmCostUsd: true,
      durationMs: true, status: true,
    },
  });

  const buckets = new Map<string, { value: number; n: number; latencies: number[]; errs: number }>();
  for (const row of rows) {
    const key = bucketKey(row, groupBy);
    if (key === null) continue;
    let b = buckets.get(key);
    if (!b) { b = { value: 0, n: 0, latencies: [], errs: 0 }; buckets.set(key, b); }
    b.n += 1;
    if (row.durationMs != null) b.latencies.push(row.durationMs);
    if (row.status === 'err' || row.level === 'error' || row.level === 'critical') b.errs += 1;
    switch (metric) {
      case 'count':       b.value += 1; break;
      case 'tokens':      b.value += row.llmTotalTokens ?? 0; break;
      case 'cost':        b.value += row.llmCostUsd ?? 0; break;
      case 'avg_latency': /* computed at finalize */ break;
      case 'p95_latency': /* computed at finalize */ break;
      case 'err_rate':    /* computed at finalize */ break;
    }
  }

  const groups = [...buckets.entries()].map(([key, b]) => {
    let value = b.value;
    if (metric === 'avg_latency') {
      value = b.latencies.length ? b.latencies.reduce((a, x) => a + x, 0) / b.latencies.length : 0;
    } else if (metric === 'p95_latency') {
      if (b.latencies.length === 0) value = 0;
      else { const sorted = [...b.latencies].sort((a, x) => a - x); value = sorted[Math.floor(sorted.length * 0.95)]; }
    } else if (metric === 'err_rate') {
      value = b.n ? b.errs / b.n : 0;
    }
    return { key, value, n: b.n };
  }).sort((a, b) => b.value - a.value);

  const total = rows.reduce((acc, r) => ({
    count: acc.count + 1,
    tokens: acc.tokens + (r.llmTotalTokens ?? 0),
    cost: acc.cost + (r.llmCostUsd ?? 0),
  }), { count: 0, tokens: 0, cost: 0 });

  return NextResponse.json({
    groups, total,
    meta: { since, until, generatedAt: new Date().toISOString() },
  });
}

function bucketKey(row: { ts: Date; agent: string | null; eventName: string | null; category: string; level: string; llmModel: string | null }, groupBy: GroupBy): string | null {
  switch (groupBy) {
    case 'model':    return row.llmModel;
    case 'agent':    return row.agent;
    case 'event':    return row.eventName;
    case 'category': return row.category;
    case 'level':    return row.level;
    case 'hour': {
      const d = row.ts;
      const iso = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).toISOString();
      return iso;
    }
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run app/api/logs/aggregates/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/logs/aggregates/route.ts app/api/logs/aggregates/route.test.ts
git commit -m "feat(api): GET /api/logs/aggregates" -- app/api/logs/aggregates/route.ts app/api/logs/aggregates/route.test.ts
```

---

### Task 14: `GET /api/logs/[id]` — single row with full payload

**Files:**
- Create: `app/api/logs/[id]/route.ts`
- Create: `app/api/logs/[id]/route.test.ts`

- [ ] **Step 1: Write test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { GET } from './route';

describe('GET /api/logs/[id]', () => {
  beforeEach(async () => {
    await prisma.logEvent.deleteMany({});
  });

  it('returns full payloadJson + parsed anchors', async () => {
    const row = await prisma.logEvent.create({ data: {
      level: 'info', category: 'agent_lifecycle', source: 'ws', process: 'next',
      agent: 'x', runId: 'r-1',
      message: 'test', payloadJson: '{"a":1,"b":[1,2,3]}',
      anchorsJson: '{"candidate_id":"c-7"}',
    }});

    const r = await GET(
      new Request(`http://localhost/api/logs/${row.id}`),
      { params: Promise.resolve({ id: row.id }) },
    );
    const j = await r.json();
    expect(j.id).toBe(row.id);
    expect(j.payload).toEqual({ a: 1, b: [1, 2, 3] });
    expect(j.anchors).toEqual({ candidate_id: 'c-7' });
  });

  it('404 on unknown id', async () => {
    const r = await GET(
      new Request('http://localhost/api/logs/ghost'),
      { params: Promise.resolve({ id: 'ghost' }) },
    );
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run app/api/logs/\[id\]/route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `app/api/logs/[id]/route.ts`**:

```typescript
// GET /api/logs/[id] — single LogEvent with full payloadJson (spec §6.3)

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const row = await prisma.logEvent.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
  return NextResponse.json({
    id: row.id,
    ts: row.ts.toISOString(),
    level: row.level,
    category: row.category,
    source: row.source,
    process: row.process,
    agent: row.agent,
    runId: row.runId,
    traceId: row.traceId,
    eventInstanceId: row.eventInstanceId,
    eventName: row.eventName,
    anchors: row.anchorsJson ? safeParse(row.anchorsJson) : null,
    message: row.message,
    payload: row.payloadJson ? safeParse(row.payloadJson) : null,
    payloadDigest: row.payloadDigest,
    durationMs: row.durationMs,
    status: row.status,
    llmModel: row.llmModel,
    llmPromptTokens: row.llmPromptTokens,
    llmCompletionTokens: row.llmCompletionTokens,
    llmTotalTokens: row.llmTotalTokens,
    llmCostUsd: row.llmCostUsd,
    llmFinishReason: row.llmFinishReason,
  });
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run app/api/logs/\[id\]/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/logs/[id]/route.ts app/api/logs/[id]/route.test.ts
git commit -m "feat(api): GET /api/logs/[id] with full payload" -- app/api/logs/[id]/route.ts app/api/logs/[id]/route.test.ts
```

---

## Chunk 5 — UI: layout + simpler sub-pages (P3a)

Builds the `/audit/*` shell + the 3 lowest-complexity sub-pages: Overview, Stream, Agents (cards). Visual fidelity follows existing AO atoms in [components/shared/atoms.tsx](../../../components/shared/atoms.tsx) (`Card`, `Badge`, `Btn`, `Metric`, `Spark`).

**UI testing**: AO has no playwright. After each UI task, run `npm run dev`, open the route in a browser, and manually verify the §7.4 hard-constraints checklist:
- [ ] ≤ 3 interaction zones
- [ ] ≤ 4 KPIs (if any)
- [ ] No nested `<Tabs>`
- [ ] All correlation keys (runId/traceId/...) are clickable

### Task 15: i18n keys (foundation for all UI tasks)

**Files:**
- Modify: `lib/i18n.tsx` — add 30 `audit_*` keys to both `zh` and `en` blocks

- [ ] **Step 1: Open `lib/i18n.tsx`** and find the `zh` object's `nav_audit` line. Add **after** it:

```typescript
    // ── /audit/* (unified logging UI, spec 2026-05-22) ───────────
    audit_nav_overview: "概览",
    audit_nav_stream: "实时流",
    audit_nav_events: "按事件",
    audit_nav_agents: "按 Agent",
    audit_nav_llm: "大模型调用",
    audit_nav_run: "单 Run",
    audit_kpi_total: "总日志数",
    audit_kpi_errors: "错误数",
    audit_kpi_llm_tokens: "LLM tokens",
    audit_kpi_llm_cost: "LLM 花费",
    audit_drawer_jump_run: "该 run 全部",
    audit_drawer_jump_trace: "同 trace",
    audit_drawer_jump_event: "同事件实例",
    audit_drawer_jump_candidate: "同 candidate",
    audit_drawer_jump_jr: "同 JR",
    audit_filter_level: "级别",
    audit_filter_category: "类别",
    audit_filter_agent: "Agent",
    audit_filter_time: "时间窗",
    audit_filter_search: "搜索",
    audit_llm_model: "模型",
    audit_llm_prompt: "Prompt",
    audit_llm_response: "响应",
    audit_llm_finish_reason: "终止原因",
    audit_llm_tokens: "Tokens",
    audit_llm_cost: "花费",
    audit_llm_duration: "耗时",
    audit_untraceable: "不可追踪",
    audit_open_in_audit: "在审计中打开",
    audit_empty_no_logs: "暂无日志",
```

Then find the matching place in the `en` object and add:

```typescript
    audit_nav_overview: "Overview",
    audit_nav_stream: "Stream",
    audit_nav_events: "By Event",
    audit_nav_agents: "By Agent",
    audit_nav_llm: "LLM Calls",
    audit_nav_run: "Run",
    audit_kpi_total: "Total Logs",
    audit_kpi_errors: "Errors",
    audit_kpi_llm_tokens: "LLM Tokens",
    audit_kpi_llm_cost: "LLM Cost",
    audit_drawer_jump_run: "Same run",
    audit_drawer_jump_trace: "Same trace",
    audit_drawer_jump_event: "Same event instance",
    audit_drawer_jump_candidate: "Same candidate",
    audit_drawer_jump_jr: "Same JR",
    audit_filter_level: "Level",
    audit_filter_category: "Category",
    audit_filter_agent: "Agent",
    audit_filter_time: "Time window",
    audit_filter_search: "Search",
    audit_llm_model: "Model",
    audit_llm_prompt: "Prompt",
    audit_llm_response: "Response",
    audit_llm_finish_reason: "Finish reason",
    audit_llm_tokens: "Tokens",
    audit_llm_cost: "Cost",
    audit_llm_duration: "Duration",
    audit_untraceable: "Untraceable",
    audit_open_in_audit: "Open in Audit",
    audit_empty_no_logs: "No logs yet",
```

- [ ] **Step 2: Run `npm run build`** to surface any TS issue from i18n shape mismatch

Run: `npm run build`
Expected: build succeeds; new keys integrated.

- [ ] **Step 3: Commit**

```bash
git add lib/i18n.tsx
git commit -m "i18n(audit): +30 audit_* keys (zh + en)" -- lib/i18n.tsx
```

---

### Task 16: `/audit` layout + nav (replaces old AuditContent)

**Files:**
- Create: `app/audit/layout.tsx`
- Create: `components/audit/AuditNav.tsx`
- Modify: `app/audit/page.tsx` (rewrite to Overview)
- Delete: `components/audit/AuditContent.tsx`

- [ ] **Step 1: Write `components/audit/AuditNav.tsx`**:

```typescript
"use client";
import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";

const ITEMS = [
  { href: "/audit",         key: "audit_nav_overview", icon: "home" },
  { href: "/audit/stream",  key: "audit_nav_stream",   icon: "bolt" },
  { href: "/audit/events",  key: "audit_nav_events",   icon: "search" },
  { href: "/audit/agents",  key: "audit_nav_agents",   icon: "users" },
  { href: "/audit/llm",     key: "audit_nav_llm",      icon: "sparkle" },
] as const;

export function AuditNav() {
  const { t } = useApp();
  const pathname = usePathname();
  return (
    <aside className="border-r border-line bg-surface" style={{ width: 160, padding: "16px 0" }}>
      <nav className="flex flex-col">
        {ITEMS.map(item => {
          const active = item.href === "/audit"
            ? pathname === "/audit"
            : pathname.startsWith(item.href);
          const Icon = (Ic as Record<string, React.FC>)[item.icon];
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 px-4 py-2 text-[13px] ${
                active ? "bg-accent-bg text-accent font-semibold" : "text-ink-2 hover:bg-bg-2"
              }`}
            >
              {Icon ? <Icon /> : null}
              <span>{t(item.key)}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 2: Write `app/audit/layout.tsx`**:

```typescript
"use client";
import React, { Suspense } from "react";
import { Shell } from "@/components/shared/Shell";
import { AuditNav } from "@/components/audit/AuditNav";
import { useApp } from "@/lib/i18n";

export default function AuditLayout({ children }: { children: React.ReactNode }) {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_govern"), t("nav_audit")]} directionTag={t("nav_audit")}>
      <div className="flex-1 flex min-h-0">
        <AuditNav />
        <div className="flex-1 flex flex-col min-h-0">
          <Suspense fallback={null}>{children}</Suspense>
        </div>
      </div>
    </Shell>
  );
}
```

- [ ] **Step 3: Rewrite `app/audit/page.tsx`** (Overview placeholder; full content in Task 17):

```typescript
"use client";
import React from "react";
import { OverviewContent } from "@/components/audit/OverviewContent";

export default function AuditOverviewPage() {
  return <OverviewContent />;
}
```

- [ ] **Step 4: Stub `components/audit/OverviewContent.tsx`** so the build doesn't break:

```typescript
"use client";
import React from "react";
import { useApp } from "@/lib/i18n";

export function OverviewContent() {
  const { t } = useApp();
  return (
    <div className="p-6">
      <h1 className="text-[20px] font-semibold">{t("audit_nav_overview")}</h1>
      <p className="text-ink-3 text-[13px] mt-1">TODO — Task 17 fills this in.</p>
    </div>
  );
}
```

- [ ] **Step 5: Delete old AuditContent** (old single-page implementation no longer used):

Run: `rm components/audit/AuditContent.tsx`

- [ ] **Step 6: Visual smoke-test**

Run: `npm run dev`
Open: http://localhost:3002/audit

Verify:
- Left rail shows 5 nav items
- "概览" is active
- Page body shows the stub
- Switching language top-right flips nav labels

- [ ] **Step 7: Commit**

```bash
git add app/audit/layout.tsx app/audit/page.tsx components/audit/AuditNav.tsx components/audit/OverviewContent.tsx
git rm components/audit/AuditContent.tsx
git commit -m "feat(audit): layout with left-rail nav (5 sub-pages)" -- app/audit/layout.tsx app/audit/page.tsx components/audit/AuditNav.tsx components/audit/OverviewContent.tsx components/audit/AuditContent.tsx
```

---

### Task 17: Overview page (4 KPI cards + 24h sparkline)

**Files:**
- Modify: `components/audit/OverviewContent.tsx`

- [ ] **Step 1: Rewrite `components/audit/OverviewContent.tsx`**:

```typescript
"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Card, Metric, Spark, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";

type AggResponse = {
  groups: Array<{ key: string; value: number; n: number }>;
  total: { count: number; tokens: number; cost: number };
  meta: { since: string; until: string; generatedAt: string };
};

type LogsResponse = {
  rows: Array<{ level: string; ts: string }>;
  total: number;
};

export function OverviewContent() {
  const { t } = useApp();
  const [agg, setAgg] = React.useState<AggResponse | null>(null);
  const [errors, setErrors] = React.useState<number>(0);

  React.useEffect(() => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const until = new Date().toISOString();
    fetchJson<AggResponse>(
      `/api/logs/aggregates?since=${since}&until=${until}&groupBy=hour&metric=count`
    ).then(setAgg).catch(() => setAgg(null));
    fetchJson<LogsResponse>(
      `/api/logs?level=error,critical&since=${since}&limit=1`
    ).then(r => setErrors(r.total)).catch(() => setErrors(0));
  }, []);

  const sparkData = agg?.groups.map(g => g.value) ?? [];

  return (
    <div className="p-6 max-w-[1200px]">
      <h1 className="text-[20px] font-semibold mb-1">{t("audit_nav_overview")}</h1>
      <p className="text-ink-3 text-[13px] mb-6">24h · {agg?.meta.generatedAt ? new Date(agg.meta.generatedAt).toLocaleString() : ""}</p>

      <div className="grid grid-cols-4 gap-3 mb-6">
        <Card><Metric label={t("audit_kpi_total")} value={(agg?.total.count ?? 0).toLocaleString()} /></Card>
        <Card><Metric label={t("audit_kpi_errors")} value={errors.toLocaleString()} tone={errors > 0 ? "warn" : "default"} /></Card>
        <Card><Metric label={t("audit_kpi_llm_tokens")} value={(agg?.total.tokens ?? 0).toLocaleString()} /></Card>
        <Card><Metric label={t("audit_kpi_llm_cost")} value={`$${(agg?.total.cost ?? 0).toFixed(4)}`} /></Card>
      </div>

      {sparkData.length > 0 ? (
        <Card>
          <div className="text-[12px] text-ink-3 mb-2">24h · 每小时日志条数</div>
          <Spark data={sparkData} height={80} />
        </Card>
      ) : (
        <EmptyState title={t("audit_empty_no_logs")} hint="" />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Confirm `Spark` accepts `{data, height}` props** — check [components/shared/atoms.tsx](../../../components/shared/atoms.tsx). If signature differs, adapt the call.

Run: `grep -n "export function Spark\|Spark = " components/shared/atoms.tsx`

- [ ] **Step 3: Smoke-test**

Run dev server. Open `/audit`. Verify 4 KPI cards + sparkline render. If LogEvent is empty, sparkline shows EmptyState.

- [ ] **Step 4: Commit**

```bash
git add components/audit/OverviewContent.tsx
git commit -m "feat(audit): Overview with 4 KPIs + 24h sparkline" -- components/audit/OverviewContent.tsx
```

---

### Task 18: `LogRowDrawer` (shared component for all sub-pages)

**Files:**
- Create: `components/audit/LogRowDrawer.tsx`

- [ ] **Step 1: Write the drawer** — opens when a row is clicked anywhere; shows 5 cross-jump buttons + full payload:

```typescript
"use client";
import React from "react";
import Link from "next/link";
import { useApp } from "@/lib/i18n";
import { Badge, Btn } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { fetchJson } from "@/lib/api/client";

export type RowSummary = {
  id: string;
  ts: string;
  level: string;
  category: string;
  agent: string | null;
  runId: string | null;
  traceId: string | null;
  eventInstanceId: string | null;
  eventName: string | null;
  anchors: Record<string, string> | null;
  message: string;
};

type FullDetail = RowSummary & {
  payload: unknown;
  payloadDigest: string | null;
  source: string;
  process: string;
  durationMs: number | null;
  status: string | null;
  llmModel: string | null;
  llmPromptTokens: number | null;
  llmCompletionTokens: number | null;
  llmTotalTokens: number | null;
  llmCostUsd: number | null;
  llmFinishReason: string | null;
};

export function LogRowDrawer({ row, onClose }: { row: RowSummary | null; onClose: () => void }) {
  const { t } = useApp();
  const [full, setFull] = React.useState<FullDetail | null>(null);

  React.useEffect(() => {
    setFull(null);
    if (!row) return;
    fetchJson<FullDetail>(`/api/logs/${row.id}`).then(setFull).catch(() => setFull(null));
  }, [row]);

  if (!row) return null;

  const candidateId = row.anchors?.candidate_id;
  const jrId = row.anchors?.job_requisition_id;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
      />
      {/* Drawer */}
      <div
        className="fixed top-0 right-0 bottom-0 z-50 bg-surface border-l border-line flex flex-col"
        style={{ width: 560 }}
      >
        <div className="border-b border-line p-4 flex items-start justify-between">
          <div>
            <div className="text-[13px] font-semibold text-ink-1">{row.agent ?? "system"} · {row.category}</div>
            <div className="text-[11px] text-ink-3 mono">{new Date(row.ts).toLocaleString()}</div>
            <div className="text-[12px] text-ink-2 mt-1">{row.message}</div>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink-1 text-[18px]">×</button>
        </div>

        {/* Jump bar */}
        <div className="border-b border-line p-3 flex flex-wrap gap-1.5">
          <JumpBtn href={row.runId ? `/audit/stream?runId=${row.runId}` : null} label={t("audit_drawer_jump_run")} />
          <JumpBtn href={row.traceId ? `/audit/stream?traceId=${row.traceId}` : null} label={t("audit_drawer_jump_trace")} />
          <JumpBtn href={row.eventInstanceId ? `/audit/stream?eventInstanceId=${row.eventInstanceId}` : null} label={t("audit_drawer_jump_event")} />
          <JumpBtn href={candidateId ? `/audit/stream?anchor.candidate_id=${candidateId}` : null} label={t("audit_drawer_jump_candidate")} />
          <JumpBtn href={jrId ? `/audit/stream?anchor.job_requisition_id=${jrId}` : null} label={t("audit_drawer_jump_jr")} />
        </div>

        {/* Payload */}
        <div className="flex-1 overflow-auto p-4">
          {full?.llmModel ? (
            <div className="mb-4 grid grid-cols-2 gap-2 text-[12px]">
              <Field label={t("audit_llm_model")} value={full.llmModel} />
              <Field label={t("audit_llm_tokens")} value={`${full.llmTotalTokens ?? "—"} (p=${full.llmPromptTokens ?? "—"}, c=${full.llmCompletionTokens ?? "—"})`} />
              <Field label={t("audit_llm_cost")} value={full.llmCostUsd != null ? `$${full.llmCostUsd.toFixed(6)}` : "—"} />
              <Field label={t("audit_llm_finish_reason")} value={full.llmFinishReason ?? "—"} />
            </div>
          ) : null}
          <div className="text-[11px] text-ink-3 mb-1">payload</div>
          <pre className="mono text-[11px] bg-bg-2 p-3 rounded border border-line overflow-auto whitespace-pre-wrap break-all">
            {full ? JSON.stringify(full.payload, null, 2) : "loading…"}
          </pre>
        </div>
      </div>
    </>
  );
}

function JumpBtn({ href, label }: { href: string | null; label: string }) {
  if (!href) {
    return <button className="text-[11.5px] px-2 py-1 rounded bg-bg-2 text-ink-4 cursor-not-allowed">{label}</button>;
  }
  return (
    <Link href={href} className="text-[11.5px] px-2 py-1 rounded bg-accent-bg text-accent hover:opacity-80">
      {label}
    </Link>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-ink-3 uppercase">{label}</div>
      <div className="text-[12px] text-ink-1 mono">{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/audit/LogRowDrawer.tsx
git commit -m "feat(audit): shared LogRowDrawer with 5 cross-jump buttons" -- components/audit/LogRowDrawer.tsx
```

---

### Task 19: `/audit/stream` — tail-f LogStream

**Files:**
- Create: `app/audit/stream/page.tsx`
- Create: `components/audit/StreamContent.tsx`

- [ ] **Step 1: Write the page wrapper** (`app/audit/stream/page.tsx`):

```typescript
"use client";
import React, { Suspense } from "react";
import { StreamContent } from "@/components/audit/StreamContent";

export default function AuditStreamPage() {
  return <Suspense fallback={null}><StreamContent /></Suspense>;
}
```

- [ ] **Step 2: Write `components/audit/StreamContent.tsx`** — filter bar + table + polling + drawer:

```typescript
"use client";
import React from "react";
import { useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { Badge, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import { LogRowDrawer, type RowSummary } from "./LogRowDrawer";
import type { LogsResponse } from "@/app/api/logs/route";

const POLL_MS = 3000;
const LEVELS = ["debug", "info", "notice", "warn", "error", "critical"] as const;
const CATEGORIES = [
  "event_publish", "agent_lifecycle", "agent_step",
  "tool_call", "llm_call", "api_call", "db_call",
  "manage_action", "system",
];

export function StreamContent() {
  const { t } = useApp();
  const searchParams = useSearchParams();

  const [level, setLevel] = React.useState<string>(searchParams.get("level") ?? "");
  const [category, setCategory] = React.useState<string>(searchParams.get("category") ?? "");
  const [agent, setAgent] = React.useState<string>(searchParams.get("agent") ?? "");
  const [q, setQ] = React.useState<string>(searchParams.get("q") ?? "");

  const [rows, setRows] = React.useState<LogsResponse["rows"]>([]);
  const [open, setOpen] = React.useState<RowSummary | null>(null);

  const fetchOnce = React.useCallback(async () => {
    const sp = new URLSearchParams();
    // Pre-bind URL-driven params (sticky from drawer jumps)
    for (const [k, v] of searchParams.entries()) {
      if (!["level","category","agent","q"].includes(k)) sp.set(k, v);
    }
    if (level) sp.set("level", level);
    if (category) sp.set("category", category);
    if (agent) sp.set("agent", agent);
    if (q) sp.set("q", q);
    sp.set("limit", "200");
    try {
      const j = await fetchJson<LogsResponse>(`/api/logs?${sp.toString()}`);
      setRows(j.rows);
    } catch { /* swallow polling errors */ }
  }, [level, category, agent, q, searchParams]);

  React.useEffect(() => {
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    return () => clearInterval(id);
  }, [fetchOnce]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Filter bar (interaction zone 1) */}
      <div className="border-b border-line bg-surface flex items-center gap-3" style={{ padding: "12px 22px" }}>
        <Select label={t("audit_filter_level")} value={level} onChange={setLevel} options={LEVELS} />
        <Select label={t("audit_filter_category")} value={category} onChange={setCategory} options={CATEGORIES} />
        <Input label={t("audit_filter_agent")} value={agent} onChange={setAgent} placeholder="matchResume" />
        <Input label={t("audit_filter_search")} value={q} onChange={setQ} placeholder="text" wider />
        <div className="ml-auto text-[11px] text-ink-3 mono">{rows.length} rows · auto-refresh {POLL_MS/1000}s</div>
      </div>

      {/* Table (interaction zone 2) */}
      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <EmptyState title={t("audit_empty_no_logs")} hint="" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 150 }}>ts</th>
                <th style={{ width: 70 }}>level</th>
                <th style={{ width: 110 }}>agent</th>
                <th style={{ width: 110 }}>category</th>
                <th>message</th>
                <th style={{ width: 70 }}>dur</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="cursor-pointer hover:bg-bg-2" onClick={() => setOpen(row as RowSummary)}>
                  <td className="mono text-[11px] text-ink-2">{new Date(row.ts).toLocaleTimeString(undefined, { hour12: false })}</td>
                  <td><Badge variant={levelTone(row.level)}>{row.level}</Badge></td>
                  <td className="mono text-[11.5px] text-ink-1">{row.agent ?? "—"}</td>
                  <td className="mono text-[10.5px] text-ink-3">{row.category}</td>
                  <td className="text-[12px] text-ink-1 truncate">{row.message}</td>
                  <td className="mono text-[11px] text-ink-3">{row.durationMs != null ? `${row.durationMs}ms` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Drawer (interaction zone 3) */}
      <LogRowDrawer row={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function Input({ label, value, onChange, placeholder, wider }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string; wider?: boolean;
}) {
  return (
    <label className="flex flex-col gap-px">
      <span className="hint">{label}</span>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="h-7 border border-line bg-panel rounded-sm mono text-[11.5px] text-ink-1 outline-none"
        style={{ padding: "0 8px", width: wider ? 220 : 140 }} />
    </label>
  );
}
function Select({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: readonly string[];
}) {
  return (
    <label className="flex flex-col gap-px">
      <span className="hint">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="h-7 border border-line bg-panel rounded-sm text-[11.5px] text-ink-1 outline-none"
        style={{ padding: "0 6px", width: 140 }}>
        <option value="">all</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
function levelTone(level: string): "ok" | "info" | "warn" | "err" | "default" {
  if (level === "error" || level === "critical") return "err";
  if (level === "warn") return "warn";
  if (level === "notice") return "info";
  return "default";
}
```

- [ ] **Step 3: Smoke-test**

Run dev server. Open `/audit/stream`. Verify:
- Filter bar with 4 inputs
- Table populates within 3s
- Click a row → drawer opens with payload
- Click drawer's "same run" button → URL updates to `?runId=...` and table re-filters
- Verify §7.4 constraints: 3 zones (filter / table / drawer), 0 KPI, no nested tabs

- [ ] **Step 4: Commit**

```bash
git add app/audit/stream/page.tsx components/audit/StreamContent.tsx
git commit -m "feat(audit): /audit/stream tail-f log viewer" -- app/audit/stream/page.tsx components/audit/StreamContent.tsx
```

---

### Task 20: `/audit/agents` — agent cards matrix

**Files:**
- Create: `app/audit/agents/page.tsx`
- Create: `components/audit/AgentsContent.tsx`

- [ ] **Step 1: Page wrapper** `app/audit/agents/page.tsx`:

```typescript
"use client";
import React, { Suspense } from "react";
import { AgentsContent } from "@/components/audit/AgentsContent";

export default function AuditAgentsPage() {
  return <Suspense fallback={null}><AgentsContent /></Suspense>;
}
```

- [ ] **Step 2: `components/audit/AgentsContent.tsx`** — uses `/api/logs/aggregates?groupBy=agent`:

```typescript
"use client";
import React from "react";
import Link from "next/link";
import { useApp } from "@/lib/i18n";
import { Card, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";

type AggResponse = {
  groups: Array<{ key: string; value: number; n: number }>;
  total: { count: number };
};

export function AgentsContent() {
  const { t } = useApp();
  const [calls, setCalls] = React.useState<AggResponse | null>(null);
  const [errs, setErrs] = React.useState<AggResponse | null>(null);

  React.useEffect(() => {
    const since = new Date(Date.now() - 24*60*60*1000).toISOString();
    const until = new Date().toISOString();
    fetchJson<AggResponse>(`/api/logs/aggregates?since=${since}&until=${until}&groupBy=agent&metric=count`)
      .then(setCalls).catch(() => setCalls(null));
    fetchJson<AggResponse>(`/api/logs/aggregates?since=${since}&until=${until}&groupBy=agent&metric=err_rate`)
      .then(setErrs).catch(() => setErrs(null));
  }, []);

  const cards = (calls?.groups ?? []).filter(g => g.key);

  return (
    <div className="p-6">
      <h1 className="text-[20px] font-semibold mb-1">{t("audit_nav_agents")}</h1>
      <p className="text-ink-3 text-[13px] mb-6">24h</p>
      {cards.length === 0 ? (
        <EmptyState title={t("audit_empty_no_logs")} hint="" />
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {cards.map(c => {
            const errRate = errs?.groups.find(e => e.key === c.key)?.value ?? 0;
            return (
              <Link key={c.key} href={`/audit/agents/${encodeURIComponent(c.key)}`} className="block">
                <Card>
                  <div className="text-[13px] font-semibold text-ink-1">{c.key}</div>
                  <div className="text-[11px] text-ink-3 mt-1">
                    24h: {c.n.toLocaleString()} calls · err {(errRate * 100).toFixed(1)}%
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Smoke-test**

Open `/audit/agents`. Verify grid of cards, each clickable (next task implements detail page; for now expect 404 on click — acceptable).

- [ ] **Step 4: Commit**

```bash
git add app/audit/agents/page.tsx components/audit/AgentsContent.tsx
git commit -m "feat(audit): /audit/agents card matrix" -- app/audit/agents/page.tsx components/audit/AgentsContent.tsx
```

---

## Chunk 6 — UI: complex sub-pages + cross-page jumps (P3b)

Builds the remaining 3 sub-pages (events, llm, run, agent-detail) and adds `JumpButton` to Live/Monitor/Fleet/Events.

### Task 21: `/audit/agents/[short]` — single agent detail

**Files:**
- Create: `app/audit/agents/[short]/page.tsx`
- Create: `components/audit/AgentDetailContent.tsx`

- [ ] **Step 1: Page wrapper**:

```typescript
"use client";
import React, { Suspense, use } from "react";
import { AgentDetailContent } from "@/components/audit/AgentDetailContent";

export default function AuditAgentDetailPage({ params }: { params: Promise<{ short: string }> }) {
  const { short } = use(params);
  return <Suspense fallback={null}><AgentDetailContent agent={short} /></Suspense>;
}
```

- [ ] **Step 2: `components/audit/AgentDetailContent.tsx`** — 4 KPIs + log table + drawer (reuse `StreamContent` table block):

```typescript
"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Card, Metric, Badge, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import { LogRowDrawer, type RowSummary } from "./LogRowDrawer";
import type { LogsResponse } from "@/app/api/logs/route";

type AggResponse = {
  groups: Array<{ key: string; value: number; n: number }>;
  total: { count: number; tokens: number; cost: number };
};

export function AgentDetailContent({ agent }: { agent: string }) {
  const { t } = useApp();
  const [agg, setAgg] = React.useState<AggResponse | null>(null);
  const [errs, setErrs] = React.useState<number>(0);
  const [avgLatency, setAvgLatency] = React.useState<number>(0);
  const [rows, setRows] = React.useState<LogsResponse["rows"]>([]);
  const [open, setOpen] = React.useState<RowSummary | null>(null);

  React.useEffect(() => {
    const since = new Date(Date.now() - 24*60*60*1000).toISOString();
    const until = new Date().toISOString();
    const base = `since=${since}&until=${until}&filter.agent=${encodeURIComponent(agent)}`;
    Promise.all([
      fetchJson<AggResponse>(`/api/logs/aggregates?${base}&groupBy=category&metric=count`),
      fetchJson<AggResponse>(`/api/logs/aggregates?${base}&groupBy=level&metric=count`),
      fetchJson<AggResponse>(`/api/logs/aggregates?${base}&groupBy=category&metric=avg_latency`),
      fetchJson<LogsResponse>(`/api/logs?agent=${encodeURIComponent(agent)}&limit=300`),
    ]).then(([cats, levels, latency, list]) => {
      setAgg(cats);
      setErrs((levels.groups.find(g => g.key === 'error')?.value ?? 0) +
              (levels.groups.find(g => g.key === 'critical')?.value ?? 0));
      const totalLatency = latency.groups.reduce((s, g) => s + g.value * g.n, 0);
      const totalN = latency.groups.reduce((s, g) => s + g.n, 0);
      setAvgLatency(totalN ? totalLatency / totalN : 0);
      setRows(list.rows);
    }).catch(() => {/* swallow */});
  }, [agent]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-line bg-surface p-6">
        <h1 className="text-[20px] font-semibold mb-3">{agent}</h1>
        <div className="grid grid-cols-4 gap-3">
          <Card><Metric label={t("audit_kpi_total")} value={(agg?.total.count ?? 0).toLocaleString()} /></Card>
          <Card><Metric label={t("audit_kpi_errors")} value={errs.toLocaleString()} tone={errs > 0 ? "warn" : "default"} /></Card>
          <Card><Metric label={t("audit_llm_duration") + " (avg)"} value={`${Math.round(avgLatency)}ms`} /></Card>
          <Card><Metric label={t("audit_kpi_llm_tokens")} value={(agg?.total.tokens ?? 0).toLocaleString()} /></Card>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <EmptyState title={t("audit_empty_no_logs")} hint="" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 150 }}>ts</th>
                <th style={{ width: 70 }}>level</th>
                <th style={{ width: 110 }}>category</th>
                <th>message</th>
                <th style={{ width: 70 }}>dur</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="cursor-pointer hover:bg-bg-2" onClick={() => setOpen(row as RowSummary)}>
                  <td className="mono text-[11px] text-ink-2">{new Date(row.ts).toLocaleTimeString(undefined, { hour12: false })}</td>
                  <td><Badge variant={row.level === 'error' || row.level === 'critical' ? 'err' : row.level === 'warn' ? 'warn' : 'default'}>{row.level}</Badge></td>
                  <td className="mono text-[10.5px] text-ink-3">{row.category}</td>
                  <td className="text-[12px] text-ink-1 truncate">{row.message}</td>
                  <td className="mono text-[11px] text-ink-3">{row.durationMs != null ? `${row.durationMs}ms` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <LogRowDrawer row={open} onClose={() => setOpen(null)} />
    </div>
  );
}
```

- [ ] **Step 3: Smoke-test**

Trigger an event, then open `/audit/agents/matchResume`. Verify KPIs render, table populates, drawer opens.

- [ ] **Step 4: Commit**

```bash
git add app/audit/agents/[short]/page.tsx components/audit/AgentDetailContent.tsx
git commit -m "feat(audit): /audit/agents/[short] single-agent view" -- app/audit/agents/[short]/page.tsx components/audit/AgentDetailContent.tsx
```

---

### Task 22: `/audit/llm` — LLM calls + sparkline + drawer

**Files:**
- Create: `app/audit/llm/page.tsx`
- Create: `components/audit/LlmContent.tsx`

- [ ] **Step 1: Page wrapper**:

```typescript
"use client";
import React, { Suspense } from "react";
import { LlmContent } from "@/components/audit/LlmContent";

export default function AuditLlmPage() {
  return <Suspense fallback={null}><LlmContent /></Suspense>;
}
```

- [ ] **Step 2: `components/audit/LlmContent.tsx`**:

```typescript
"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Card, Spark, Badge, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import { LogRowDrawer, type RowSummary } from "./LogRowDrawer";
import type { LogsResponse, LogRow } from "@/app/api/logs/route";

type AggResponse = {
  groups: Array<{ key: string; value: number; n: number }>;
  total: { count: number; tokens: number; cost: number };
};

export function LlmContent() {
  const { t } = useApp();
  const [tokensSpark, setTokensSpark] = React.useState<number[]>([]);
  const [costSpark, setCostSpark] = React.useState<number[]>([]);
  const [total, setTotal] = React.useState<{ count: number; tokens: number; cost: number }>({ count: 0, tokens: 0, cost: 0 });
  const [rows, setRows] = React.useState<LogRow[]>([]);
  const [open, setOpen] = React.useState<RowSummary | null>(null);

  React.useEffect(() => {
    const since = new Date(Date.now() - 24*60*60*1000).toISOString();
    const until = new Date().toISOString();
    const base = `since=${since}&until=${until}&filter.category=llm_call`;
    Promise.all([
      fetchJson<AggResponse>(`/api/logs/aggregates?${base}&groupBy=hour&metric=tokens`),
      fetchJson<AggResponse>(`/api/logs/aggregates?${base}&groupBy=hour&metric=cost`),
      fetchJson<LogsResponse>(`/api/logs?category=llm_call&limit=200`),
    ]).then(([tok, cst, list]) => {
      setTokensSpark(tok.groups.map(g => g.value));
      setCostSpark(cst.groups.map(g => g.value));
      setTotal(tok.total);
      setRows(list.rows);
    }).catch(() => {/* swallow */});
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-line bg-surface p-6 grid grid-cols-2 gap-4">
        <Card>
          <div className="text-[12px] text-ink-3 mb-1">{t("audit_kpi_llm_tokens")} (24h: {total.tokens.toLocaleString()})</div>
          <Spark data={tokensSpark} height={60} />
        </Card>
        <Card>
          <div className="text-[12px] text-ink-3 mb-1">{t("audit_kpi_llm_cost")} (24h: ${total.cost.toFixed(4)})</div>
          <Spark data={costSpark} height={60} />
        </Card>
      </div>

      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <EmptyState title={t("audit_empty_no_logs")} hint="" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 150 }}>ts</th>
                <th style={{ width: 220 }}>model</th>
                <th style={{ width: 110 }}>agent</th>
                <th style={{ width: 100 }}>tokens</th>
                <th style={{ width: 100 }}>cost</th>
                <th style={{ width: 80 }}>dur</th>
                <th>narrative</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="cursor-pointer hover:bg-bg-2" onClick={() => setOpen(row as RowSummary)}>
                  <td className="mono text-[11px] text-ink-2">{new Date(row.ts).toLocaleTimeString(undefined, { hour12: false })}</td>
                  <td className="mono text-[11px] text-ink-2 truncate">{row.llmModel ?? "—"}</td>
                  <td className="mono text-[11.5px] text-ink-1">{row.agent ?? "—"}</td>
                  <td className="mono text-[11px] text-ink-2">{row.llmTotalTokens?.toLocaleString() ?? "—"}</td>
                  <td className="mono text-[11px] text-ink-2">{row.llmCostUsd != null ? `$${row.llmCostUsd.toFixed(6)}` : "—"}</td>
                  <td className="mono text-[11px] text-ink-3">{row.durationMs != null ? `${row.durationMs}ms` : "—"}</td>
                  <td className="text-[12px] text-ink-1 truncate">{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <LogRowDrawer row={open} onClose={() => setOpen(null)} />
    </div>
  );
}
```

- [ ] **Step 3: Smoke-test**

Trigger an LLM-using agent (e.g. publish an event that fires createJD → generateJD calls Gemini). Open `/audit/llm`. Verify table populates, drawer shows prompt/response/cost.

- [ ] **Step 4: Commit**

```bash
git add app/audit/llm/page.tsx components/audit/LlmContent.tsx
git commit -m "feat(audit): /audit/llm with sparklines + prompt/response drawer" -- app/audit/llm/page.tsx components/audit/LlmContent.tsx
```

---

### Task 23: `/audit/events` — by-event drilldown

**Files:**
- Create: `app/audit/events/page.tsx`
- Create: `components/audit/EventsContent.tsx`

- [ ] **Step 1: Page wrapper**:

```typescript
"use client";
import React, { Suspense } from "react";
import { EventsContent } from "@/components/audit/EventsContent";

export default function AuditEventsPage() {
  return <Suspense fallback={null}><EventsContent /></Suspense>;
}
```

- [ ] **Step 2: `components/audit/EventsContent.tsx`** — left event list, right instance list, drawer for full causal chain (drawer's "same event instance" jump button is the chain entry point):

```typescript
"use client";
import React from "react";
import { useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import { LogRowDrawer, type RowSummary } from "./LogRowDrawer";
import type { LogsResponse } from "@/app/api/logs/route";

type AggResponse = {
  groups: Array<{ key: string; value: number; n: number }>;
};

export function EventsContent() {
  const { t } = useApp();
  const searchParams = useSearchParams();
  const initialEvent = searchParams.get("eventName") ?? "";

  const [events, setEvents] = React.useState<AggResponse["groups"]>([]);
  const [selected, setSelected] = React.useState<string>(initialEvent);
  const [instances, setInstances] = React.useState<LogsResponse["rows"]>([]);
  const [open, setOpen] = React.useState<RowSummary | null>(null);

  React.useEffect(() => {
    const since = new Date(Date.now() - 24*60*60*1000).toISOString();
    const until = new Date().toISOString();
    fetchJson<AggResponse>(`/api/logs/aggregates?since=${since}&until=${until}&groupBy=event&metric=count&filter.category=event_publish`)
      .then(j => {
        const sorted = j.groups.filter(g => g.key).sort((a, b) => b.value - a.value);
        setEvents(sorted);
        if (!selected && sorted[0]) setSelected(sorted[0].key);
      });
  }, []);

  React.useEffect(() => {
    if (!selected) return;
    fetchJson<LogsResponse>(`/api/logs?eventName=${encodeURIComponent(selected)}&category=event_publish&limit=100`)
      .then(j => setInstances(j.rows));
  }, [selected]);

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left — event list */}
      <div className="border-r border-line bg-surface overflow-y-auto" style={{ width: 280 }}>
        <div className="p-3 text-[11px] text-ink-3 uppercase border-b border-line">events (24h)</div>
        {events.length === 0 ? <EmptyState title={t("audit_empty_no_logs")} hint="" /> : events.map(e => (
          <button key={e.key} onClick={() => setSelected(e.key)}
            className={`w-full text-left px-3 py-2 border-b border-line/40 flex items-center justify-between
              ${selected === e.key ? "bg-accent-bg text-accent" : "hover:bg-bg-2 text-ink-1"}`}>
            <span className="mono text-[11.5px] truncate">{e.key}</span>
            <span className="mono text-[10.5px] text-ink-3 ml-2">{e.value}</span>
          </button>
        ))}
      </div>

      {/* Middle — instance list */}
      <div className="flex-1 overflow-auto">
        {instances.length === 0 ? (
          <EmptyState title={t("audit_empty_no_logs")} hint="" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 150 }}>ts</th>
                <th style={{ width: 110 }}>agent</th>
                <th style={{ width: 280 }}>traceId / runId</th>
                <th>narrative</th>
              </tr>
            </thead>
            <tbody>
              {instances.map(row => (
                <tr key={row.id} className="cursor-pointer hover:bg-bg-2" onClick={() => setOpen(row as RowSummary)}>
                  <td className="mono text-[11px] text-ink-2">{new Date(row.ts).toLocaleTimeString(undefined, { hour12: false })}</td>
                  <td className="mono text-[11.5px] text-ink-1">{row.agent ?? "em"}</td>
                  <td className="mono text-[10.5px] text-ink-3">{row.traceId ?? row.runId ?? "—"}</td>
                  <td className="text-[12px] text-ink-1 truncate">{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <LogRowDrawer row={open} onClose={() => setOpen(null)} />
    </div>
  );
}
```

- [ ] **Step 3: Smoke-test**

Publish a few events. Open `/audit/events`. Verify:
- Left event list sorted by frequency
- Click an event → instance list updates
- Click an instance → drawer opens with payload

- [ ] **Step 4: Commit**

```bash
git add app/audit/events/page.tsx components/audit/EventsContent.tsx
git commit -m "feat(audit): /audit/events with event-list + instance drilldown" -- app/audit/events/page.tsx components/audit/EventsContent.tsx
```

---

### Task 24: `/audit/runs/[id]` — single run timeline

**Files:**
- Create: `app/audit/runs/[id]/page.tsx`
- Create: `components/audit/RunContent.tsx`

- [ ] **Step 1: Page wrapper**:

```typescript
"use client";
import React, { Suspense, use } from "react";
import { RunContent } from "@/components/audit/RunContent";

export default function AuditRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense fallback={null}><RunContent runId={id} /></Suspense>;
}
```

- [ ] **Step 2: `components/audit/RunContent.tsx`** — header + chronological timeline; viz toggle is a button pair, not a tab:

```typescript
"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import { LogRowDrawer, type RowSummary } from "./LogRowDrawer";
import type { LogsResponse, LogRow } from "@/app/api/logs/route";

export function RunContent({ runId }: { runId: string }) {
  const { t } = useApp();
  const [rows, setRows] = React.useState<LogRow[]>([]);
  const [open, setOpen] = React.useState<RowSummary | null>(null);

  React.useEffect(() => {
    fetchJson<LogsResponse>(`/api/logs?runId=${encodeURIComponent(runId)}&limit=500`)
      .then(j => setRows(j.rows.slice().reverse())); // chronological asc for run view
  }, [runId]);

  const span = rows.length > 0
    ? `${new Date(rows[0].ts).toLocaleString()} → ${new Date(rows[rows.length - 1].ts).toLocaleString()}`
    : "—";
  const agents = Array.from(new Set(rows.map(r => r.agent).filter(Boolean) as string[]));

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-line bg-surface p-6">
        <div className="text-[11.5px] text-ink-3 mono">run</div>
        <h1 className="text-[16px] font-semibold mono">{runId}</h1>
        <div className="text-[12px] text-ink-3 mt-2">{span} · {agents.join(', ') || "—"}</div>
      </div>
      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <EmptyState title={t("audit_empty_no_logs")} hint="" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 150 }}>ts</th>
                <th style={{ width: 110 }}>agent</th>
                <th style={{ width: 110 }}>category</th>
                <th style={{ width: 70 }}>level</th>
                <th>message</th>
                <th style={{ width: 70 }}>dur</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="cursor-pointer hover:bg-bg-2" onClick={() => setOpen(row as RowSummary)}>
                  <td className="mono text-[11px] text-ink-2">{new Date(row.ts).toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 })}</td>
                  <td className="mono text-[11.5px] text-ink-1">{row.agent ?? "—"}</td>
                  <td className="mono text-[10.5px] text-ink-3">{row.category}</td>
                  <td><Badge variant={row.level === 'error' || row.level === 'critical' ? 'err' : row.level === 'warn' ? 'warn' : 'default'}>{row.level}</Badge></td>
                  <td className="text-[12px] text-ink-1 truncate">{row.message}</td>
                  <td className="mono text-[11px] text-ink-3">{row.durationMs != null ? `${row.durationMs}ms` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <LogRowDrawer row={open} onClose={() => setOpen(null)} />
    </div>
  );
}
```

- [ ] **Step 3: Smoke-test**

After triggering any event, copy a runId from `/audit/stream` and open `/audit/runs/<id>`. Verify chronological order, drawer.

- [ ] **Step 4: Commit**

```bash
git add app/audit/runs/[id]/page.tsx components/audit/RunContent.tsx
git commit -m "feat(audit): /audit/runs/[id] single-run timeline" -- app/audit/runs/[id]/page.tsx components/audit/RunContent.tsx
```

---

### Task 25: Cross-page `JumpButton` + add to Live / Monitor / Fleet / Events

**Files:**
- Create: `components/audit/JumpButton.tsx`
- Modify: `components/live/RealRunDetail.tsx` (header area)
- Modify: `components/monitor/RunDetailContent.tsx`
- Modify: `components/monitor/FailureDetailContent.tsx`
- Modify: `components/fleet/AgentDetailPanel.tsx`
- Modify: `components/events/EventInstancesTab.tsx`

- [ ] **Step 1: Create `components/audit/JumpButton.tsx`**:

```typescript
"use client";
import React from "react";
import Link from "next/link";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";

export function JumpButton({ href, label }: { href: string; label?: string }) {
  const { t } = useApp();
  return (
    <Link
      href={href}
      title={label ?? t("audit_open_in_audit")}
      className="inline-flex items-center gap-1 text-[11.5px] px-1.5 py-0.5 rounded text-ink-3 hover:bg-bg-2 hover:text-accent"
    >
      <Ic.search />
      <span>{label ?? t("audit_open_in_audit")}</span>
    </Link>
  );
}
```

- [ ] **Step 2: Add to `RealRunDetail.tsx` Header** — find the header (search for "RealRunCenter" → header function), inject:

```typescript
import { JumpButton } from "@/components/audit/JumpButton";

// inside the header JSX, near onRefresh / onClear buttons:
<JumpButton href={`/audit/runs/${runId}`} />
```

- [ ] **Step 3: Same for `components/monitor/RunDetailContent.tsx`** — locate run header, add `<JumpButton href={/audit/runs/${runId}}/>` next to existing actions.

- [ ] **Step 4: Same for `components/monitor/FailureDetailContent.tsx`** — failures typically have a runId; add jump button if present.

- [ ] **Step 5: Same for `components/fleet/AgentDetailPanel.tsx`** — header:

```typescript
<JumpButton href={`/audit/agents/${agentShort}`} />
```

- [ ] **Step 6: Same for `components/events/EventInstancesTab.tsx`** — each row, end column:

```typescript
<JumpButton href={`/audit/events?eventName=${row.eventName}&eventInstanceId=${row.id}`} label="" />
```

(Empty label keeps the row compact — icon-only.)

- [ ] **Step 7: Visual smoke-test**

Run dev server. Open `/live`, click a run, verify Jump button. Open `/fleet`, click an agent, verify. Open `/events`, find an instance row, verify icon link.

- [ ] **Step 8: Commit**

```bash
git add components/audit/JumpButton.tsx components/live/RealRunDetail.tsx components/monitor/RunDetailContent.tsx components/monitor/FailureDetailContent.tsx components/fleet/AgentDetailPanel.tsx components/events/EventInstancesTab.tsx
git commit -m "feat(audit): JumpButton entry points in Live/Monitor/Fleet/Events" -- components/audit/JumpButton.tsx components/live/RealRunDetail.tsx components/monitor/RunDetailContent.tsx components/monitor/FailureDetailContent.tsx components/fleet/AgentDetailPanel.tsx components/events/EventInstancesTab.tsx
```

---

### Task 26: Final integration check + DoD verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all pass. If failures, fix before commit.

- [ ] **Step 2: Run the production build**

Run: `npm run build`
Expected: no TS errors, no build failures.

- [ ] **Step 3: End-to-end manual verification (DoD §12)**

Run `npm run dev`. Then for each acceptance criterion:

1. **Any agent**: Open `/audit/agents/matchResume` → verify lifecycle + step + tool_call + llm_call + api_call rows visible
2. **Any event**: Open `/audit/events`, pick `MATCH_RULE_CHECK_PASSED`, click an instance, drawer's "same event instance" → cross-jump to stream view
3. **Any LLM call**: Open `/audit/llm`, click a row → drawer shows model + prompt + response + usage + cost + finish reason
4. **Traceable cross-link**: From `/audit/stream`, click any row → "same trace" jump filters table to that traceId
5. **Hard-constraint review**: open each of 6 sub-pages, count interaction zones (≤3), count KPIs (≤4), check no `<Tabs>` is used
6. **Zero regression**: open `/monitor/audit`, `/live`, hit `curl http://localhost:3002/api/audit` — all still return expected shape
7. **TTL** (deferred — re-verify 31 days post-deploy)

- [ ] **Step 4: Update CLAUDE.md** if needed — add a brief note to the audit/log section mentioning the new `/audit/*` IA and `LOG_EVENT_WRITE` env var.

Run `grep -n "audit\|AuditLog" CLAUDE.md` to find the section. Add a 2-line note pointing readers at the new spec.

- [ ] **Step 5: Commit (if CLAUDE.md changed)**

```bash
git add CLAUDE.md
git commit -m "docs(claude): point at unified-logging spec + /audit IA" -- CLAUDE.md
```

---

## Out of scope for this plan (P4, separate plan if needed)

Per spec §10:
- Removing file JSONL writer entirely (waits 30 days post-deploy)
- Postgres FTS / Elasticsearch backend swap
- Alerts / behavior triggered by LogEvent
- Log export / download
- RBAC scoping LogEvent visibility
- Dynamic LLM price fetching
- RAAS remote log federation
- Anomaly detection / smart insights / NL log queries

If any becomes a hard requirement, write a follow-up spec & plan.

---

## Quick-reference: file paths cheat sheet

| Purpose | Path |
|---|---|
| Spec | `docs/superpowers/specs/2026-05-22-unified-logging-audit-design.md` |
| Logger | `server/log/logger.ts` |
| Prisma | `prisma/schema.prisma` (`LogEvent` model) |
| Inngest wrapper | `server/inngest/wrap-handler.ts` |
| Query API | `app/api/logs/route.ts` / `aggregates/route.ts` / `[id]/route.ts` |
| UI layout | `app/audit/layout.tsx` + `components/audit/AuditNav.tsx` |
| Shared drawer | `components/audit/LogRowDrawer.tsx` |
| Cross-page jump | `components/audit/JumpButton.tsx` |
| Env vars | `.env.example` (`LOG_EVENT_WRITE`, `LOG_LLM_BODIES`, …) |
