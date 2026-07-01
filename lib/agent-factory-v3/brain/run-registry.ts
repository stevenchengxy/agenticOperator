// In-process background-run registry. Decouples the autonomous brain from the SSE
// request lifecycle: the conductor runs in a DETACHED driver here, so navigating
// away (which closes the EventSource) no longer aborts it — the run keeps going
// server-side and a later reconnect re-attaches to the live event stream. A stop
// button aborts it explicitly.
//
// Limitation (accepted): in-process, so a dev server restart / HMR ends in-flight
// runs. The transcript is still persisted to FactoryBrainRun every few seconds, so
// a reconnect that finds the run gone but the row still `running` knows it was
// interrupted and can offer 继续 via the durable conversation checkpoint.

import { runBrain } from "./conductor";
import type { BrainEvent, BrainTool } from "./types";
import { prisma } from "@/server/db";

export type RunStatus = "running" | "done" | "error" | "aborted" | "failed";

/** A control frame (run.started) or a brain event delivered to a subscriber. */
type Frame = BrainEvent | { t: "run.started"; runId: string; conversationId: string };
type Subscriber = (e: Frame) => void;

interface ActiveRun {
  runId: string;
  conversationId: string;        // STABLE across a conversation's turns (≠ per-turn runId)
  domain: string;
  goal: string;
  events: BrainEvent[];        // full buffer for replay to late subscribers
  subscribers: Set<Subscriber>;
  status: RunStatus;
  abort: AbortController;
  startedAt: number;
  endedAt?: number;
  // stats accumulated from the stream (drive the finalized FactoryBrainRun row).
  tokensUsed: number;
  turns: number;
  agentsCount: number;
  refineCount: number;
  reachedTerminal: boolean;
  fullChainRan: boolean;
  sawSandbox: boolean;
  sawReflect: boolean;
  sawDone: boolean;
  errorMessage: string | null;
  lastPersist: number;
  evictTimer?: ReturnType<typeof setTimeout>;
}

const runs = new Map<string, ActiveRun>();
const EVICT_AFTER_MS = 10 * 60_000; // keep a finished run replayable for 10 min
const MAX_BUFFER = 8000;            // bound pathological growth
const PERSIST_EVERY_MS = 3_000;     // throttle transcript mirror writes

export function isActiveRun(runId: string): boolean {
  const r = runs.get(runId);
  return !!r && r.status === "running";
}

/** Is the run in the registry at all (running OR recently finished + still replayable)? */
export function hasRun(runId: string): boolean {
  return runs.has(runId);
}

function emit(r: ActiveRun, e: BrainEvent): void {
  if (r.events.length < MAX_BUFFER) r.events.push(e);
  for (const cb of r.subscribers) { try { cb(e); } catch { /* a dead subscriber never blocks the run */ } }
}

/** Subscribe to a run's events. Immediately REPLAYS run.started + the buffered
 *  events (so a late joiner / reconnect sees the whole story so far), then streams
 *  live. Returns an unsubscribe fn, or null if the run isn't in the registry
 *  (caller falls back to the durable FactoryBrainRun transcript). */
export function subscribeRun(runId: string, cb: Subscriber): null | (() => void) {
  const r = runs.get(runId);
  if (!r) return null;
  cb({ t: "run.started", runId, conversationId: r.conversationId });
  for (const e of r.events) cb(e);
  if (r.status !== "running") return () => {}; // finished — buffer already ended with done
  r.subscribers.add(cb);
  return () => { r.subscribers.delete(cb); };
}

/** Abort a run (the stop button). Marks it aborted + signals the conductor, which
 *  breaks at the next turn boundary and runs its cleanup (sandbox teardown etc.). */
export function abortRun(runId: string): boolean {
  const r = runs.get(runId);
  if (!r || r.status !== "running") return false;
  r.status = "aborted";
  try { r.abort.abort(); } catch { /* already aborted */ }
  emit(r, { t: "message", text: "⏹ 已请求停止——大脑会在当前步骤后收尾，已生成的内容都保留。" });
  return true;
}

/** Start (or return the already-active) background run for runId. IDEMPOTENT: a
 *  second connection with the same runId attaches to the SAME run, never starts a
 *  new one. The driver is detached — NOT awaited by the caller's request. */
