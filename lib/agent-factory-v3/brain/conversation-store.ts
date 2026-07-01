// Conversation store — makes the factory a CHATBOT, not a one-shot pipeline. Each
// conversation keeps its message history + the brain's ctx (ontology, specs, plan,
// …) alive across user turns, so a follow-up CONTINUES the same reasoning instead
// of restarting read_ontology → plan → design from scratch.
//
// TWO layers:
//   1. in-memory Map (fast path, LRU-capped) — the hot cache.
//   2. DURABLE Postgres mirror (factory_conversation) — survives a server
//      restart/recompile. This is the BrainCheckpoint: when the dev server is
//      restarted by a crash, a redeploy, OR an HMR recompile (every backend edit
//      triggers one), the in-memory Map is wiped — so "继续" used to find nothing
//      and start over. Now the route/conductor rehydrate the ctx from Postgres and
//      genuinely resume. The brain ctx is JSON except emit/registry/signal
//      (functions) — those are stripped on save and reconstructed on load.

import type { ChatMsg } from "./stream-gateway";
import type { BrainCtx } from "./types";
import { prisma } from "@/server/db";

export interface ConversationState {
  messages: ChatMsg[];
  ctx: BrainCtx;
  updatedAt: number;
}

const conversations = new Map<string, ConversationState>();
const MAX_CONVERSATIONS = 40; // in-memory LRU cap (durable mirror keeps everything)
const TABLE = "factory_conversation";

// ── in-memory hot cache (sync — call sites + unit tests unchanged) ─────────────

export function getConversation(id: string): ConversationState | undefined {
  return id ? conversations.get(id) : undefined;
}

export function hasConversation(id: string): boolean {
  return !!id && conversations.has(id);
}

export function saveConversation(id: string, messages: ChatMsg[], ctx: BrainCtx): void {
  if (!id) return;
  conversations.delete(id); // re-insert to bump recency (Map preserves insertion order)
  conversations.set(id, { messages, ctx, updatedAt: Date.now() });
  while (conversations.size > MAX_CONVERSATIONS) {
    const oldest = conversations.keys().next().value;
    if (oldest === undefined) break;
    conversations.delete(oldest);
  }
}

export function disposeConversation(id: string): void {
  if (id) conversations.delete(id);
}

// ── durable Postgres mirror (async — survives server restart) ─────────────────

let ensured: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!ensured) {
    ensured = prisma
      .$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, domain TEXT, messages_json TEXT NOT NULL, ctx_json TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      )
      .then(() => undefined)
      .catch((e) => {
        ensured = null; // allow retry on a transient DB hiccup
        throw e;
      });
  }
  return ensured;
}

// The 3 ctx fields that aren't JSON-serializable. emit + signal are re-pointed by
// the conductor each turn; registry is reconstructed from domain + saved ontology.
function serializeCtx(ctx: BrainCtx): string {
  const clone = { ...(ctx as unknown as Record<string, unknown>) };
  delete clone.emit;
  delete clone.registry;
  delete clone.signal;
  return JSON.stringify(clone);
}

/** Mirror the conversation to Postgres so it survives a restart. Best-effort —
 *  a DB hiccup must never crash a run; the in-memory copy still works this session. */
export async function persistConversation(id: string, messages: ChatMsg[], ctx: BrainCtx): Promise<void> {
  if (!id) return;
  try {
    await ensureTable();
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${TABLE} (id, domain, messages_json, ctx_json, updated_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (id) DO UPDATE SET messages_json = EXCLUDED.messages_json, ctx_json = EXCLUDED.ctx_json, domain = EXCLUDED.domain, updated_at = now()`,
      id,
      ctx.domain,
      JSON.stringify(messages),
      serializeCtx(ctx),
    );
  } catch {
    /* best-effort durability */
  }
}

/** True if the conversation exists in memory OR in the durable mirror. The route
 *  uses this to decide resume-vs-fresh AFTER a restart wiped the in-memory cache. */
export async function hasConversationDurable(id: string): Promise<boolean> {
  if (!id) return false;
  if (conversations.has(id)) return true;
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM ${TABLE} WHERE id = $1 LIMIT 1`, id);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Rehydrate a conversation from Postgres into the in-memory cache (reconstructing
 *  the non-serializable registry from domain + saved ontology), so the conductor's
 *  sync getConversation then finds it and resumes. Returns the state, or undefined. */
export async function rehydrateConversation(id: string): Promise<ConversationState | undefined> {
  if (!id) return undefined;
  const mem = conversations.get(id);
  if (mem) return mem;
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<Array<{ messages_json: string; ctx_json: string }>>(
      `SELECT messages_json, ctx_json FROM ${TABLE} WHERE id = $1`,
      id,
    );
    if (!rows.length) return undefined;
    const messages = JSON.parse(rows[0].messages_json) as ChatMsg[];
    const ctx = JSON.parse(rows[0].ctx_json) as BrainCtx;
    ctx.emit = () => {}; // re-pointed by the conductor this turn
    ctx.signal = undefined;
    ctx.registry = null;
    // Reconstruct the tool registry (functions, can't serialize) from the saved
    // domain + ontology. If this fails, read_ontology rebuilds it lazily.
    try {
      const { resolveRegistry } = await import("@/lib/tools/resolve-registry");
      const { registerPersistedInto } = await import("@/lib/tools/persisted-tools");
      ctx.registry = resolveRegistry(ctx.domain, ctx.ontology ?? undefined);
      await registerPersistedInto(ctx.registry, ctx.domain).catch(() => {});
    } catch {
      /* lazy rebuild via read_ontology */
    }
    const state: ConversationState = { messages, ctx, updatedAt: Date.now() };
    saveConversation(id, messages, ctx); // warm the in-memory cache
    return state;
  } catch {
    return undefined;
  }
}
