# Global Tracing Chatbot — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A floating chat bubble on every page + `/chat` full-screen page that answers cross-agent/cross-run/cross-event questions using a curated 7-tool read-only layer (no raw Cypher/SQL by default).

**Architecture:** Mirrors existing `app/api/agents/[short]/chat/route.ts` tool-loop pattern. New endpoint `POST /api/chat/trace` with 7 tools dispatched in a `MAX_TOOL_TURNS=4` loop. Front-end: `useGlobalChat` hook backed by localStorage (multi-session); two consumers — `<GlobalChatBubble>` mounted in `Shell` and a `/chat` page. Page-context auto-injected by reading `pathname` + URL params.

**Tech Stack:** Next.js 16.2 App Router · React 19.2 · Tailwind v4.2 OKLCH · `server/llm/gateway.ts` (OpenAI SDK + Gemini/etc.) · Prisma (Postgres) · Neo4j driver via existing `lib/allmeta-client.ts` · vitest+happy-dom for unit tests.

**Source spec:** [docs/superpowers/specs/2026-05-21-global-tracing-chatbot-design.md](../specs/2026-05-21-global-tracing-chatbot-design.md)

**Commit rule (critical):** This repo has a pre-commit hook that re-stages working-tree changes. Use pathspec form for every commit:
```bash
git commit -m "message" -- path1 path2
```
(`-m "msg"` MUST come BEFORE `--` and the file list, or git treats `-m` as a pathspec.) Before commit: `git diff --cached --name-only`. After: `git show --stat HEAD`.

**Commands:**
- `npm test -- <pattern>` — vitest run
- `npm run build` — typecheck + lint + build (slow; run before commit on big changes)
- `npm run dev` — port **3002**

---

## File Structure

### Chunk 1 — Tool layer foundations (Task γ.A)

- **Create** `lib/chat/types.ts` — shared `ChatMessage`, `ChatSource`, `ToolDef`, `PageContext`, `GlobalChatResponse`
- **Create** `lib/chat/global-chat-tools.ts` — 7 tools: `searchRuns`, `getRunDetail`, `searchEvents`, `searchAudits`, `searchEntities`, `searchDLQ`, `getEventChain`. Each exports a `{ schema, execute }` shape.
- **Create** `lib/chat/global-chat-tools.test.ts` — happy-path + edge tests per tool (mocked Prisma + Neo4j driver + DLQ fetch)

### Chunk 2 — Backend endpoint (Task γ.B)

- **Create** `lib/chat/global-chat-system-prompt.ts` — `buildSystemPrompt(pageContext)` returns the system message string
- **Create** `app/api/chat/trace/route.ts` — POST handler: validate body → audit log → `runToolLoop()` → response
- **Create** `app/api/chat/trace/route.test.ts` — mock LLM gateway, verify dispatch + error handling

### Chunk 3 — Shared client hook (Task γ.C)

- **Create** `lib/chat/use-global-chat.ts` — React hook: history state, localStorage multi-session, send/clear/switch helpers
- **Create** `lib/chat/use-global-chat.test.tsx` — happy-dom hook test covering save/load/multi-session

### Chunk 4 — Floating bubble + Shell integration (Task γ.D)

- **Create** `components/chat/GlobalChatPanel.tsx` — shared chat surface (message list + input). Used by both bubble and full-screen page.
- **Create** `components/chat/GlobalChatBubble.tsx` — 56px fixed bottom-right button → 480×620 drawer wrapping `<GlobalChatPanel>`
- **Modify** `components/shared/Shell.tsx` — mount `<GlobalChatBubble />` once, after the main content area
- **Create** `lib/chat/page-context.ts` — `usePageContext()` hook: reads `usePathname` + `useSearchParams` and produces a `PageContext` object

### Chunk 5 — `/chat` full-screen page (Task γ.E)

- **Create** `app/chat/page.tsx` — thin client component → `<Shell crumbs={...}><GlobalChatFullContent /></Shell>`
- **Create** `components/chat/GlobalChatFullContent.tsx` — full-screen layout with left history sidebar + main panel (`<GlobalChatPanel>` reused)
- **Create** `components/chat/HistoryList.tsx` — session list (title + timestamp), rename / delete actions
- **Modify** `components/shared/LeftNav.tsx` (or wherever nav items live) — add `运营 > 追踪助手` entry pointing to `/chat`

### Chunk 6 — i18n + polish + final E2E (Task γ.F)

- **Modify** `lib/i18n.tsx` — add `nav_trace_chat` + `chat_*` keys for bubble/page UI in both `zh` and `en`
- **Modify** any new component files to route all chrome strings through `t()`

---

## Chunk 1: Tool Layer Foundations

### Task γ.A: 7 read-only tools with TDD

**Files:**
- Create: `lib/chat/types.ts`
- Create: `lib/chat/global-chat-tools.ts`
- Create: `lib/chat/global-chat-tools.test.ts`

#### Step 1: Define shared types

Create `lib/chat/types.ts`:

```ts
// Shared chat types used by both server (route handler) and client
// (useGlobalChat hook + bubble + full page).

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

/** Reference badge shown under each assistant reply (clickable). */
export type ChatSource = {
  tool: string;          // e.g. "searchRuns"
  label: string;         // human-readable badge text
  ref?: string;          // optional ID
  url?: string;          // optional jump target (e.g. /monitor?run=R-123)
};

/** Page context auto-injected into the system prompt. */
export type PageContext = {
  route: string;
  runId?: string;
  auditId?: string;
  entityType?: string;
  entityId?: string;
  agentShort?: string;
};

/** A registered tool. Exposed to the LLM via `schema`, dispatched via `execute`. */
export type ToolDef = {
  name: string;
  schema: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>; // JSONSchema
    };
  };
  execute: (input: unknown) => Promise<{
    result: unknown;
    sources?: ChatSource[];
  }>;
};

export type GlobalChatRequest = {
  messages: ChatMessage[];
  pageContext?: PageContext;
};

export type GlobalChatResponse = {
  reply: ChatMessage;
  sources: ChatSource[];
  modelUsed?: string;
  toolCallsExecuted?: number;
};
```

#### Step 2: Write tests FIRST

Create `lib/chat/global-chat-tools.test.ts`. Cover each of the 7 tools with happy path + one edge case. Use `vi.mock` to stub Prisma/Neo4j/fetch.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: {
    workflowRun: { findMany: vi.fn() },
    workflowStep: { findMany: vi.fn() },
    agentEpisode: { findMany: vi.fn() },
    eventInstance: { findMany: vi.fn() },
    ruleCheckAudit: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/allmeta-client", () => ({
  searchEntitiesNeo4j: vi.fn(),
}));

global.fetch = vi.fn();

import { TOOLS } from "./global-chat-tools";
import { prisma } from "@/server/db";

const byName = (name: string) => TOOLS.find((t) => t.name === name)!;

beforeEach(() => vi.resetAllMocks());

describe("searchRuns tool", () => {
  it("returns runs filtered by agent and status", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([
      { id: "R-1", agentName: "JDGenerator", status: "Failed", startedAt: new Date(), durationMs: 1234, error: "boom" },
    ]);
    const { result, sources } = await byName("searchRuns").execute({ agent: "JDGenerator", status: "Failed", limit: 10 });
    expect((result as any).runs).toHaveLength(1);
    expect((result as any).runs[0].error).toBe("boom");
    expect(sources?.[0]?.url).toMatch(/\/monitor/);
  });

  it("clamps limit to max 50", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([]);
    await byName("searchRuns").execute({ limit: 999 });
    expect((prisma.workflowRun.findMany as any).mock.calls[0][0].take).toBe(50);
  });
});

