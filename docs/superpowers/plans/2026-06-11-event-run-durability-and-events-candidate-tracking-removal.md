# Event/Run durability (write-through) + remove events candidate-tracking — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Inngest event and every agent run survive an Inngest restart by persisting them in-process the moment they happen (write-through), and remove the candidate-tracking tab from the `/events` page.

**Architecture:** Add one Inngest `Middleware.BaseMiddleware` subclass attached to both Inngest clients. Its hooks write into the **existing** Postgres archive tables (`InngestEventArchive` / `InngestRunArchive` / `InngestStepArchive`) that the events/monitor UI already reads from via `lib/inngest-source.ts`, reusing the existing writer/mappers. The 30s poller stays as an idempotent reconciliation backstop. Part B is a self-contained UI removal.

**Tech Stack:** Next.js 16 / React 19, Inngest SDK **4.3.0** (`Middleware.BaseMiddleware` API), Prisma 7 → local Postgres, vitest. Spec: [docs/superpowers/specs/2026-06-11-event-run-durability-writethrough-and-events-candidate-tracking-removal-design.md](../specs/2026-06-11-event-run-durability-writethrough-and-events-candidate-tracking-removal-design.md).

---

## Key facts (verified against the codebase — do not re-derive)

- **Middleware API (4.3.0):** `import { Middleware } from "inngest"`. Subclass `Middleware.BaseMiddleware`; pass the **class** (not an instance) via `new Inngest({ middleware: [WriteThroughMiddleware] })` ([node_modules/inngest/types.d.ts:771](../../../node_modules/inngest/types.d.ts) — `middleware?: Middleware.Class[]`). Hooks (all may be `async`, all receive deep-readonly args, must NOT throw or mutate args):
  - `onRunStart({ ctx, fn })` — once per run, very first request (0 memoized steps, attempt 0).
  - `onRunComplete({ ctx, fn, output })` — run succeeded; `output` is the function return value.
  - `onRunError({ ctx, fn, error, isFinalAttempt })` — run threw; only terminal when `isFinalAttempt === true`.
  - `wrapSendEvent({ events, fn, next })` — wraps every `inngest.send()` / `step.sendEvent`; must `await next()` (returns `{ ids: string[] }`) and return it.
  - `ctx` = `{ runId: string, event: {name,data,id?,ts?}, events, attempt }` ([types.d.ts:397-422](../../../node_modules/inngest/types.d.ts)). `fn.id()` → bare function id; `fn.name` → display name ([InngestFunction.d.ts:42,51](../../../node_modules/inngest/components/InngestFunction.d.ts)). `this.client` is the Inngest client.
