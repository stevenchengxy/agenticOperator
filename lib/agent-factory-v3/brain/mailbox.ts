// Human-in-the-loop mailbox (RANK-5 + P2-3 audit fix). The SSE stream is one-way
// (server→client); this is the return path: the inject API route pushes a human
// message, the conductor drains it at the next turn boundary as an authoritative
// user turn.
//
// P2-3 (audit MAJOR): the old in-process Map silently LOST messages under multi-worker
// / serverless — the inject route's process ≠ the stream's process. Now backed by
// Postgres (raw SQL so no Prisma migration / client-regen needed, same pattern as the
// reflection fallback) so any worker's drain sees any worker's inject. In-process Map
// is kept only as a fallback when the DB is unreachable (single-process dev still works).

import { prisma } from "@/server/db";

const TABLE = "factory_human_msg";
let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${TABLE} (id BIGSERIAL PRIMARY KEY, run_id TEXT NOT NULL, text TEXT NOT NULL, consumed BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ${TABLE}_run_idx ON ${TABLE} (run_id, consumed)`);
    })().catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

const memBoxes = new Map<string, string[]>(); // fallback only (DB unreachable)

/** Queue a human message for a run (called by the inject API route). */
export async function pushHumanMsg(runId: string, text: string): Promise<boolean> {
  if (!runId || !text.trim()) return false;
  const t = text.trim();
  try {
    await ensureTable();
    await prisma.$executeRawUnsafe(`INSERT INTO ${TABLE} (run_id, text) VALUES ($1, $2)`, runId, t);
    return true;
  } catch {
    const q = memBoxes.get(runId) ?? []; q.push(t); memBoxes.set(runId, q); return true;
  }
}

/** Take + mark-consumed all queued human messages for a run (conductor, each turn
 *  boundary). Merges DB + any in-process fallback. Returns [] if none. */
export async function drainHumanMsgs(runId: string | undefined): Promise<string[]> {
  if (!runId) return [];
  let dbMsgs: string[] = [];
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<Array<{ text: string }>>(`SELECT text FROM ${TABLE} WHERE run_id = $1 AND consumed = false ORDER BY id ASC`, runId);
    if (rows.length) {
      await prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET consumed = true WHERE run_id = $1 AND consumed = false`, runId);
      dbMsgs = rows.map((r) => r.text);
    }
  } catch { /* fall through to mem */ }
  const mem = memBoxes.get(runId) ?? [];
  if (mem.length) memBoxes.set(runId, []);
  return [...dbMsgs, ...mem];
}

/** Peek (NO consume): is a human message pending? For mid-long-tool cancellation —
 *  a long op (sandbox_run poll, sub-brain) checks this each tick and bails early so
 *  the message is drained at the next turn boundary instead of after the whole op. */
export async function hasPendingHumanMsg(runId: string | undefined): Promise<boolean> {
  if (!runId) return false;
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(`SELECT count(*) AS n FROM ${TABLE} WHERE run_id = $1 AND consumed = false`, runId);
    if (Number(rows[0]?.n ?? 0) > 0) return true;
  } catch { /* fall through */ }
  return (memBoxes.get(runId)?.length ?? 0) > 0;
}

/** Drop a run's mailbox when the run ends (conductor finally). */
export async function disposeMailbox(runId: string | undefined): Promise<void> {
  if (!runId) return;
  memBoxes.delete(runId);
  try { await ensureTable(); await prisma.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE run_id = $1`, runId); } catch { /* best-effort */ }
}