describe("getRunDetail tool", () => {
  it("fetches run + steps + episodes", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([{ id: "R-1", agentName: "X", status: "Completed", startedAt: new Date() }]);
    (prisma.workflowStep.findMany as any).mockResolvedValue([{ id: "S-1", idx: 0, name: "init", status: "Completed", durationMs: 50 }]);
    (prisma.agentEpisode.findMany as any).mockResolvedValue([{ stepIdx: 0, modelUsed: "gemini-3", tokenUsage: { prompt: 10, completion: 5, total: 15 }, durationMs: 50 }]);
    const { result } = await byName("getRunDetail").execute({ runId: "R-1" });
    expect((result as any).run.id).toBe("R-1");
    expect((result as any).steps).toHaveLength(1);
    expect((result as any).episodes).toHaveLength(1);
  });

  it("returns null run when not found", async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([]);
    const { result } = await byName("getRunDetail").execute({ runId: "nope" });
    expect((result as any).run).toBeNull();
  });
});

describe("searchEvents tool", () => {
  it("supports wildcard name (MATCH_*)", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([{ id: "E-1", name: "MATCH_PASSED", emittedAt: new Date(), payload: { upload_id: "u1" } }]);
    const { result } = await byName("searchEvents").execute({ name: "MATCH_*", limit: 5 });
    const where = (prisma.eventInstance.findMany as any).mock.calls[0][0].where;
    expect(where.name).toMatchObject({ startsWith: "MATCH_" });
    expect((result as any).events).toHaveLength(1);
  });
});

describe("searchAudits tool", () => {
  it("filters by decision + ruleId", async () => {
    (prisma.ruleCheckAudit.findMany as any).mockResolvedValue([{ auditId: "A-1", decision: "FAIL", clientName: "X", failureReasons: ["R-005"] }]);
    const { result } = await byName("searchAudits").execute({ decision: "FAIL", ruleId: "R-005" });
    expect((result as any).audits).toHaveLength(1);
  });
});

describe("searchEntities tool", () => {
  it("delegates to allmeta-client", async () => {
    const { searchEntitiesNeo4j } = await import("@/lib/allmeta-client");
    (searchEntitiesNeo4j as any).mockResolvedValue([{ id: "C-1", displayName: "Alice" }]);
    const { result } = await byName("searchEntities").execute({ type: "candidate", q: "Alice" });
    expect((result as any).entities[0].displayName).toBe("Alice");
  });
});

describe("searchDLQ tool", () => {
  it("fetches /api/inngest-admin/dlq", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ dlq: [{ id: "D-1", function: { slug: "X" }, status: "Failed", startedAt: new Date().toISOString() }] }),
    });
    const { result } = await byName("searchDLQ").execute({});
    expect((result as any).items).toHaveLength(1);
  });
});

describe("getEventChain tool", () => {
  it("returns chronological chain for an upload_id", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([
      { id: "E-2", name: "RESUME_PROCESSED", emittedAt: new Date("2026-05-20T00:00:00Z"), payload: { upload_id: "u-abc" } },
      { id: "E-3", name: "MATCH_RULE_CHECK_PASSED", emittedAt: new Date("2026-05-20T00:00:30Z"), payload: { upload_id: "u-abc" } },
    ]);
    const { result } = await byName("getEventChain").execute({ anchor: { type: "uploadId", value: "u-abc" } });
    expect((result as any).chain).toHaveLength(2);
    expect((result as any).chain[0].timestamp < (result as any).chain[1].timestamp).toBe(true);
  });
});
```

#### Step 3: Run tests, verify they fail

Run: `npm test -- lib/chat/global-chat-tools.test`
Expected: fail with "Cannot find module './global-chat-tools'"

#### Step 4: Implement tools

Create `lib/chat/global-chat-tools.ts`:

```ts
// Read-only tool layer for the global tracing chatbot.
//
// Each tool is { name, schema, execute }. The schema is the OpenAI
// tool-format definition exposed to the LLM. execute() takes the LLM-supplied
// args and returns { result, sources? }. Tools are READ-ONLY by contract —
// any future write operation should NOT be added here; it belongs in the
// Manage axis.

import { prisma } from "@/server/db";
import { searchEntitiesNeo4j } from "@/lib/allmeta-client";
import type { ToolDef, ChatSource } from "./types";

// ---------- helpers ----------

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

function resolveSince(since: unknown): Date | undefined {
  if (typeof since !== "string") return undefined;
  // relative form: "-24h" / "-7d"
  const m = since.match(/^-(\d+)([hd])$/);
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === "h" ? n * 3_600_000 : n * 86_400_000;
    return new Date(Date.now() - ms);
  }
  const dt = new Date(since);
  return isNaN(dt.getTime()) ? undefined : dt;
}

// ---------- 1. searchRuns ----------

const searchRuns: ToolDef = {
  name: "searchRuns",
  schema: {
    type: "function",
    function: {
      name: "searchRuns",
      description: "List Inngest agent runs. Filter by agent short name, status, time window, or trigger event. Returns run id + status + timing + error.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Canonical agent short, e.g. 'JDGenerator'" },
          status: { type: "string", description: "Running | Completed | Failed | Cancelled" },
          since: { type: "string", description: "ISO timestamp or relative like '-24h' / '-7d'" },
          eventName: { type: "string", description: "Filter by triggering event name" },
          limit: { type: "number", description: "Max rows (default 20, max 50)" },
        },
        required: [],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const take = clamp(i.limit, 1, 50, 20);
    const since = resolveSince(i.since);
    const where: Record<string, unknown> = {};
    if (typeof i.agent === "string") where.agentName = i.agent;
    if (typeof i.status === "string") where.status = i.status;
    if (typeof i.eventName === "string") where.eventName = i.eventName;
    if (since) where.startedAt = { gte: since };
    const rows = await prisma.workflowRun.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take,
    });
    const sources: ChatSource[] = rows.slice(0, 5).map((r) => ({
      tool: "searchRuns",
      label: `${r.agentName} · ${r.status}`,
      ref: r.id,
      url: `/monitor?run=${encodeURIComponent(r.id)}`,
    }));
    return {
      result: {
        runs: rows.map((r) => ({
          id: r.id,
          agent: r.agentName,
          status: r.status,
          startedAt: r.startedAt?.toISOString(),
          durationMs: r.durationMs,
          eventName: r.eventName,
          error: r.error ?? undefined,
        })),
        total: rows.length,
      },
      sources,
    };
  },
};

// ---------- 2. getRunDetail ----------

const getRunDetail: ToolDef = {
  name: "getRunDetail",
  schema: {
    type: "function",
    function: {
      name: "getRunDetail",
      description: "Get one run with its steps, episodes (LLM/token usage), and received/emitted events.",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string", description: "Run id (e.g. R-...)" },
        },
        required: ["runId"],
      },
    },
  },
  execute: async (input) => {
    const runId = String((input as any)?.runId ?? "");
    if (!runId) return { result: { run: null, steps: [], episodes: [], events: { received: [], emitted: [] } } };
    const [runs, steps, episodes] = await Promise.all([
      prisma.workflowRun.findMany({ where: { id: runId }, take: 1 }),
      prisma.workflowStep.findMany({ where: { runId }, orderBy: { idx: "asc" } }),
      prisma.agentEpisode.findMany({ where: { runId } }),
    ]);
    const run = runs[0] ?? null;
    return {
      result: {
        run: run
          ? { id: run.id, agent: run.agentName, status: run.status, startedAt: run.startedAt?.toISOString(), durationMs: run.durationMs, eventName: run.eventName, error: run.error ?? undefined }
          : null,
        steps: steps.map((s) => ({ idx: s.idx, name: s.name, status: s.status, durationMs: s.durationMs, error: s.error ?? undefined })),
        episodes: episodes.map((e) => ({ stepIdx: e.stepIdx, modelUsed: e.modelUsed, tokenUsage: e.tokenUsage, duration: e.durationMs })),
        events: { received: [], emitted: [] }, // populated from EventInstance in a v2; runId↔event link not yet stored
      },
      sources: run ? [{ tool: "getRunDetail", label: `run ${run.id.slice(0, 8)}`, ref: run.id, url: `/monitor?run=${encodeURIComponent(run.id)}` }] : [],
    };
  },
};