export function startRun(opts: {
  runId: string; domain: string; goal: string; tools: BrainTool[]; conversationId?: string;
}): ActiveRun {
  const existing = runs.get(opts.runId);
  if (existing) return existing;
  const r: ActiveRun = {
    runId: opts.runId, conversationId: opts.conversationId ?? opts.runId, domain: opts.domain, goal: opts.goal,
    events: [], subscribers: new Set(), status: "running", abort: new AbortController(),
    startedAt: Date.now(), tokensUsed: 0, turns: 0, agentsCount: 0, refineCount: 0,
    reachedTerminal: false, fullChainRan: false, sawSandbox: false, sawReflect: false,
    sawDone: false, errorMessage: null, lastPersist: 0,
  };
  runs.set(opts.runId, r);
  void drive(r, opts.tools, opts.conversationId);
  return r;
}

async function drive(r: ActiveRun, tools: BrainTool[], conversationId?: string): Promise<void> {
  let lastDoneStatus: string = "incomplete";
  try {
    for await (const ev of runBrain({
      domain: r.domain, goal: r.goal, tools,
      signal: r.abort.signal, runId: r.runId, conversationId: conversationId ?? r.runId,
    })) {
      if (ev.t === "reflect") r.sawReflect = true;
      else if (ev.t === "agent.created") r.agentsCount++;
      else if (ev.t === "refine") r.refineCount++;
      else if (ev.t === "sandbox") { r.sawSandbox = true; r.reachedTerminal = ev.reachedTerminal; r.fullChainRan = ev.fullChainRan ?? false; }
      else if (ev.t === "done") {
        r.sawDone = true;
        r.turns = ev.turns; r.tokensUsed = ev.tokensUsed; lastDoneStatus = ev.status;
        // Honest terminal status:
        //   · errored                → error
        //   · finished + ≥1 agent    → done (clean generation success)
        //   · 0 agents + no sandbox  → done (an INFO / chat / Q&A turn — answering a
        //                              question is a success, NOT a failed generation)
        //   · otherwise (had agents / ran sandbox but didn't cleanly finish) → failed
        if (ev.status === "errored") {
          if (r.status === "running") r.status = "error";
          if (!r.errorMessage) r.errorMessage = `run errored (status=${ev.status})`;
        } else if (ev.status === "finished" && r.agentsCount > 0) {
          /* clean success → resolves to "done" below */
        } else if (r.agentsCount === 0 && !r.sawSandbox) {
          /* info/chat/Q&A turn → resolves to "done" below (not a failure) */
        } else {
          if (r.status === "running") r.status = "failed";
          if (!r.errorMessage) r.errorMessage = `run ended without a clean finish (status=${ev.status}, agents=${r.agentsCount})`;
        }
      } else if (ev.t === "error") {
        if (r.status === "running") r.status = "error";
        r.errorMessage = ev.message;
      }
      emit(r, ev);
      await maybePersist(r);
    }
    if (r.status === "running") r.status = "done";
  } catch (e) {
    if (r.status === "running") r.status = r.abort.signal.aborted ? "aborted" : "error";
    r.errorMessage = (e as Error).message;
    if (!r.abort.signal.aborted) emit(r, { t: "error", message: (e as Error).message });
  } finally {
    // Fail-safe cross-run reflection (ported from the route): if the brain made
    // progress but wrote no reflection, synthesize one so the next run for this
    // domain isn't amnesiac. The conductor already writes one in most paths (which
    // sets sawReflect via the reflect event), so this is a genuine backstop only.
    if (!r.sawReflect && r.agentsCount > 0) {
      const kind = r.fullChainRan ? "success" : r.sawSandbox ? "failure" : "caveat";
      const lesson = !r.sawSandbox
        ? "下次为该域生成时：finish 前必须先 sandbox_run 真实跑通【全部】agent 的事件链；否则 agent 设计的对错只是纸面假设。"
        : !r.fullChainRan
          ? `${r.refineCount} 次 refine 仍未全链路跑通(只部分 agent 真跑)。下次：先用 verify_chain 确定性定位断点再定向修;数据/环境无法跑通就诚实记 failure。`
          : "首次 design + 沙箱即全链路跑通；可以尝试更精炼的事件链结构或并行执行。";
      const summary = `${r.agentsCount} agent · ${r.refineCount} refine · sandbox ${!r.sawSandbox ? "未跑" : r.fullChainRan ? "全链路跑通" : "未全链路跑通"} · ${r.turns}t / ${Math.round(r.tokensUsed / 1000)}k`;
      const rootCause = r.sawSandbox && !r.fullChainRan ? "事件链未全链路跑通(部分 agent 未触发,trigger/emit 对不齐或数据触发失败分支)" : null;
      try { await writeReflectionRow(r.domain, kind, summary, rootCause, lesson); emit(r, { t: "reflect", kind, lesson }); }
      catch (e) { console.error("[run-registry] fail-safe reflection failed:", (e as Error).message); }
    }
    // Guarantee a terminal `done` so any subscriber unblocks even on abort/crash.
    if (!r.sawDone) {
      const status: Extract<BrainEvent, { t: "done" }>["status"] =
        r.status === "aborted" ? "incomplete" : r.status === "error" ? "errored" : "incomplete";
      emit(r, { t: "done", tokensUsed: r.tokensUsed, turns: r.turns, status });
      lastDoneStatus = status;
    }
    r.endedAt = Date.now();
    if (r.status === "running") r.status = "done";
    await finalizeBrainRun(r.runId, {
      status: r.status === "aborted" ? "aborted" : r.status === "done" ? "done" : r.status === "error" ? "error" : "failed",
      tokensUsed: r.tokensUsed, turns: r.turns, agentsCount: r.agentsCount,
      reachedTerminal: r.reachedTerminal, errorMessage: r.errorMessage,
      transcript: JSON.stringify(r.events.slice(0, MAX_BUFFER)),
    });
    void lastDoneStatus;
    scheduleEvict(r);
  }
}