- **Function slug format** is app-prefixed: `${client.id}-${fn.id()}` (confirmed by [lib/inngest-source.test.ts:38](../../../lib/inngest-source.test.ts#L38) showing `agentic-operator-能源调度-v1-<id>`). Calibrated in Task A0.
- **Two Inngest clients:** main at [server/inngest/client.ts:496](../../../server/inngest/client.ts#L496) (`id: "agentic-operator-main"`); per-domain at [server/inngest/domain-app.ts:140](../../../server/inngest/domain-app.ts#L140) (`id: domainAppId(domain)`). Middleware must attach to BOTH.
- **Writer surface to reuse** ([lib/inngest-archive/writer.ts](../../../lib/inngest-archive/writer.ts)): `archiveEvents(events: InngestEvent[])` (insert, `skipDuplicates`), `archiveRunTrace(runId, history)` (tx: set `traceFetched=true`, replace step rows). Mapper helpers `toDate`, `safeJson` are exported from [lib/inngest-archive/mappers.ts](../../../lib/inngest-archive/mappers.ts).
- **`InngestRunArchive` columns** ([prisma/schema.prisma](../../../prisma/schema.prisma) ~940): `runId @id`, `functionSlug`, `functionName?`, `status`, `startedAt?`, `endedAt?`, `durationMs?`, `eventName?`, `triggerEventIds` (JSON string of `[id]`), `eventPayload?`, `output?`, `flowId?`, `traceFetched @default(false)`. `output` is set by `runToUpdate`? **No** — `runToUpdate` does NOT write `output`; write-through must write `output` itself (that's why run-finish uses a direct upsert, not `upsertRun`).
- **Reader gating:** `getRunStepOutputs` only returns steps when `traceFetched=true` ([reader.ts:116](../../../lib/inngest-archive/reader.ts#L116)); steps are ordered by the numeric index in id `${runId}#<i>` ([reader.ts:38,76](../../../lib/inngest-archive/reader.ts#L38)). Therefore write-through reuses `archiveRunTrace` (which produces `#${i}` ids) instead of hand-writing step rows.
- **Poller skip behavior:** the archiver only fetches a trace for terminal runs with `traceFetched=false` ([scripts/inngest-archiver.ts](../../../scripts/inngest-archiver.ts)). Once write-through sets `traceFetched=true`, the poller skips that run's trace — no conflict.

---

## Chunk 1: Write-through durability (Part A)

### Task A0: Calibrate slug + client.id + verify hooks fire (no code, verification only)

**Goal:** Confirm `${this.client.id}-${fn.id()}` equals the canonical slug, and that `this.client.id` is readable, BEFORE writing code that depends on it.

- [ ] **Step 1: Read the canonical slug from the existing API**

Run (dev server must be up on :3002, or start it):
```bash
curl -s localhost:3002/api/inngest-admin/functions | head -c 2000
```
Expected: JSON listing functions with `slug` values like `agentic-operator-main-resume-parser-agent`. Note the exact prefix for the main app and one domain app.

- [ ] **Step 2: Confirm `client.id` is accessible**

Run:
```bash
node -e "const {Inngest}=require('inngest'); const c=new Inngest({id:'x'}); console.log('client.id =', c.id)"
```
Expected: `client.id = x`. If it prints `undefined`, record that — Task A3 must import a shared `APP_ID` constant instead of `this.client.id`.

- [ ] **Step 3: Decide the slug formula.** If Step 1's slug === `${clientId}-${fnId}`, use `\`${this.client.id}-${fn.id()}\``. If it is slugified differently (e.g. lowercased), import and use `slugify` from `inngest` on each part. Record the final formula in a comment for Task A3.

---

### Task A1: Write-through DB helpers — events + run start/finish

**Files:**
- Create: `lib/inngest-archive/write-through.ts`
- Test: `lib/inngest-archive/write-through.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/inngest-archive/write-through.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../server/db", () => ({
  prisma: {
    inngestRunArchive: { upsert: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock("./writer", () => ({ archiveEvents: vi.fn(), archiveRunTrace: vi.fn() }));
vi.mock("../inngest-admin-client", () => ({ getRunHistory: vi.fn() }));

import { prisma } from "../../server/db";
import { archiveEvents } from "./writer";
import { recordSentEvents, recordRunStart, recordRunFinish } from "./write-through";

beforeEach(() => vi.clearAllMocks());

describe("recordSentEvents", () => {
  it("zips payloads with returned ids and forwards to archiveEvents", async () => {
    await recordSentEvents([{ name: "A", data: { x: 1 } }, { name: "B" }], ["id1", "id2"]);
    expect(archiveEvents).toHaveBeenCalledWith([
      expect.objectContaining({ id: "id1", name: "A", data: { x: 1 } }),
      expect.objectContaining({ id: "id2", name: "B" }),
    ]);
  });
  it("drops payloads with no matching id", async () => {
    await recordSentEvents([{ name: "A" }, { name: "B" }], ["id1"]);
    const arg = (archiveEvents as any).mock.calls[0][0];
    expect(arg).toHaveLength(1);
    expect(arg[0].id).toBe("id1");
  });
});

describe("recordRunStart", () => {
  it("upserts a Running row; update path never changes status", async () => {
    await recordRunStart({ runId: "r1", functionSlug: "app-fn", functionName: "Fn",
      startedAtIso: "2026-06-11T00:00:00.000Z", eventName: "evt", eventId: "e1" });
    const call = (prisma.inngestRunArchive.upsert as any).mock.calls[0][0];
    expect(call.where).toEqual({ runId: "r1" });
    expect(call.create).toMatchObject({ runId: "r1", functionSlug: "app-fn", status: "Running",
      eventName: "evt", triggerEventIds: JSON.stringify(["e1"]) });
    expect(call.update).not.toHaveProperty("status"); // start must not downgrade a finished run
  });
});

describe("recordRunFinish", () => {
  it("writes terminal status + output + duration from stored startedAt", async () => {
    (prisma.inngestRunArchive.findUnique as any).mockResolvedValue({
      startedAt: new Date("2026-06-11T00:00:00.000Z") });
    await recordRunFinish({ runId: "r1", functionSlug: "app-fn", functionName: "Fn",
      status: "Completed", finishedAtIso: "2026-06-11T00:00:02.000Z", output: { ok: true },
      eventName: "evt", eventId: "e1" });
    const call = (prisma.inngestRunArchive.upsert as any).mock.calls[0][0];
    expect(call.update).toMatchObject({ status: "Completed", durationMs: 2000,
      output: JSON.stringify({ ok: true }) });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- write-through`
Expected: FAIL — `Cannot find module './write-through'`.

- [ ] **Step 3: Implement `lib/inngest-archive/write-through.ts`**

```ts
// Write-through persistence: archive Inngest events/runs into Postgres at the
// moment they happen (called from the Inngest middleware), so nothing is lost
// when the ephemeral Inngest dev server restarts. Writes the SAME archive tables
// the 30s poller writes, idempotently — the poller is now a reconciliation net.
import { prisma } from "../../server/db";
import type { InngestEvent } from "../inngest-admin-client";
import { getRunHistory } from "../inngest-admin-client";
import { archiveEvents, archiveRunTrace } from "./writer";
import { toDate, safeJson, type RunHistory } from "./mappers";

/** Persist freshly-sent events. `ids` come from inngest.send()'s return value. */
export async function recordSentEvents(
  payloads: { name: string; data?: unknown; ts?: number }[],
  ids: string[],
): Promise<number> {
  const events: InngestEvent[] = payloads
    .map((p, i) => ({ id: ids[i], name: p.name, data: p.data ?? null, ts: p.ts }))
    .filter((e): e is InngestEvent => Boolean(e.id));
  if (events.length === 0) return 0;
  return archiveEvents(events);
}

/** Create the run row as Running on its first request. Never downgrades status. */
export async function recordRunStart(args: {
  runId: string; functionSlug: string; functionName: string;
  startedAtIso: string; eventName?: string; eventId?: string;
}): Promise<void> {
  const startedAt = toDate(args.startedAtIso);
  await prisma.inngestRunArchive.upsert({
    where: { runId: args.runId },
    create: {
      runId: args.runId, functionSlug: args.functionSlug, functionName: args.functionName,
      status: "Running", startedAt,
      eventName: args.eventName ?? null,
      triggerEventIds: args.eventId ? JSON.stringify([args.eventId]) : null,
    },
    // Row already exists (e.g. poller raced): refresh metadata, leave status alone.
    update: { functionSlug: args.functionSlug, functionName: args.functionName, startedAt },
  });
}

/** Write the terminal status + output directly (lossless, no network). */
export async function recordRunFinish(args: {
  runId: string; functionSlug: string; functionName: string;
  status: "Completed" | "Failed" | "Cancelled";
  finishedAtIso: string; output: unknown;
  eventName?: string; eventId?: string;
}): Promise<void> {
  const endedAt = toDate(args.finishedAtIso);
  const existing = await prisma.inngestRunArchive.findUnique({
    where: { runId: args.runId }, select: { startedAt: true },
  });
  const durationMs = existing?.startedAt && endedAt
    ? endedAt.getTime() - existing.startedAt.getTime() : null;
  const output = safeJson(args.output);
  const eventName = args.eventName ?? null;
  const triggerEventIds = args.eventId ? JSON.stringify([args.eventId]) : null;
  await prisma.inngestRunArchive.upsert({
    where: { runId: args.runId },
    create: {
      runId: args.runId, functionSlug: args.functionSlug, functionName: args.functionName,
      status: args.status, endedAt, durationMs, output, eventName, triggerEventIds,
    },
    update: { status: args.status, endedAt, durationMs, output, eventName },
  });
}

/**
 * Immediately snapshot the run's step trace (steps were recorded by Inngest in
 * prior requests, so they're available now). Reuses archiveRunTrace (canonical
 * `#${i}` step ids, sets traceFetched=true). Status/output are FORCED to the
 * known-terminal values so a not-yet-terminal live fetch can't clobber them.
 * Best-effort: on any failure the row stays traceFetched=false and the poller
 * backstops the steps.
 */
export async function captureRunTrace(args: {
  runId: string; status: string; output: unknown; finishedAtIso: string;
}): Promise<number> {
  const history = (await getRunHistory(args.runId)) as RunHistory | null;
  if (!history) return 0;
  return archiveRunTrace(args.runId, {
    ...history, status: args.status, output: args.output, finishedAt: args.finishedAtIso,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- write-through`
Expected: PASS (all `recordSentEvents` / `recordRunStart` / `recordRunFinish` cases).

- [ ] **Step 5: Commit**

```bash
git add lib/inngest-archive/write-through.ts lib/inngest-archive/write-through.test.ts
git commit -m "feat(archive): write-through DB helpers for events + run start/finish" -- lib/inngest-archive/write-through.ts lib/inngest-archive/write-through.test.ts
```

---

### Task A2: Test `captureRunTrace` forces terminal status/output

**Files:**
- Modify: `lib/inngest-archive/write-through.test.ts`

- [ ] **Step 1: Add the failing test**

```ts
import { archiveRunTrace } from "./writer";
import { getRunHistory } from "../inngest-admin-client";
import { captureRunTrace } from "./write-through";

describe("captureRunTrace", () => {
  it("overrides live status/output with known-terminal values before archiving", async () => {
    (getRunHistory as any).mockResolvedValue({
      id: "r1", status: "Running", output: null, function: { name: "Fn", slug: "app-fn" },
      startedAt: "2026-06-11T00:00:00.000Z", steps: [], event: undefined });
    await captureRunTrace({ runId: "r1", status: "Completed", output: { ok: true },
      finishedAtIso: "2026-06-11T00:00:02.000Z" });
    expect(archiveRunTrace).toHaveBeenCalledWith("r1",
      expect.objectContaining({ status: "Completed", output: { ok: true },
        finishedAt: "2026-06-11T00:00:02.000Z" }));
  });
  it("no-ops when the run is not in live history", async () => {
    (getRunHistory as any).mockResolvedValue(null);
    expect(await captureRunTrace({ runId: "x", status: "Completed", output: null,
      finishedAtIso: "2026-06-11T00:00:00.000Z" })).toBe(0);
    expect(archiveRunTrace).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect PASS** (captureRunTrace already implemented in A1)

Run: `npm test -- write-through`
Expected: PASS. (If FAIL, fix `captureRunTrace` in write-through.ts.)

- [ ] **Step 3: Commit**

```bash
git add lib/inngest-archive/write-through.test.ts
git commit -m "test(archive): captureRunTrace forces terminal status/output" -- lib/inngest-archive/write-through.test.ts
```

---

### Task A3: The middleware class

**Files:**
- Create: `server/inngest/write-through-middleware.ts`
- Test: `server/inngest/write-through-middleware.test.ts`

- [ ] **Step 1: Write the failing test** (drives hook → helper mapping; mock the write-through module)

```ts
// server/inngest/write-through-middleware.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/inngest-archive/write-through", () => ({
  recordSentEvents: vi.fn(), recordRunStart: vi.fn(),
  recordRunFinish: vi.fn().mockResolvedValue(undefined),
  captureRunTrace: vi.fn().mockResolvedValue(0),
}));
import * as wt from "../../lib/inngest-archive/write-through";
import { WriteThroughMiddleware } from "./write-through-middleware";

const fn = { id: () => "resume-parser-agent", name: "Resume Parser" };
const client = { id: "agentic-operator-main" };
function mw() { return new (WriteThroughMiddleware as any)({ client }); }
beforeEach(() => vi.clearAllMocks());

describe("WriteThroughMiddleware", () => {
  it("onRunStart records a Running row with app-prefixed slug", async () => {
    await mw().onRunStart({ ctx: { runId: "r1", event: { name: "evt", id: "e1" } }, fn });
    expect(wt.recordRunStart).toHaveBeenCalledWith(expect.objectContaining({
      runId: "r1", functionSlug: "agentic-operator-main-resume-parser-agent",
      functionName: "Resume Parser", eventName: "evt", eventId: "e1" }));
  });
  it("onRunComplete records terminal + fires trace capture", async () => {
    await mw().onRunComplete({ ctx: { runId: "r1", event: { name: "evt", id: "e1" } }, fn,
      output: { ok: true } });
    expect(wt.recordRunFinish).toHaveBeenCalledWith(expect.objectContaining({
      runId: "r1", status: "Completed", output: { ok: true } }));
    expect(wt.captureRunTrace).toHaveBeenCalledWith(expect.objectContaining({
      runId: "r1", status: "Completed" }));
  });
  it("onRunError ignores non-final attempts", async () => {
    await mw().onRunError({ ctx: { runId: "r1", event: {} }, fn,
      error: new Error("x"), isFinalAttempt: false });
    expect(wt.recordRunFinish).not.toHaveBeenCalled();
  });
  it("onRunError records Failed on the final attempt", async () => {
    await mw().onRunError({ ctx: { runId: "r1", event: { name: "evt" } }, fn,
      error: new Error("boom"), isFinalAttempt: true });
    expect(wt.recordRunFinish).toHaveBeenCalledWith(expect.objectContaining({ status: "Failed" }));
  });
  it("wrapSendEvent returns next()'s output and records events with ids", async () => {
    const next = vi.fn().mockResolvedValue({ ids: ["id1"] });
    const out = await mw().wrapSendEvent({ events: [{ name: "A", data: { x: 1 } }], next });
    expect(out).toEqual({ ids: ["id1"] });
    expect(wt.recordSentEvents).toHaveBeenCalledWith([{ name: "A", data: { x: 1 }, ts: undefined }],
      ["id1"]);
  });
  it("a failing recorder never breaks the send", async () => {
    (wt.recordSentEvents as any).mockRejectedValue(new Error("db down"));
    const next = vi.fn().mockResolvedValue({ ids: ["id1"] });
    await expect(mw().wrapSendEvent({ events: [{ name: "A" }], next })).resolves.toEqual({ ids: ["id1"] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- write-through-middleware`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/inngest/write-through-middleware.ts`**

> Use the slug formula decided in Task A0. If `this.client.id` was `undefined` in A0, import a shared `APP_ID` and substitute it for `this.client.id`.

```ts
// Inngest middleware: write-through persistence of events + runs into the
// Postgres archive, in-process, the instant they happen. Hooks are best-effort
// and MUST never throw into a run or send. See lib/inngest-archive/write-through.ts.
import { Middleware } from "inngest";
import {
  recordSentEvents, recordRunStart, recordRunFinish, captureRunTrace,
} from "../../lib/inngest-archive/write-through";

function warn(where: string, e: unknown) {
  console.warn(`[write-through] ${where}:`, e instanceof Error ? e.message : e);
}

export class WriteThroughMiddleware extends Middleware.BaseMiddleware {
  readonly id = "ao-write-through";

  private slug(fn: { id: () => string }): string {
    return `${this.client.id}-${fn.id()}`;
  }

  async onRunStart({ ctx, fn }: Middleware.OnRunStartArgs) {
    try {
      await recordRunStart({
        runId: ctx.runId, functionSlug: this.slug(fn), functionName: fn.name,
        startedAtIso: new Date().toISOString(),
        eventName: ctx.event?.name, eventId: (ctx.event as { id?: string })?.id,
      });
    } catch (e) { warn("onRunStart", e); }
  }

  async onRunComplete({ ctx, fn, output }: Middleware.OnRunCompleteArgs) {
    const finishedAtIso = new Date().toISOString();
    const slug = this.slug(fn);
    try {
      await recordRunFinish({
        runId: ctx.runId, functionSlug: slug, functionName: fn.name,
        status: "Completed", finishedAtIso, output,
        eventName: ctx.event?.name, eventId: (ctx.event as { id?: string })?.id,
      });
    } catch (e) { warn("onRunComplete", e); }
    void captureRunTrace({ runId: ctx.runId, status: "Completed", output, finishedAtIso })
      .catch((e) => warn("captureRunTrace", e));
  }

  async onRunError({ ctx, fn, error, isFinalAttempt }: Middleware.OnRunErrorArgs) {
    if (!isFinalAttempt) return; // will retry — not terminal yet
    const finishedAtIso = new Date().toISOString();
    const output = { error: { name: error?.name, message: error?.message, stack: error?.stack } };
    try {
      await recordRunFinish({
        runId: ctx.runId, functionSlug: this.slug(fn), functionName: fn.name,
        status: "Failed", finishedAtIso, output,
        eventName: ctx.event?.name, eventId: (ctx.event as { id?: string })?.id,
      });
    } catch (e) { warn("onRunError", e); }
    void captureRunTrace({ runId: ctx.runId, status: "Failed", output, finishedAtIso })
      .catch((e) => warn("captureRunTrace", e));
  }

  async wrapSendEvent({ events, next }: Middleware.WrapSendEventArgs) {
    const out = await next();
    try {
      await recordSentEvents(
        events.map((e) => ({ name: e.name, data: e.data, ts: e.ts })),
        out?.ids ?? [],
      );
    } catch (e) { warn("wrapSendEvent", e); }
    return out;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- write-through-middleware`
Expected: PASS (6 cases).

- [ ] **Step 5: Commit**

```bash
git add server/inngest/write-through-middleware.ts server/inngest/write-through-middleware.test.ts
git commit -m "feat(inngest): write-through middleware (events + run lifecycle)" -- server/inngest/write-through-middleware.ts server/inngest/write-through-middleware.test.ts
```

---

### Task A4: Attach the middleware to both Inngest clients

**Files:**
- Modify: `server/inngest/client.ts:496`
- Modify: `server/inngest/domain-app.ts:140`

- [ ] **Step 1: Main client** — [server/inngest/client.ts:496](../../../server/inngest/client.ts#L496)

Add the import near the top of the file (after existing imports), and the `middleware` option:
```ts
import { WriteThroughMiddleware } from "./write-through-middleware";
// ...
export const inngest = new Inngest({
  id: "agentic-operator-main",
  eventKey: process.env.INNGEST_EVENT_KEY,
  middleware: [WriteThroughMiddleware],
});
```
> Watch for an import cycle: `write-through-middleware` → `lib/inngest-archive/write-through` → `lib/inngest-archive/writer` → `server/db`. None of those import `server/inngest/client`, so there is no cycle. Do NOT let the middleware import the client.

- [ ] **Step 2: Domain client** — [server/inngest/domain-app.ts:140](../../../server/inngest/domain-app.ts#L140)

```ts
c = new Inngest({
  id: domainAppId(domain),
  eventKey: process.env.INNGEST_EVENT_KEY,
  middleware: [WriteThroughMiddleware],
});
```
Add the same import at the top of `domain-app.ts`.

- [ ] **Step 3: Typecheck**

Run: `npm run build` (this runs tsc + lint).
Expected: build succeeds. If TS complains that `ctx.event` is possibly typed without `id`, the `(ctx.event as { id?: string })?.id` cast in the middleware already handles it; fix any remaining type errors minimally.

- [ ] **Step 4: Commit**

```bash
git add server/inngest/client.ts server/inngest/domain-app.ts
git commit -m "feat(inngest): wire write-through middleware into main + domain clients" -- server/inngest/client.ts server/inngest/domain-app.ts
```

---

### Task A5: Integration verification — data survives an Inngest restart

**Goal:** Prove the durability guarantee end-to-end. No new code unless a defect surfaces.

- [ ] **Step 1: Start the stack** — `npm run dev` (Postgres + Inngest + archiver + Next on :3002). Wait for it to be ready.

- [ ] **Step 2: Trigger a short run** via an existing API/event path (e.g. publish a test event through an existing endpoint, or `npm run` a known publish script that goes through `inngest.send`). Confirm in `/events` and `/workflow` that the event + run appear.

- [ ] **Step 3: Query Postgres to confirm write-through wrote rows (not the poller)** — verify BEFORE 30s elapses so the poll hasn't run yet. Use the existing read API:
```bash
curl -s "localhost:3002/api/inngest-admin/runs?limit=5" | head -c 1500
```
Expected: the just-created run present with a terminal status and `output`, within a couple seconds of completion (faster than the 30s poll → proves write-through).

- [ ] **Step 4: Restart Inngest, leave Postgres up.** Kill the inngest-cli process and restart it (native, per repo convention — `pkill -f inngest-cli` then the bootstrap restarts it, or restart `npm run dev`). Do NOT reset Postgres.

- [ ] **Step 5: Confirm the event + run + steps survived**
```bash
curl -s "localhost:3002/api/inngest-admin/runs?limit=5" | head -c 1500
curl -s "localhost:3002/api/events?limit=5" 2>/dev/null | head -c 800
```
Expected: the run and its event are still present (served from the Postgres archive via `inngest-source`), with steps visible in `/workflow` for that run. This is the data that would have been lost before this change.

- [ ] **Step 6: Document the result** in the PR description / commit body with the actual curl output. If anything is missing, debug with superpowers:systematic-debugging before claiming success.

---

## Chunk 2: Remove the candidate-tracking tab from `/events` (Part B)

> Self-contained; depends on nothing in Chunk 1. Keep `app/api/events/candidates/route.ts`, `components/events/PipelineRibbon.tsx`, `lib/events/pipeline-stages.ts`, and `components/entity/EntityJourneyContent.tsx` — the candidate journey page still uses them.

### Task B1: Strip the candidates view from EventsContent

**Files:**
- Modify: `components/events/EventsContent.tsx`

- [ ] **Step 1: Remove the import** — delete [EventsContent.tsx:12](../../../components/events/EventsContent.tsx#L12) `import { CandidateTrackingTab } from "./CandidateTrackingTab";`.

- [ ] **Step 2: Narrow the view union** — [line 80](../../../components/events/EventsContent.tsx#L80):
```ts
const view = (sp.get("view") ?? "stream") as "stream" | "dlq";
```

- [ ] **Step 3: Simplify the ViewToggle value** — [line 165](../../../components/events/EventsContent.tsx#L165) `value={view === "candidates" ? "stream" : view}` → `value={view}`.

- [ ] **Step 4: Remove the toggle button usage** — delete the `<CandidatesToggleBtn ... />` block at [lines 170-174](../../../components/events/EventsContent.tsx#L170).

- [ ] **Step 5: Remove the candidates render branch** — at [lines 238-239](../../../components/events/EventsContent.tsx#L238), drop the `view === "candidates" ? (<CandidateTrackingTab />) :` arm so it falls through to the `dlq` / stream branches.

- [ ] **Step 6: Remove the `CandidatesToggleBtn` component definition** — the local component (around line 920, the one rendering `t("evx_candidate_tracking")`). Grep first to confirm it has no other callers:
```bash
grep -n "CandidatesToggleBtn" components/events/EventsContent.tsx
```
Expected after edits: zero matches. Delete the component definition.

- [ ] **Step 7: Typecheck just this file's area** — `npm run build`. Expected: no references to `candidates`/`CandidateTrackingTab`/`CandidatesToggleBtn` remain.

- [ ] **Step 8: Commit**
```bash
git add components/events/EventsContent.tsx
git commit -m "refactor(events): remove candidate-tracking view from events page" -- components/events/EventsContent.tsx
```

### Task B2: Delete the tab component

- [ ] **Step 1: Delete** `components/events/CandidateTrackingTab.tsx`.
```bash
git rm components/events/CandidateTrackingTab.tsx
```
- [ ] **Step 2: Commit**
```bash
git commit -m "refactor(events): delete CandidateTrackingTab component" -- components/events/CandidateTrackingTab.tsx
```

### Task B3: Remove now-unused i18n keys

**Files:**
- Modify: `lib/i18n.tsx`

- [ ] **Step 1: Confirm the keys are unused after B1/B2**
```bash
grep -rn "em_candidates_\|evx_candidate_tracking" components app lib | grep -v "lib/i18n.tsx"
```
Expected: zero matches (only the dictionary defines them now).

- [ ] **Step 2: Delete the keys** from BOTH the `zh` (~lines 634-647 + the `evx_candidate_tracking` at ~2144) and `en` (~lines 3411-3424 + ~4918) blocks of `lib/i18n.tsx`: every `em_candidates_*` key and `evx_candidate_tracking`. Keep all other keys intact.

- [ ] **Step 3: Typecheck** — `npm run build`. Expected: success (no key referenced anywhere).

- [ ] **Step 4: Commit**
```bash
git add lib/i18n.tsx
git commit -m "chore(i18n): drop unused candidate-tracking event keys (zh+en)" -- lib/i18n.tsx
```

### Task B4: Dead-code + build verification

- [ ] **Step 1: knip** — `npx knip` (per the repo's dead-code workflow). Expected: it does NOT report `app/api/events/candidates/route.ts`, `PipelineRibbon.tsx`, or `lib/events/pipeline-stages.ts` as unused (the journey page still imports them). If it flags genuinely-orphaned leftovers from the removal, delete those too.

- [ ] **Step 2: Full build** — `npm run build`. Expected: clean typecheck + lint.

- [ ] **Step 3: Tests** — `npm test`. Expected: green, including the kept `app/api/events/candidates/route.test.ts`.

---

## Done criteria

- A short run's event + run + steps survive an Inngest restart (Task A5 evidence captured).
- `/events` has no candidates toggle/tab; the candidate journey page (`/entities/candidate/:id`) still shows its pipeline ribbon.
- `npm run build` and `npm test` are green; `npx knip` shows no new orphans.

## Commit/push notes (repo conventions)

- Commit with the pathspec form: `git commit -m "…" -- <files>` (the pre-commit hook re-stages everything otherwise, sweeping in unrelated WIP).
- Do NOT push unless asked. If asked: `git push kenny main:steven --force-with-lease` only — never `origin main` or `kenny main`.
- Work on `main` (no worktrees).