// ---------- 3. searchEvents ----------

const searchEvents: ToolDef = {
  name: "searchEvents",
  schema: {
    type: "function",
    function: {
      name: "searchEvents",
      description: "Search EventInstance log. Supports name wildcards ('MATCH_*') and time window. Returns event id + name + emittedAt + payload snippet.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Event name; supports trailing wildcard 'MATCH_*'" },
          since: { type: "string", description: "ISO or '-24h' / '-7d'" },
          limit: { type: "number", description: "Default 30, max 100" },
          payloadContains: {
            type: "object",
            properties: {
              jrId: { type: "string" },
              candidateId: { type: "string" },
              clientId: { type: "string" },
              uploadId: { type: "string" },
            },
          },
        },
        required: [],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const take = clamp(i.limit, 1, 100, 30);
    const since = resolveSince(i.since);
    const where: Record<string, unknown> = {};
    if (typeof i.name === "string") {
      if (i.name.endsWith("*")) where.name = { startsWith: i.name.slice(0, -1) };
      else where.name = i.name;
    }
    if (since) where.emittedAt = { gte: since };
    const rows = await prisma.eventInstance.findMany({
      where,
      orderBy: { emittedAt: "desc" },
      take,
    });
    return {
      result: {
        events: rows.map((r) => ({
          id: r.id,
          name: r.name,
          emittedAt: r.emittedAt?.toISOString(),
          payloadSnippet: typeof r.payload === "object" && r.payload ? JSON.parse(JSON.stringify(r.payload).slice(0, 1024)) : null,
        })),
        total: rows.length,
      },
      sources: rows.slice(0, 5).map((r) => ({ tool: "searchEvents", label: `${r.name} ${r.id.slice(0, 6)}`, ref: r.id })),
    };
  },
};

// ---------- 4. searchAudits ----------