function scheduleEvict(r: ActiveRun): void {
  if (r.evictTimer) clearTimeout(r.evictTimer);
  r.evictTimer = setTimeout(() => { if (runs.get(r.runId) === r) runs.delete(r.runId); }, EVICT_AFTER_MS);
}

async function maybePersist(r: ActiveRun): Promise<void> {
  const now = Date.now();
  if (now - r.lastPersist < PERSIST_EVERY_MS) return;
  r.lastPersist = now;
  // Best-effort mid-run mirror so a crash/restart leaves a recent transcript.
  await updateBrainRunTranscript(r.runId, JSON.stringify(r.events.slice(0, MAX_BUFFER)), r.agentsCount).catch(() => {});
}

// ── FactoryBrainRun persistence (typed-then-raw-SQL, ported from the route) ─────
// HMR doesn't reload the generated Prisma client until `npm run dev` restarts, so
// the typed factoryBrainRun accessor may be missing on a long-lived dev process —
// fall back to raw SQL against the underlying table.
type BrainRunClient = {
  factoryBrainRun?: {
    create: (a: { data: { id: string; domain: string; goal: string; status: string } }) => Promise<unknown>;
    update: (a: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
};

export async function createBrainRun(domain: string, goal: string): Promise<string> {
  const id = "fbr_" + Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  try {
    const pc = prisma as unknown as BrainRunClient;
    if (pc.factoryBrainRun?.create) {
      await pc.factoryBrainRun.create({ data: { id, domain, goal, status: "running" } });
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "FactoryBrainRun" ("id","domain","goal","status","createdAt","updatedAt") VALUES ($1,$2,$3,'running',NOW(),NOW())`,
        id, domain, goal,
      );
    }
  } catch (e) {
    console.error("[run-registry] createBrainRun failed (continuing):", (e as Error).message);
  }
  return id;
}

async function updateBrainRunTranscript(id: string, transcript: string, agentsCount: number): Promise<void> {
  const pc = prisma as unknown as BrainRunClient;
  if (pc.factoryBrainRun?.update) {
    await pc.factoryBrainRun.update({ where: { id }, data: { transcript, agentsCount } });
  } else {
    await prisma.$executeRawUnsafe(`UPDATE "FactoryBrainRun" SET "transcript"=$2,"agentsCount"=$3,"updatedAt"=NOW() WHERE "id"=$1`, id, transcript, agentsCount);
  }
}

async function finalizeBrainRun(
  id: string,
  f: { status: string; tokensUsed: number; turns: number; agentsCount: number; reachedTerminal: boolean; errorMessage: string | null; transcript: string },
): Promise<void> {
  try {
    const pc = prisma as unknown as BrainRunClient;
    if (pc.factoryBrainRun?.update) {
      await pc.factoryBrainRun.update({ where: { id }, data: {
        status: f.status, tokensUsed: f.tokensUsed, turns: f.turns, agentsCount: f.agentsCount,
        reachedTerminal: f.reachedTerminal, errorMessage: f.errorMessage, transcript: f.transcript,
      } });
    } else {
      await prisma.$executeRawUnsafe(
        `UPDATE "FactoryBrainRun" SET "status"=$2,"tokensUsed"=$3,"turns"=$4,"agentsCount"=$5,"reachedTerminal"=$6,"errorMessage"=$7,"transcript"=$8,"updatedAt"=NOW() WHERE "id"=$1`,
        id, f.status, f.tokensUsed, f.turns, f.agentsCount, f.reachedTerminal, f.errorMessage, f.transcript,
      );
    }
  } catch (e) {
    console.error("[run-registry] finalizeBrainRun failed:", (e as Error).message);
  }
}

/** Mark a durable FactoryBrainRun row as 'aborted' when it's ORPHANED — the row still
 *  says 'running' but no live driver exists (the server restarted / HMR wiped the
 *  in-process registry). /stop calls this when abortRun() finds nothing in the
 *  registry, so a stuck "运行中" the user can't otherwise stop actually clears.
 *  Returns true if a running row was flipped. */
export async function forceFinalizeAborted(runId: string): Promise<boolean> {
  if (!runId) return false;
  try {
    const pc = prisma as unknown as { factoryBrainRun?: { updateMany: (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }> } };
    if (pc.factoryBrainRun?.updateMany) {
      const r = await pc.factoryBrainRun.updateMany({ where: { id: runId, status: "running" }, data: { status: "aborted" } });
      return r.count > 0;
    }
    const n = await prisma.$executeRawUnsafe(`UPDATE "FactoryBrainRun" SET "status"='aborted',"updatedAt"=NOW() WHERE "id"=$1 AND "status"='running'`, runId);
    return typeof n === "number" ? n > 0 : true;
  } catch {
    return false;
  }
}

/** Read a finalized (or orphaned) run from the durable FactoryBrainRun row. Used
 *  by the stream route when a reconnect's runId is no longer in the registry (the
 *  run finished + was evicted, OR the server restarted mid-run). Returns the saved
 *  transcript so the client can replay where it left off. */
export async function readBrainRun(
  id: string,
): Promise<{ status: string; goal: string; domain: string; transcript: BrainEvent[] } | null> {
  try {
    const pc = prisma as unknown as { factoryBrainRun?: { findUnique: (a: unknown) => Promise<{ status: string; goal: string; domain: string; transcript: string } | null> } };
    let row: { status: string; goal: string; domain: string; transcript: string } | null = null;
    if (pc.factoryBrainRun?.findUnique) {
      row = await pc.factoryBrainRun.findUnique({ where: { id }, select: { status: true, goal: true, domain: true, transcript: true } });
    } else {
      const rows = await prisma.$queryRawUnsafe<Array<{ status: string; goal: string; domain: string; transcript: string }>>(
        `SELECT "status","goal","domain","transcript" FROM "FactoryBrainRun" WHERE "id" = $1 LIMIT 1`, id,
      );
      row = rows[0] ?? null;
    }
    if (!row) return null;
    let transcript: BrainEvent[] = [];
    try { const p = JSON.parse(row.transcript); if (Array.isArray(p)) transcript = p as BrainEvent[]; } catch { /* keep [] */ }
    return { status: row.status, goal: row.goal, domain: row.domain, transcript };
  } catch {
    return null;
  }
}

async function writeReflectionRow(domain: string, kind: string, summary: string, rootCause: string | null, lesson: string): Promise<void> {
  const pc = prisma as unknown as { failureReflection?: { create: (args: unknown) => Promise<unknown> } };
  if (pc.failureReflection?.create) {
    await pc.failureReflection.create({ data: { domain, kind, summary, rootCause, lesson } });
    return;
  }
  const id = "fr_" + Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "FailureReflection" ("id","domain","kind","summary","rootCause","lesson","createdAt") VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
    id, domain, kind, summary, rootCause, lesson,
  );
}