const searchAudits: ToolDef = {
  name: "searchAudits",
  schema: {
    type: "function",
    function: {
      name: "searchAudits",
      description: "Search RuleCheckAudit table. Filter by decision, ruleId (matches in flags), client, JR id, candidate id, time window.",
      parameters: {
        type: "object",
        properties: {
          decision: { type: "string", description: "PASS | FAIL" },
          ruleId: { type: "string", description: "Rule id, e.g. R-005" },
          client: { type: "string" },
          jrId: { type: "string" },
          candidateId: { type: "string" },
          since: { type: "string", description: "ISO or '-24h'" },
          limit: { type: "number", description: "Default 20, max 50" },
        },
        required: [],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const take = clamp(i.limit, 1, 50, 20);
    const since = resolveSince(i.since);
    const where: Record<string, unknown> = {};
    if (typeof i.decision === "string") where.decision = i.decision;
    if (typeof i.client === "string") where.clientName = i.client;
    if (typeof i.jrId === "string") where.jobRequisitionId = i.jrId;
    if (typeof i.candidateId === "string") where.candidateId = i.candidateId;
    if (since) where.createdAt = { gte: since };
    // ruleId match via failure_reasons array — approximate; if not stored as array, this becomes a no-op (kept for forward compat)
    if (typeof i.ruleId === "string") where.failureReasons = { has: i.ruleId };
    const rows = await prisma.ruleCheckAudit.findMany({ where, orderBy: { createdAt: "desc" }, take });
    return {
      result: {
        audits: rows.map((r) => ({
          audit_id: r.auditId,
          decision: r.decision,
          created_at: r.createdAt?.toISOString(),
          client_name: r.clientName,
          job_requisition_id: r.jobRequisitionId,
          candidate_id: r.candidateId,
          n_flags: r.nFlags ?? 0,
          rules_evaluated: r.rulesEvaluated ?? 0,
          failure_reasons: r.failureReasons ?? [],
        })),
        total: rows.length,
      },
      sources: rows.slice(0, 5).map((r) => ({
        tool: "searchAudits",
        label: `${r.decision} · ${r.clientName ?? "?"}`,
        ref: r.auditId,
        url: `/rule-check?view=audits&auditId=${encodeURIComponent(r.auditId)}`,
      })),
    };
  },
};

// ---------- 5. searchEntities ----------

const searchEntities: ToolDef = {
  name: "searchEntities",
  schema: {
    type: "function",
    function: {
      name: "searchEntities",
      description: "Free-text search over Neo4j ontology entities (candidate / jd / requisition / client). Matches name / id / aliases.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "candidate | jd | requisition | client" },
          q: { type: "string", description: "Free-text query" },
          limit: { type: "number", description: "Default 10, max 30" },
        },
        required: ["type", "q"],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const type = String(i.type ?? "");
    const q = String(i.q ?? "");
    const take = clamp(i.limit, 1, 30, 10);
    const rows = (await searchEntitiesNeo4j({ type, q, limit: take }).catch(() => [])) as Array<{ id: string; displayName: string }>;
    return {
      result: {
        entities: rows.map((r) => ({ id: r.id, type, displayName: r.displayName, url: `/entities/${type}/${encodeURIComponent(r.id)}` })),
        total: rows.length,
      },
      sources: rows.slice(0, 5).map((r) => ({
        tool: "searchEntities",
        label: `${type} ${r.displayName}`,
        ref: r.id,
        url: `/entities/${type}/${encodeURIComponent(r.id)}`,
      })),
    };
  },
};

// ---------- 6. searchDLQ ----------

const searchDLQ: ToolDef = {
  name: "searchDLQ",
  schema: {
    type: "function",
    function: {
      name: "searchDLQ",
      description: "List failed/cancelled Inngest runs from the dead-letter queue.",
      parameters: {
        type: "object",
        properties: {
          since: { type: "string", description: "ISO or '-24h'" },
          limit: { type: "number", description: "Default 20" },
        },
        required: [],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const take = clamp(i.limit, 1, 50, 20);
    const base = process.env.AO_INTERNAL_BASE_URL ?? "http://localhost:3002";
    const res = await fetch(`${base}/api/inngest-admin/dlq`);
    if (!res.ok) return { result: { items: [], total: 0 } };
    const body = await res.json();
    const items = (body.dlq ?? []).slice(0, take);
    return {
      result: { items, total: items.length },
      sources: items.slice(0, 3).map((d: any) => ({
        tool: "searchDLQ",
        label: `${d.function?.slug ?? "?"} · ${d.status}`,
        ref: d.id,
        url: `/monitor?tab=dlq`,
      })),
    };
  },
};

// ---------- 7. getEventChain ----------

const getEventChain: ToolDef = {
  name: "getEventChain",
  schema: {
    type: "function",
    function: {
      name: "getEventChain",
      description: "Build a causal chain of events/runs/audits for a given anchor (candidate / jrId / uploadId / eventId). Returns chronological list.",
      parameters: {
        type: "object",
        properties: {
          anchor: {
            type: "object",
            properties: {
              type: { type: "string", description: "candidate | jrId | uploadId | eventId" },
              value: { type: "string" },
            },
            required: ["type", "value"],
          },
          windowHours: { type: "number", description: "Default 24" },
        },
        required: ["anchor"],
      },
    },
  },
  execute: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const anchor = i.anchor as { type?: string; value?: string } | undefined;
    if (!anchor?.type || !anchor.value) return { result: { chain: [] } };
    const windowMs = clamp(i.windowHours, 1, 168, 24) * 3_600_000;
    const since = new Date(Date.now() - windowMs);

    // Match payloads containing the anchor value (best-effort JSON contains)
    let where: Record<string, unknown>;
    switch (anchor.type) {
      case "candidate":
        where = { payload: { path: ["candidate_id"], equals: anchor.value } };
        break;
      case "jrId":
        where = { payload: { path: ["job_requisition_id"], equals: anchor.value } };
        break;
      case "uploadId":
        where = { payload: { path: ["upload_id"], equals: anchor.value } };
        break;
      case "eventId":
        where = { id: anchor.value };
        break;
      default:
        return { result: { chain: [] } };
    }
    const events = await prisma.eventInstance.findMany({
      where: { ...where, emittedAt: { gte: since } },
      orderBy: { emittedAt: "asc" },
      take: 50,
    });
    const chain = events.map((e) => ({
      timestamp: e.emittedAt?.toISOString() ?? "",
      kind: "event" as const,
      name: e.name,
      summary: `${e.name}`,
      refId: e.id,
      url: `/events?id=${encodeURIComponent(e.id)}`,
    }));
    return {
      result: { chain },
      sources: chain.slice(0, 5).map((c) => ({ tool: "getEventChain", label: c.name, ref: c.refId, url: c.url })),
    };
  },
};

// ---------- Export the registry ----------

export const TOOLS: ToolDef[] = [
  searchRuns,
  getRunDetail,
  searchEvents,
  searchAudits,
  searchEntities,
  searchDLQ,
  getEventChain,
];

export const TOOL_SCHEMAS = TOOLS.map((t) => t.schema);

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
```

**Note:** If `searchEntitiesNeo4j` doesn't exist in `lib/allmeta-client.ts` yet, search for the closest existing helper (probably named something like `findEntitiesByType` or `cypherSearch`) and adapt the tool implementation. Read [lib/allmeta-client.ts](../../lib/allmeta-client.ts) to confirm the available API. If nothing close exists, **add a thin helper** in `lib/allmeta-client.ts` rather than calling the Neo4j driver directly from `global-chat-tools.ts`.

**Note 2:** If the actual Prisma schema field names differ from what's used above (e.g. `agentName` vs `agent`, `tokenUsage` JSON shape), adjust the tool's `where` / mapping to match. Read the Prisma schema at `prisma/schema.prisma` first.

#### Step 5: Run tests, verify they pass

Run: `npm test -- lib/chat/global-chat-tools.test`
Expected: all green.

If any test fails due to a Prisma schema field mismatch you discovered in Step 4, **adjust the test's mock and the tool's mapping together** — the test should describe the real shape.

#### Step 6: Build + lint

Run: `npm run build`
Expected: clean.

#### Step 7: Commit

```bash
git diff --cached --name-only
git commit -m "feat(chat): global tracing tool layer — 7 read-only tools" -- lib/chat/types.ts lib/chat/global-chat-tools.ts lib/chat/global-chat-tools.test.ts
git show --stat HEAD
```

---

## Chunk 2: Backend endpoint

### Task γ.B: `/api/chat/trace` route + system prompt + LLM tool loop

**Files:**
- Create: `lib/chat/global-chat-system-prompt.ts`
- Create: `app/api/chat/trace/route.ts`
- Create: `app/api/chat/trace/route.test.ts`

#### Step 1: System prompt builder

Create `lib/chat/global-chat-system-prompt.ts`:

```ts
import type { PageContext } from "./types";

export function buildSystemPrompt(pageContext?: PageContext): string {
  const ctxLine = pageContextLine(pageContext);
  return `你是 Agentic Operator 的全局追踪助手。你能查询的范围:
- Inngest function 的 run 记录(WorkflowRun + WorkflowStep + AgentEpisode)
- 事件流(EventInstance,由 em.publish 写入)
- Rule Check audit(RuleCheckAudit)
- Ontology 实体(Candidate / JD / Requisition / Client,Neo4j)
- DLQ
- 跨 agent 的事件因果链(upload_id 关联)

硬约束:
- **任何关于 ID / 数字 / 时间戳 / 状态的事实必须经过工具查询。** 禁止从对话历史或训练知识编造。
- 这是只读端点。用户问"如何 replay / cancel / 改",答"目前未开放,建议去 /monitor 手动操作"。
- 用户提到的 ID(run id / audit id / candidate id / event name)优先以工具查询验证存在;不存在直接说明。
- 回答带 markdown link:run 用 [R-xxx](/monitor?run=R-xxx),audit 用 [A-xxx](/rule-check?view=audits&auditId=A-xxx),candidate 用 [候选人名](/entities/candidate/X)。

回答风格:
- 第一句结论,后面才是证据。
- 数字 / 时间 / agent 名加粗;ID / 事件名 / 状态用反引号。
- 默认 ≤10 行,问"详细" / "展开"再展开。
- 跟随用户语言(中文进 → 中文出,英文进 → 英文出)。
${ctxLine}`;
}

function pageContextLine(pc?: PageContext): string {
  if (!pc) return "";
  const parts: string[] = [];
  if (pc.runId) parts.push(`正在看 run \`${pc.runId}\``);
  if (pc.auditId) parts.push(`正在看 audit \`${pc.auditId}\``);
  if (pc.entityType && pc.entityId) parts.push(`正在看 ${pc.entityType} \`${pc.entityId}\``);
  if (pc.agentShort) parts.push(`关注 agent \`${pc.agentShort}\``);
  if (parts.length === 0) return `\n当前页面: \`${pc.route}\``;
  return `\n当前页面上下文: ${parts.join(", ")} (\`${pc.route}\`)`;
}
```

#### Step 2: Route handler test FIRST

Create `app/api/chat/trace/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/llm/gateway", () => ({
  isGatewayConfigured: vi.fn(() => true),
  pickGateway: vi.fn(),
}));

vi.mock("@/lib/chat/global-chat-tools", () => ({
  TOOLS: [],
  TOOL_SCHEMAS: [],
  findTool: vi.fn(),
}));

import { POST } from "./route";
import { pickGateway } from "@/server/llm/gateway";
import { findTool } from "@/lib/chat/global-chat-tools";

beforeEach(() => vi.resetAllMocks());

function makeReq(body: object): Request {
  return new Request("http://x/api/chat/trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat/trace", () => {
  it("returns 400 when messages missing", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("returns assistant reply on simple message", async () => {
    (pickGateway as any).mockReturnValue({
      client: {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { role: "assistant", content: "hello back", tool_calls: [] } }],
              model: "gemini-3-flash",
            }),
          },
        },
      },
      model: "gemini-3-flash",
    });
    const res = await POST(makeReq({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply.content).toBe("hello back");
  });

  it("dispatches tool call and feeds result back", async () => {
    (findTool as any).mockReturnValue({
      name: "searchRuns",
      execute: vi.fn().mockResolvedValue({
        result: { runs: [{ id: "R-1" }], total: 1 },
        sources: [{ tool: "searchRuns", label: "R-1", url: "/monitor?run=R-1" }],
      }),
    });
    const create = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "searchRuns", arguments: '{"agent":"X"}' } }],
          },
        }],
        model: "x",
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "Found 1 run.", tool_calls: [] } }],
        model: "x",
      });
    (pickGateway as any).mockReturnValue({ client: { chat: { completions: { create } } }, model: "x" });

    const res = await POST(makeReq({ messages: [{ role: "user", content: "any runs for X?" }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply.content).toBe("Found 1 run.");
    expect(body.sources).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "searchRuns" })]));
    expect(body.toolCallsExecuted).toBe(1);
  });

  it("returns 502 with fallback when gateway throws", async () => {
    (pickGateway as any).mockImplementation(() => { throw new Error("no LLM"); });
    const res = await POST(makeReq({ messages: [{ role: "user", content: "x" }] }));
    expect(res.status).toBe(502);
  });
});
```

Run: `npm test -- app/api/chat/trace/route.test` — expect failure ("Cannot find module './route'").

#### Step 3: Implement route

Create `app/api/chat/trace/route.ts`. Model on [app/api/agents/[short]/chat/route.ts](../../app/api/agents/[short]/chat/route.ts) (especially its `runToolLoop` shape around line 500+).

```ts
// POST /api/chat/trace — global tracing chatbot endpoint.
//
// Tool-using LLM scoped to read-only data across runs / events / audits /
// entities / DLQ / event-chains. Sister to /api/agents/:short/chat (agent-
// scoped) and /api/runs/:id/chat (run-scoped); shares the tool-loop pattern.

import { NextResponse } from "next/server";
import { isGatewayConfigured, pickGateway } from "@/server/llm/gateway";
import { TOOLS, TOOL_SCHEMAS, findTool } from "@/lib/chat/global-chat-tools";
import { buildSystemPrompt } from "@/lib/chat/global-chat-system-prompt";
import type {
  ChatMessage,
  ChatSource,
  GlobalChatRequest,
  GlobalChatResponse,
  PageContext,
} from "@/lib/chat/types";

const MAX_TOOL_TURNS = 4;
const MAX_TOOL_RESULT_BYTES = 16_000;

export async function POST(req: Request): Promise<Response> {
  let body: GlobalChatRequest;
  try {
    body = (await req.json()) as GlobalChatRequest;
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST", message: "invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "BAD_REQUEST", message: "messages[] required" }, { status: 400 });
  }

  try {
    if (!isGatewayConfigured()) {
      return NextResponse.json<GlobalChatResponse>({
        reply: { role: "assistant", content: "LLM gateway 未配置 · 请联系管理员设置 OPENAI_API_KEY 或等价 env。" },
        sources: [],
      });
    }
    const result = await runToolLoop(body.messages, body.pageContext);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: "LLM_FAILED", message: (e as Error).message },
      { status: 502 },
    );
  }
}

async function runToolLoop(
  messages: ChatMessage[],
  pageContext?: PageContext,
): Promise<GlobalChatResponse> {
  const cfg = pickGateway();
  const sources: ChatSource[] = [];
  let toolCallsExecuted = 0;

  // Build initial conversation: system + user-supplied history
  const conversation: Array<
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: any[] }
    | { role: "tool"; tool_call_id: string; content: string }
  > = [
    { role: "system", content: buildSystemPrompt(pageContext) },
    ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const completion = await cfg.client.chat.completions.create({
      model: cfg.model,
      messages: conversation as any,
      tools: TOOL_SCHEMAS as any,
      tool_choice: "auto",
    });
    const msg = completion.choices[0]?.message;
    if (!msg) throw new Error("empty completion");

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Final assistant message
      return {
        reply: { role: "assistant", content: msg.content ?? "" },
        sources,
        modelUsed: completion.model,
        toolCallsExecuted,
      };
    }

    // Push assistant message with tool_calls
    conversation.push({ role: "assistant", content: null, tool_calls: toolCalls });

    // Dispatch each tool
    for (const call of toolCalls) {
      const tool = findTool(call.function.name);
      if (!tool) {
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: `unknown tool: ${call.function.name}` }),
        });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.function.arguments || "{}");
      } catch {
        parsed = {};
      }
      try {
        const { result, sources: toolSources } = await tool.execute(parsed);
        toolCallsExecuted += 1;
        if (toolSources) sources.push(...toolSources);
        let serialized = JSON.stringify(result);
        if (serialized.length > MAX_TOOL_RESULT_BYTES) {
          serialized = serialized.slice(0, MAX_TOOL_RESULT_BYTES) + '..."truncated":true}';
        }
        conversation.push({ role: "tool", tool_call_id: call.id, content: serialized });
      } catch (e) {
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: (e as Error).message }),
        });
      }
    }
  }

  // Max turns hit without final answer
  return {
    reply: { role: "assistant", content: "(已达到最大工具调用轮数,以下是部分结果)" },
    sources,
    modelUsed: cfg.model,
    toolCallsExecuted,
  };
}
```

#### Step 4: Run tests

Run: `npm test -- app/api/chat/trace/route.test`
Expected: 4 tests green.

If the route's import path differs (e.g. existing chat routes use different gateway shape), adapt. Inspect `app/api/agents/[short]/chat/route.ts` lines 500-560 to align the OpenAI client shape exactly.

#### Step 5: Build

Run: `npm run build`
Expected: clean.

#### Step 6: Commit

```bash
git commit -m "feat(api): POST /api/chat/trace + system prompt + tool loop" -- \
  lib/chat/global-chat-system-prompt.ts \
  app/api/chat/trace/route.ts \
  app/api/chat/trace/route.test.ts
git show --stat HEAD
```

---

## Chunk 3: Shared client hook

### Task γ.C: `useGlobalChat` hook + localStorage multi-session

**Files:**
- Create: `lib/chat/use-global-chat.ts`
- Create: `lib/chat/use-global-chat.test.tsx`

#### Step 1: Hook test FIRST

Create `lib/chat/use-global-chat.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGlobalChat } from "./use-global-chat";

beforeEach(() => {
  if (typeof window !== "undefined") window.localStorage.clear();
});

describe("useGlobalChat", () => {
  it("starts with an empty current session and empty history list", () => {
    const { result } = renderHook(() => useGlobalChat());
    expect(result.current.currentSession.messages).toEqual([]);
    expect(result.current.sessions).toEqual([]);
  });

  it("appendMessage adds to current session", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "hi" }));
    expect(result.current.currentSession.messages).toHaveLength(1);
  });

  it("newSession archives current to sessions list", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "hi" }));
    act(() => result.current.newSession());
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.currentSession.messages).toEqual([]);
  });

  it("switchSession loads a previous session", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "first" }));
    act(() => result.current.newSession());
    const firstId = result.current.sessions[0]!.id;
    act(() => result.current.appendMessage({ role: "user", content: "second" }));
    act(() => result.current.switchSession(firstId));
    expect(result.current.currentSession.messages[0]?.content).toBe("first");
  });

  it("deleteSession removes from sessions list", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "x" }));
    act(() => result.current.newSession());
    const id = result.current.sessions[0]!.id;
    act(() => result.current.deleteSession(id));
    expect(result.current.sessions).toEqual([]);
  });

  it("persists across remounts via localStorage", () => {
    const { result, unmount } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "persist me" }));
    unmount();
    const { result: r2 } = renderHook(() => useGlobalChat());
    expect(r2.current.currentSession.messages[0]?.content).toBe("persist me");
  });
});
```

Run: expect failure ("Cannot find module ./use-global-chat" or no @testing-library/react).

**Note on test dep:** if `@testing-library/react` isn't installed, install it as a devDep first:
```bash
npm install --save-dev @testing-library/react
```
Verify the install lands in `package.json` devDependencies; the implementer should not bypass this with `npm install --no-save`.

#### Step 2: Implement hook

Create `lib/chat/use-global-chat.ts`:

```ts
"use client";
import { useCallback, useEffect, useState } from "react";
import type { ChatMessage } from "./types";

export type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

const STORAGE_KEY = "ao:global-chat:v1";

type Persisted = {
  current: ChatSession;
  sessions: ChatSession[];
};

function emptySession(): ChatSession {
  const now = new Date().toISOString();
  return { id: cryptoRandom(), title: "新会话", createdAt: now, updatedAt: now, messages: [] };
}

function cryptoRandom(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2, 10);
}

function load(): Persisted {
  if (typeof window === "undefined") return { current: emptySession(), sessions: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { current: emptySession(), sessions: [] };
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed.current || !Array.isArray(parsed.sessions)) throw new Error("bad");
    return parsed;
  } catch {
    return { current: emptySession(), sessions: [] };
  }
}

function save(state: Persisted): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage full or disabled — silently skip
  }
}

function autoTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "新会话";
  return firstUser.content.slice(0, 32) + (firstUser.content.length > 32 ? "…" : "");
}

export function useGlobalChat() {
  const [state, setState] = useState<Persisted>(() => load());

  useEffect(() => {
    save(state);
  }, [state]);

  const appendMessage = useCallback((m: ChatMessage) => {
    setState((s) => {
      const messages = [...s.current.messages, m];
      const title = s.current.messages.length === 0 ? autoTitle(messages) : s.current.title;
      return {
        ...s,
        current: { ...s.current, messages, title, updatedAt: new Date().toISOString() },
      };
    });
  }, []);

  const replaceLastAssistant = useCallback((m: ChatMessage) => {
    setState((s) => {
      const msgs = [...s.current.messages];
      // overwrite the last assistant placeholder if present
      const idx = [...msgs].reverse().findIndex((mm) => mm.role === "assistant");
      if (idx >= 0) msgs[msgs.length - 1 - idx] = m;
      else msgs.push(m);
      return { ...s, current: { ...s.current, messages: msgs, updatedAt: new Date().toISOString() } };
    });
  }, []);

  const clearCurrent = useCallback(() => {
    setState((s) => ({ ...s, current: { ...emptySession() } }));
  }, []);

  const newSession = useCallback(() => {
    setState((s) => {
      // Archive current if it has messages
      const archive = s.current.messages.length > 0 ? [s.current, ...s.sessions] : s.sessions;
      return { current: emptySession(), sessions: archive };
    });
  }, []);

  const switchSession = useCallback((id: string) => {
    setState((s) => {
      const found = s.sessions.find((x) => x.id === id);
      if (!found) return s;
      // Save current to archive if it has content and isn't already there
      const archive = s.current.messages.length > 0 && !s.sessions.some((x) => x.id === s.current.id)
        ? [s.current, ...s.sessions.filter((x) => x.id !== id)]
        : s.sessions.filter((x) => x.id !== id);
      return { current: found, sessions: archive };
    });
  }, []);

  const deleteSession = useCallback((id: string) => {
    setState((s) => ({ ...s, sessions: s.sessions.filter((x) => x.id !== id) }));
  }, []);

  const renameSession = useCallback((id: string, title: string) => {
    setState((s) => ({
      ...s,
      current: s.current.id === id ? { ...s.current, title } : s.current,
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
    }));
  }, []);

  return {
    currentSession: state.current,
    sessions: state.sessions,
    appendMessage,
    replaceLastAssistant,
    clearCurrent,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
  };
}
```

#### Step 3: Run tests, verify pass

Run: `npm test -- lib/chat/use-global-chat.test`
Expected: 6/6 pass.

#### Step 4: Build + commit

```bash
npm run build
git commit -m "feat(chat): useGlobalChat hook with localStorage multi-session" -- \
  lib/chat/use-global-chat.ts lib/chat/use-global-chat.test.tsx package.json package-lock.json
```

(Include `package.json` / `package-lock.json` if you added `@testing-library/react`.)

---

## Chunk 4: Floating bubble + Shell integration

### Task γ.D: GlobalChatBubble + Shell mount + page context

**Files:**
- Create: `lib/chat/page-context.ts`
- Create: `components/chat/GlobalChatPanel.tsx`
- Create: `components/chat/GlobalChatBubble.tsx`
- Modify: `components/shared/Shell.tsx`

#### Step 1: Page-context hook

Create `lib/chat/page-context.ts`:

```ts
"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import type { PageContext } from "./types";

/**
 * Maps the current route + URL params into a PageContext object
 * that the chatbot uses to anchor its system prompt. Keeps the
 * bubble feeling like it knows what the user is looking at.
 */
export function usePageContext(): PageContext {
  const pathname = usePathname();
  const sp = useSearchParams();

  return useMemo(() => {
    const route = pathname ?? "/";
    const ctx: PageContext = { route };

    // /monitor?run=R-...
    if (route.startsWith("/monitor")) {
      const r = sp.get("run");
      if (r) ctx.runId = r;
    }
    // /monitor/runs/[id]
    const runMatch = route.match(/^\/monitor\/runs\/([^/]+)/);
    if (runMatch) ctx.runId = decodeURIComponent(runMatch[1]);

    // /rule-check?view=audits&auditId=A-...
    if (route.startsWith("/rule-check")) {
      const a = sp.get("auditId");
      if (a) ctx.auditId = a;
    }

    // /entities/[type]/[id]
    const entityMatch = route.match(/^\/entities\/([^/]+)\/([^/]+)/);
    if (entityMatch) {
      ctx.entityType = entityMatch[1];
      ctx.entityId = decodeURIComponent(entityMatch[2]);
    }

    // /workflow + agent query
    if (route === "/workflow") {
      const a = sp.get("agent");
      if (a) ctx.agentShort = a;
    }

    return ctx;
  }, [pathname, sp]);
}
```

#### Step 2: Shared GlobalChatPanel

Create `components/chat/GlobalChatPanel.tsx`:

```tsx
"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { useGlobalChat } from "@/lib/chat/use-global-chat";
import { usePageContext } from "@/lib/chat/page-context";
import { Markdown } from "@/components/shared/Markdown";
import { Badge, Btn } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import type { ChatMessage, ChatSource, GlobalChatRequest, GlobalChatResponse } from "@/lib/chat/types";

const SUGGESTIONS: string[] = [
  "字节跳动最近 24h 几条 rule 拦了?",
  "JDGenerator 最近哪些 run 失败了?",
  "DLQ 现在有多少条?",
  "candidate XXX 走到哪一步了?",
];

export function GlobalChatPanel({ scope = "bubble" }: { scope?: "bubble" | "full" }) {
  const { t } = useApp();
  const chat = useGlobalChat();
  const pageContext = usePageContext();
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [sourcesPerMessage, setSourcesPerMessage] = React.useState<Record<number, ChatSource[]>>({});
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat.currentSession.messages.length]);

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      const userMsg: ChatMessage = { role: "user", content: trimmed };
      chat.appendMessage(userMsg);
      setInput("");
      setBusy(true);
      setErr(null);
      try {
        const reqBody: GlobalChatRequest = {
          messages: [...chat.currentSession.messages, userMsg],
          pageContext,
        };
        const res = await fetch("/api/chat/trace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody),
        });
        const data = (await res.json()) as GlobalChatResponse & { error?: string; message?: string };
        if (!res.ok || data.error) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
        chat.appendMessage({ role: "assistant", content: data.reply.content });
        const idx = chat.currentSession.messages.length + 1; // user + assistant added
        if (data.sources?.length) {
          setSourcesPerMessage((s) => ({ ...s, [idx]: data.sources }));
        }
      } catch (e) {
        setErr((e as Error).message ?? t("chat_send_fail"));
      } finally {
        setBusy(false);
      }
    },
    [busy, chat, pageContext, t],
  );

  const messages = chat.currentSession.messages;

  return (
    <div className="flex flex-col h-full bg-surface">
      {scope === "bubble" && pageContext.route !== "/" && (
        <div className="border-b border-line" style={{ padding: "8px 12px" }}>
          <span className="text-[10.5px] text-ink-3" style={{ letterSpacing: "0.04em" }}>
            {t("chat_context_label")}
          </span>
          <div className="mono text-[11px] text-ink-2 truncate" title={pageContext.route}>
            {pageContext.route}
            {pageContext.runId ? ` · run ${pageContext.runId.slice(0, 10)}` : ""}
            {pageContext.auditId ? ` · audit ${pageContext.auditId.slice(0, 10)}` : ""}
            {pageContext.entityType ? ` · ${pageContext.entityType} ${pageContext.entityId?.slice(0, 10)}` : ""}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto" style={{ padding: "10px 12px" }}>
        {messages.length === 0 && (
          <div>
            <div className="text-[12px] text-ink-3 mb-2">{t("chat_empty_hint")}</div>
            <div className="flex flex-col gap-1">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="text-left bg-panel border border-line rounded-sm hover:bg-surface text-[11.5px] text-ink-2 cursor-pointer"
                  style={{ padding: "6px 8px" }}
                  onClick={() => void send(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <Bubble key={i} message={m} sources={sourcesPerMessage[i]} />
        ))}
        {busy && (
          <div className="text-[11px] text-ink-3 mt-2 flex items-center gap-1.5">
            <span className="animate-pulse">●</span> {t("chat_thinking")}
          </div>
        )}
        {err && (
          <div
            className="mt-2 border rounded-sm text-[11px]"
            style={{
              padding: "6px 8px",
              background: "var(--c-warn-bg)",
              borderColor: "color-mix(in oklab, var(--c-warn) 35%, transparent)",
              color: "oklch(0.45 0.14 75)",
            }}
          >
            ⚠ {err}
          </div>
        )}
      </div>

      <div className="border-t border-line bg-panel" style={{ padding: "8px 10px" }}>
        <div className="flex gap-1.5">
          <input
            className="flex-1 bg-surface border border-line rounded-sm px-2 py-1 text-[12.5px] outline-none focus:border-[color:var(--c-accent)]"
            placeholder={t("chat_input_placeholder")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            disabled={busy}
          />
          <Btn size="sm" variant="primary" onClick={() => void send(input)} disabled={busy || !input.trim()} title={t("chat_send")}>
            <Ic.arrowR />
          </Btn>
          {messages.length > 0 && (
            <Btn size="sm" variant="ghost" onClick={chat.newSession} title={t("chat_new_session")}>
              +
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({ message, sources }: { message: ChatMessage; sources?: ChatSource[] }) {
  const isUser = message.role === "user";
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="text-[10px] mono mb-0.5" style={{ color: isUser ? "var(--c-ink-3)" : "var(--c-accent)" }}>
        {isUser ? "你" : "AI"}
      </div>
      <div
        className={`rounded-md text-[12.5px] leading-relaxed ${
          isUser ? "bg-panel border border-line" : "bg-accent-bg border border-accent-line"
        }`}
        style={{ padding: "6px 10px" }}
      >
        {isUser ? <div className="whitespace-pre-wrap">{message.content}</div> : <Markdown compact>{message.content}</Markdown>}
      </div>
      {sources && sources.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {sources.map((s, i) => (
            s.url ? (
              <a key={i} href={s.url} className="no-underline">
                <Badge variant="info" className="text-[9.5px]">{s.tool} · {s.label}</Badge>
              </a>
            ) : (
              <Badge key={i} variant="info" className="text-[9.5px]">{s.tool} · {s.label}</Badge>
            )
          ))}
        </div>
      )}
    </div>
  );
}
```

#### Step 3: Floating bubble component

Create `components/chat/GlobalChatBubble.tsx`:

```tsx
"use client";
import React from "react";
import { GlobalChatPanel } from "./GlobalChatPanel";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";

export function GlobalChatBubble() {
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed cursor-pointer rounded-full shadow-md transition-transform hover:scale-105"
        style={{
          right: 24,
          bottom: 24,
          width: 52,
          height: 52,
          background: "var(--c-accent)",
          color: "var(--c-bg)",
          border: "none",
          zIndex: 50,
          display: "grid",
          placeItems: "center",
        }}
        title={open ? t("chat_close") : t("chat_open")}
      >
        <Ic.chat />
      </button>
      {open && (
        <div
          className="fixed border border-line rounded-md shadow-lg overflow-hidden"
          style={{
            right: 24,
            bottom: 92,
            width: 480,
            height: 620,
            zIndex: 50,
            background: "var(--c-surface)",
          }}
        >
          <GlobalChatPanel scope="bubble" />
        </div>
      )}
    </>
  );
}
```

If `Ic.chat` isn't in [components/shared/Ic.tsx](../../components/shared/Ic.tsx), add a new icon for it. Pick any nearby icon name to match the existing inventory; if no chat-like icon exists, add a minimal `<svg>` with a speech-bubble path.

#### Step 4: Mount in Shell

Read [components/shared/Shell.tsx](../../components/shared/Shell.tsx) (≈100-200 lines) to find the appropriate mount point. Add the import + render:

```tsx
import { GlobalChatBubble } from "@/components/chat/GlobalChatBubble";

// In the return JSX, after the main content area (children):
<GlobalChatBubble />
```

#### Step 5: i18n stubs (placeholder — Task γ.F fills out)

Add these new keys to [lib/i18n.tsx](../../lib/i18n.tsx) (both zh + en, sane defaults):

```ts
// zh
chat_open: "打开追踪助手",
chat_close: "关闭",
chat_context_label: "当前页面",
chat_empty_hint: "问我关于 run / event / audit / 候选人的问题。AI 会用工具查实数据。",
chat_thinking: "AI 思考中…",
chat_input_placeholder: "问任何问题…",
chat_send: "发送",
chat_send_fail: "发送失败",
chat_new_session: "新建会话",

// en
chat_open: "Open tracing assistant",
chat_close: "Close",
chat_context_label: "Current page",
chat_empty_hint: "Ask about runs, events, audits, or candidates. AI calls tools to look up real data.",
chat_thinking: "AI is thinking…",
chat_input_placeholder: "Ask anything…",
chat_send: "Send",
chat_send_fail: "Send failed",
chat_new_session: "New session",
```

#### Step 6: Build + visual smoke

Run `npm run build`. Then `npm run dev` and verify:
- Floating button bottom-right on `/`, `/monitor`, `/rule-check`, etc.
- Click → drawer pops up, page context line shows
- Click a suggestion → POSTs `/api/chat/trace` (will succeed if LLM gateway configured, else fail soft with the gateway-not-configured reply)
- Close button works

#### Step 7: Commit

```bash
git commit -m "feat(chat): floating GlobalChatBubble + Shell mount + page context" -- \
  lib/chat/page-context.ts \
  components/chat/GlobalChatPanel.tsx \
  components/chat/GlobalChatBubble.tsx \
  components/shared/Shell.tsx \
  components/shared/Ic.tsx \
  lib/i18n.tsx
```

(Only include `Ic.tsx` if you added a chat icon.)

---

## Chunk 5: `/chat` full-screen page

### Task γ.E: `/chat` page + history sidebar + LeftNav entry

**Files:**
- Create: `app/chat/page.tsx`
- Create: `components/chat/GlobalChatFullContent.tsx`
- Create: `components/chat/HistoryList.tsx`
- Modify: `components/shared/LeftNav.tsx` (or wherever the nav is defined)

#### Step 1: Page entry

Create `app/chat/page.tsx`:

```tsx
"use client";
import { Shell } from "@/components/shared/Shell";
import { GlobalChatFullContent } from "@/components/chat/GlobalChatFullContent";
import { useApp } from "@/lib/i18n";

export default function ChatPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_trace_chat")]} directionTag={t("chat_direction_tag")}>
      <GlobalChatFullContent />
    </Shell>
  );
}
```

#### Step 2: Full-screen layout

Create `components/chat/GlobalChatFullContent.tsx`:

```tsx
"use client";
import React from "react";
import { GlobalChatPanel } from "./GlobalChatPanel";
import { HistoryList } from "./HistoryList";

export function GlobalChatFullContent() {
  return (
    <div className="flex-1 flex min-w-0 overflow-hidden">
      <aside className="border-r border-line bg-panel overflow-auto" style={{ width: 220, flexShrink: 0 }}>
        <HistoryList />
      </aside>
      <div className="flex-1 min-w-0">
        <GlobalChatPanel scope="full" />
      </div>
    </div>
  );
}
```

#### Step 3: History sidebar

Create `components/chat/HistoryList.tsx`:

```tsx
"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { useGlobalChat } from "@/lib/chat/use-global-chat";
import { Btn } from "@/components/shared/atoms";

export function HistoryList() {
  const { t } = useApp();
  const chat = useGlobalChat();

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-line flex items-center justify-between" style={{ padding: "10px 12px" }}>
        <span className="text-[12px] font-medium text-ink-1">{t("chat_history_title")}</span>
        <Btn size="sm" onClick={chat.newSession} title={t("chat_new_session")}>+</Btn>
      </div>
      <div className="flex-1 overflow-auto">
        {chat.sessions.length === 0 && (
          <div className="text-[11px] text-ink-3 text-center" style={{ padding: "16px 12px" }}>
            {t("chat_history_empty")}
          </div>
        )}
        {chat.sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => chat.switchSession(s.id)}
            className="w-full text-left border-b border-line bg-transparent hover:bg-surface cursor-pointer"
            style={{ padding: "8px 12px" }}
          >
            <div className="text-[12px] text-ink-1 truncate">{s.title}</div>
            <div className="text-[10.5px] text-ink-3 mono">{new Date(s.updatedAt).toLocaleString("zh-CN", { hour12: false })}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
```

#### Step 4: LeftNav entry

Read [components/shared/LeftNav.tsx](../../components/shared/LeftNav.tsx) (or whichever file defines the left-nav items — look for `nav_overview`/`nav_monitor` references).

Add a nav item under the `运营` (`nav_group_operate`) group, after `Monitor`:

```ts
{ href: "/chat", icon: "chat", label: t("nav_trace_chat") }
```

(Adapt to the existing data shape — could be JSX or a config object.)

#### Step 5: Add the two i18n keys

In [lib/i18n.tsx](../../lib/i18n.tsx):

```ts
// zh
nav_trace_chat: "追踪助手",
chat_direction_tag: "Direction D — 跨域追踪",
chat_history_title: "会话历史",
chat_history_empty: "暂无历史会话",

// en
nav_trace_chat: "Tracing Assistant",
chat_direction_tag: "Direction D — Cross-domain tracing",
chat_history_title: "Session history",
chat_history_empty: "No history yet",
```

#### Step 6: Build + visual smoke

`npm run build` → clean.
`npm run dev` → open http://localhost:3002/chat → sidebar visible, can switch between sessions, page renders inside Shell with breadcrumb.

#### Step 7: Commit

```bash
git commit -m "feat(chat): /chat full-screen page + history sidebar + LeftNav entry" -- \
  app/chat/page.tsx \
  components/chat/GlobalChatFullContent.tsx \
  components/chat/HistoryList.tsx \
  components/shared/LeftNav.tsx \
  lib/i18n.tsx
```

---

## Chunk 6: i18n + polish + final E2E

### Task γ.F: Sweep + polish + final review

**Files:**
- Modify: any chat-related files where Chinese leaked
- Modify: `lib/i18n.tsx` for any missing keys

#### Step 1: Grep for hardcoded Chinese in new chat files

```bash
grep -nE "[一-龥]" \
  components/chat/*.tsx \
  lib/chat/*.ts \
  app/chat/page.tsx \
  app/api/chat/trace/route.ts \
  lib/chat/global-chat-system-prompt.ts
```

The `global-chat-system-prompt.ts` is allowed to contain Chinese (it's prompt content, not chrome). All OTHER files should have ZERO Chinese in JSX strings / titles / placeholders.

For each hit outside `global-chat-system-prompt.ts` that's a JSX/prop string, swap to `t()` and add a new key in both zh + en if not already present.

#### Step 2: Verify pageContext labels are translated

The bubble's `chat_context_label` line builds a string like `· run ABC · audit XYZ`. The labels `run` / `audit` / entityType are intentionally code/data. Confirm they're not getting routed through `t()` accidentally — they should stay as-is. (Memo: in this codebase, entity type and ID values are data, not chrome.)

#### Step 3: Final build + verification

```bash
npm test -- lib/chat
npm test -- app/api/chat/trace
npm run build
```

All green.

#### Step 4: Final E2E walkthrough

`npm run dev` and walk through:

1. **Bubble on every route:**
   - `/` — bubble visible bottom-right
   - `/monitor` — bubble visible
   - `/rule-check` — bubble visible
   - `/workflow` — bubble visible
   - `/chat` — bubble may be hidden on the full-page (acceptable; verify your Shell mount doesn't render the bubble on `/chat`). If desired, add a check in `GlobalChatBubble` to skip rendering when `pathname === "/chat"`.

2. **Page context auto-injection:**
   - Open `/monitor?run=R-xxx` (use a real run from the DB or just append `?run=test`) → open bubble → context line shows `· run test`.
   - Open `/rule-check?view=audits&auditId=A-xxx` → context shows `· audit A-xxx`.
   - Test: ask "this run's status?" — system prompt should include the run id, so the LLM's first move is `getRunDetail({ runId: "R-xxx" })`.

3. **Multi-session via `/chat`:**
   - Open `/chat` → new session, ask something → reply lands → click `+` → new session → ask different question → switch back via sidebar → first session's messages still there.
   - Refresh page → sessions persist.

4. **Tool dispatch:**
   - Ask "字节跳动最近 24h 几条 audit 失败?" → reply contains a number, sources include `searchAudits · FAIL · 字节跳动`.
   - Ask "DLQ 现在有多少条?" → reply with number, source `searchDLQ`.

5. **Bilingual:**
   - Switch lang to `en` → all chat UI text in English.
   - Send English question → AI replies in English (per system prompt rule).
   - Switch back to zh.

6. **Fail-soft:**
   - Unset `OPENAI_API_KEY` (or whatever the env var name is) in `.env.local`, restart dev → bubble still renders, but on send shows "LLM gateway 未配置 · 请联系管理员设置 OPENAI_API_KEY 或等价 env。"

#### Step 5: Commit any final fixes

```bash
git commit -m "feat(chat): i18n sweep + final polish" -- <changed-files>
```

#### Step 6: Final reviewer dispatch

This is the cross-cutting final reviewer step — handled by the orchestrator (subagent-driven-development), not the implementer.

---

## Notes for the implementer

- **DRY:** `GlobalChatPanel` is shared between bubble and full-page surfaces. Don't fork it.
- **YAGNI:** Don't add streaming, multi-agent collaboration, write tools, RBAC, PII redaction — all explicitly out of scope per spec.
- **Read existing chat patterns first:** `app/api/agents/[short]/chat/route.ts` is the canonical reference. Mirror its tool-loop shape exactly.
- **Tool implementations:** if the Prisma schema field doesn't match what's in the plan code (e.g. `agentName` vs `agent`, `runId` vs `id`, `tokenUsage` shape), read `prisma/schema.prisma` and adjust BOTH the tool code AND the test mock together — tests should describe the real shape.
- **Neo4j adapter:** `searchEntitiesNeo4j` may not exist in `lib/allmeta-client.ts`. If absent, add a thin helper in that file rather than dropping the dependency.
- **Commit cadence:** one commit per task (γ.A through γ.F = 6 commits expected).
- **Test coverage:** TDD applies to Chunks 1, 2, 3 (pure logic). Chunks 4 and 5 are UI — verified visually.
- **i18n discipline:** every visible string in zh AND en dictionaries simultaneously. Don't punt to "fix in a later task" — sweep at each task's end.
- **No raw Cypher tool in v1:** the `runReadOnlyCypher` debug escape hatch from the spec (gated by `AO_CHAT_RAW_CYPHER=1`) is explicitly NOT in this plan. If the spec author wants it, it's a separate task.
